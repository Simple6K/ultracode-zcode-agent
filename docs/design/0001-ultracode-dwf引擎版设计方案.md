# 设计方案 0001：/ultracode on ZCode——dwf 引擎版（v2.0）

> 产出日期：2026-11-07。
> **supersedes**：`docs/设计方案-ultracode-Agent引擎版.md`（v1.x，Agent 提示词编排路线）。
> 事实来源标注沿用旧文档约定：**【码】**= ZCode 源码一手证据（`/Users/lzk/Desktop/个人学习/zcode改造/ZCode`）；**【测】**= 本机官方客户端实测（ZCode.app 3.17.2）；**【ccb】**= claude-code 仓库证据（`/Users/lzk/Desktop/claude-code`）。
> 本方案的全部架构决策均经用户 2026-11-07 当面裁决（见 §1.3 决策记录）。

---

## 0. 结论摘要

v2.0 将 /ultracode 的编排主路径从「主模型提示词编排 Agent 子代理」整体切换到 **ZCode 原生自带的 dwf 动态工作流引擎**（CreateWorkflow 工具）：

- **形态收敛为纯知识注入**：1 个技能（SKILL.md，教模型现场写 dwf 脚本）+ 1 个薄斜杠命令。与 ccb /ultracode 的 knowledge-only 形态完全对齐（【ccb】`team-memory/_staging/20260703T110845-lizk172-ultracode-workflow-engine-internals.md`：skill 纯知识注入零运行时副作用，执行全在 Workflow 工具）。
- **编排、并发、记账、恢复全部交给引擎**，不自研任何运行时代码。dwf 为引擎驱动：模型写 TS 脚本一次成稿，独立进程自主推进，模型不参与中间轮（【码】`packages/dynamic-workflow/src/engine/engine.ts` 纯状态机；`packages/dynamic-workflow-runtime/src/harness.ts:1-45` 执行时序；驱动器 `bootstrap/src/app/workflow-driver.ts:112`）。
- **上下文卫生是承重结构而非规范**：子代理全文永不进入主模型上下文，回流面四道闸全部机制有界（§4）。
- **退役清单**：Agent 编排路径、`.ultracode/journal` 指纹协议、hook 账本对账规则。插件内两个 hook 保留为 v1.x 遗留兼容，不在主路径（§2.4）。

## 1. 背景与量化约束

### 1.1 重设计的触发：两轮源码调研

v1.x 定稿时的前提「ZCode 无编排引擎可用」在 2026-11-07 的调研中被推翻：

| 事实 | 证据 |
|---|---|
| dwf 是引擎驱动：脚本→静态分析→独立 node 子进程（vm cell）执行，NDJSON `__host.*` 协议回调引擎状态机 | 【码】`dynamic-workflow-runtime/src/harness.ts:1-45`、`cli/src/dwf-child-command.ts:11`、`protocol.ts` |
| 原生控制流：`agent()`/`.ask<T>()` 派子代理；`Promise.all`/`for`/`while`/`if`/`try-catch` 全部可用（脚本即普通 TS） | 【码】facade 注册表 `dynamic-workflow/src/facade/registry.ts` |
| 双层并发上限：run 级 `caps.maxConcurrency`（默认 `max(4, min(16, cores-2))`）+ 进程级自适应 governor | 【码】`engine/concurrency.ts:82,232`、`bootstrap/src/app/workflow-concurrency-governor.ts:72` |
| 引擎记账：SQLite journal 五表（`dwf_run/dwf_actor/dwf_node/dwf_event/dwf_artifact`），resume 按行重放 | 【码】`adapters/src/storage/session-store/migrations.ts:833-906` |
| 启动后自主推进：仅 escalation（子代理提问）与留白两条人工/模型回路；支持后台、resume、amend、stop | 【码】`bootstrap/src/app/workflow-driver.ts` |
| dwf 是官方一等公民：monorepo 内置包 + 官方 bundled skill（同样用"技能教写脚本"交付） | 【码】`bundled-skills/skills/dynamic-workflows` |
| 用户桌面 3.17.2 闸门已开（CreateWorkflow 可用） | 【测】2026-11-06 确认 |

同时排除了其余「主动发起平面」作为编排底座：cron 只能定时唤醒对话轮（【码】`core/src/tool/handlers/cron.ts`）；Stop hook 续跑上限 3 次（【码】`core/src/hooks/output.ts:30-45`）；SendMessage 仅点对点唤醒（【码】`core/src/tool/handlers/send-message.ts`）；MCP sampling 仅限 UI 扩展（【码】`bootstrap/src/zcode-protocol/mcp-ui/samplingProtocol.ts:35`）；插件无法注册 tool/engine（【码】`contracts/src/plugins/index.ts:98`）。

### 1.2 量化约束

| 项 | 值 | 来源 |
|---|---|---|
| 宿主 | ZCode.app 3.17.2 官方客户端，零源码 fork，仅插件五类组件平面 | 用户，不变 |
| 主模型上下文回流上限 | 终态通知整条 ≤ **120,000 字符** | 【码】`core/src/runtime-task/notification.ts:18` |
| 进行中通知上限 | escalation 的 question/context 各 ≤ **4,000 字符** | 【码】`dynamic-workflow-run-progress.ts`（`WORKFLOW_ESCALATION_TEXT_MAX_CHARS`） |
| 并发 | run 级默认 `max(4, min(16, cores-2))`，可显式配置 | 【码】`engine/concurrency.ts:82` |
| 使用场景 | 单用户桌面交互式编排；无 QPS/多租户诉求 | 用户 |
| typed ask 校验重试 | 引擎侧自动重试，第 3 次拒绝后 ValidationFailed（【码】`execution-engine.md:220-232`，REPAIR_ATTEMPTS=3） | 研究轮源码 |
| report/artifact 限额 | report 65,536 条/run、1 MiB/条、1 GiB/run（超限失败 run）；artifact 32 id/run、16 版/id、单文件 20 MiB、单 markdown 256 KB（【码】`report-caps.ts:20-40`、`artifact-caps.ts:21-49`） | 研究轮源码 |
| escalation | 每 ask 上限 3 次；按设计**无超时**（【码】`escalate.ts:136-140`、`workflow-driver-helpers.ts:84`） | 研究轮源码 |
| 运行期禁令 | `Date.now()`/`Math.random()`/无参 `new Date()` 运行期抛错（【码】`child-source.ts:282-302`） | 研究轮源码 |
| world 确定性面限额 | glob ≤2000 文件；grep ≤2000 条或 256 KB；diff ≤512 KB；world.run 默认超时 300s、输出 >16 MiB 拒绝（【码】`world-read-caps.ts:22-45`） | 研究轮源码 |

### 1.3 决策记录（用户裁决，2026-11-07）

| # | 决策 | 裁决 |
|---|---|---|
| D-1 | 编排主路径 | **单层纯 dwf**；Agent 编排路径从 SKILL.md 退役，不保留轻量层 |
| D-2 | 账本 | **零手写账**（参考 ccb：引擎 journal 为唯一账本，`resumeFromRunId` 式恢复）；指纹协议、hook 对账全部退役 |
| D-3 | 脚本产生方式 | **现场写 + 骨架内嵌**（ccb 模式）；模板制品库视 D-b 实测结果二期再议 |
| D-4 | hooks | 插件内保留 v1.x 两个 hook 不删（向后兼容），文档标注遗留；不扩展到 dwf 通道（其走 `workflow_child`，【码】`bootstrap/src/app/script-workflow-child-runtime.ts:150`，且引擎自带 governor） |
| D-5 | ADR | 不单独写；备选取舍记入本文档 §6 |

### 1.4 显式砍掉的语义

- **budget 驱动扩缩**：用户实际用法为无限预算（2026-11-05 裁决，维持）。
- **Agent 轻量层**：2-3 个派发的小任务也要过 dwf 确认窗——单层原则的代价，接受。
- **手写 journal / 指纹协议 / 对账**：引擎记账后为纯负担，整体删除。
- **嵌套工作流**：机制限制不变，以「主模型跨轮接力多个 run」替代（§3 契约 C4）。
- **向旧路径降级**：闸门关闭时显式报错退出，不降级到 Agent 编排（单层原则；降级路径等于复活全部 v1.x 复杂度）。

## 2. 领域模型与不变量

### 2.1 术语表

| 术语 | 定义 |
|---|---|
| dwf run | 一次 CreateWorkflow 启动的工作流执行，以 runId 为唯一标识 |
| facade 原语 | dwf 脚本内可用的注入 API（`agent()`、`report()` 等，词汇表封闭，【码】`facade/registry.ts`） |
| 汇报契约 | 脚本顶层 return 值的结构约定（§3 契约 C3） |
| 跨轮组合 | 主模型依据上一 run 的 return 值发起下一 run，替代嵌套 |
| 闸门 | CreateWorkflow 工具在客户端的可用性（可被配置关闭） |

### 2.2 模块与职责（一句话）

| 模块 | 职责 | 自研/原生 |
|---|---|---|
| SKILL.md | 注入编排知识：何时起 run、怎么写脚本、汇报契约、跨轮与恢复 | 自研（知识） |
| commands/ultracode.md | 触发入口，加载技能 | 自研（薄） |
| dwf 引擎 | 脚本执行、子代理派发、并发、journal、resume | **原生** |
| hooks ×2（遗留） | v1.x Agent 通道的并发闸门与账本 | 自研（遗留） |

### 2.3 不变量

1. **上下文有界**：主模型只能通过 §4 的四道闸接收 run 数据；任何设计不得新增无界回流通道。
2. **runId 是恢复唯一键**：不存在第二本手写账；跨会话恢复 = ListWorkflowRuns 找 runId + 原生 resume。
3. **执行期不可介入**：脚本一旦运行，调度归引擎；模型仅在 escalation/留白两条显式回路出现（【码】`workflow-driver.ts`）。
4. **单通道原则**：一切编排经 dwf；无降级路径（§1.4）。

### 2.4 模型分类

本方案四类模型（协议/领域/持久化/视图）全部原生承担：脚本即协议（facade 词汇表）、journal 五表即持久化（引擎写）、GetWorkflowRun 快照即视图（引擎产出）。**自研部分不含任何模型定义，无跨模型泄漏面**——这是 v2.0 相对 v1.x 的结构性简化（v1.x 有指纹格式、journal 行格式、账本格式三个自研持久化模型）。

## 3. 模块边界与接口契约

```
用户 → /ultracode → 主模型（载入 SKILL.md）
                        │ C1 闸门探测
                        ▼
                  CreateWorkflow（脚本）
                        │
                        ▼
        dwf 引擎（独立进程）──→ workflow_child 子代理 ×N
                        │ journal（SQLite 五表，引擎写）
                        ▼
        回流四道闸（§4）→ 主模型 → 用户
```

| 契约 | 内容 | 失败语义 |
|---|---|---|
| C1 前置（技能门+闸门） | ① 先加载官方 `dynamic-workflows` 技能——CreateWorkflow 提交 script/path 前要求该技能已加载，否则业务码 428 拒绝（【码】`docs/dynamic-workflow/authoring.md:37-62`）；② 确认 CreateWorkflow 可见 | 任一不满足 → 向用户显式报错，**不降级、不重试** |
| C2 脚本范式 | 现场 TS + 内嵌骨架（map-reduce 扫描 / 评审-修复循环 / 多路对抗验证 / 并行 worktree 写入）；关键契约：`ask` 失败是 `WorkflowError` throw（非 null）、结构化输出走 `ask<T>` 类型参数、脚本内无并发原语（确认窗调）、`world` 确定性面优先于派代理；`report()` 优先于大 return | 违反 → run errored（编译诊断带 文件:行号，指向 `.zcode/workflow-drafts/` 草稿），模型 Edit 草稿 + `path` 通道发新 run |
| C3 汇报契约（承重） | return `{结论, 已完成[], 失败[], 产物[], 需人工介入[]}`，保持小结构；全文走 `report()`/`artifact.*`（终态通知对二者只带 count+preview，【码】`notification.ts:26-44`） | return 过大 → 引擎 120k 硬截断（兜底），教学纪律防患（第一道防线） |
| C4 跨轮组合 | 主模型按 C3 return 值决定是否发起下一 run。**D-d 已从源码关闭**：嵌套双重禁止——core 层结构性移除（【码】`core/src/runtime/helpers/tool-allowlist.ts:30-41`）+ driver 侧刻意双列（【码】`bootstrap/src/app/workflow-actor-tools.ts:44-46`），子代理无 CreateWorkflow | — |
| C5 恢复 | `ListWorkflowRuns` → `GetWorkflowRun`（状态 + `scriptPath`）→ 分流：**stopped/中断** → `ResumeWorkflowRun`（重放 journal 里字节同一的脚本与存档实参，不接受改脚本/换实参，【码】`dynamic-workflow-run-submit.ts:468-480,555-562`）；**errored 不可 resume**（重放会同样失败）→ 改草稿发新 run；**改脚本续跑** → `AmendWorkflow` + `path`（具名子代理已结算工作经导入缓存零 token 沿用） | 用户停止的 run（stopReason=user）→ 引擎指引「不要自行恢复」（【码】`notification.ts:53-59`） |

## 4. 数据流与失效协议

### 4.1 写路径与读路径

**写**：主模型生成脚本 → 内联脚本先落**可编辑工作副本**到 `.zcode/workflow-drafts/`（机器自有、自带 .gitignore；编译诊断指向它，Edit + `path` 通道即改稿重提）→ harness 另落**执行归档** `<cwd>/.zcode/workflow-runs/<runId>.mjs`（【码】`workflow-drafts.ts:1-16`、`harness.ts`、`dwf-child-command.ts:1-17`）→ 引擎逐事件写 journal 五表 → 子代理输出全文只落 journal。
**读**：主模型经四道闸消费；用户经 hub 页/report/artifact 消费。

### 4.2 回流四道闸（上下文卫生的结构保证）

| # | 层 | 载体 | 界 | 证据 |
|---|---|---|---|---|
| 1 | 脚本变量层 | `agent()` 返回值 → 脚本变量（子进程内存） | 全文永不接触主模型上下文 | 【码】`harness.ts`（子进程执行模型） |
| 2 | 进行中通知层 | 父会话进度事件 | 仅 escalation（≤4000 字符）/ stall / 留白三类，无子代理全文事件 | 【码】`core/src/runtime/methods/dynamic-workflow-run-progress.ts` |
| 3 | 查询层 | GetWorkflowRun | 情势快照：状态/token/节点计数/actor 名册/log 尾部/确定性摘要 | 【码】`core/src/tool/handlers/get-workflow-run-summary.ts`（形状由 `tests/get-workflow-run-summary.test.ts` 钉死） |
| 4 | 终态通知层 | 完成通知 | `result`（脚本 return，唯一自控全文位）+ `reports`/`artifacts` 一律 `{count, preview, shown}` 预览制；整条 ≤120k | 【码】`core/src/runtime-task/notification.ts:18,15-60` |

**这是 v2.0 的核心收益论证**：v1.x 中 N 个子代理的全文必然全部涌入主模型上下文（Agent 工具返回值语义），是长编排触发压缩的根因；dwf 将约减点从「模型自觉」移到「机制」。

### 4.3 失效协议

- **真值与失效**：journal 是唯一真值，追加写、按行重放；本方案无自建缓存，因此无自建失效条件（v1.x 的「指纹重算→journal 失配→按缺失重派」协议整体删除）。
- **知识层时效**：**裁决（2026-11-07）——不自维护 API 表**。手册不内嵌 facade 参考，指回官方 `dynamic-workflows` 技能（其 §16.2 逐字内嵌 FACADE_DTS 并随客户端更新，【码】`authoring.md:735-760`），消除双源过期。会过期的残余仅剩：手册骨架代码中的 facade 用法与量化数字——失效信号为闸门探测失败或脚本原语报错，触发重校准（见 §7 S1）。
- **并发拓扑**：run 内引擎侧排队（governor，MPSC 语义）；run ↔ 主模型经有界通知通道（120k）；主模型与子代理无直接共享状态。

### 4.4 `report()` 与交付指引

- 脚本用 `report(item)` 渐进发布用户面产物，终态通知只带 count+preview（【码】`notification.ts:26-31`）——SKILL.md 范式表必须教它替代大 return。
- 终态通知自带交付物呈现指引：引擎直接指示主模型按「结论 → 证据 → 确定性验证/独立子代理确认情况 → 未覆盖范围」汇报（【码】`notification.ts:265`）。C3 契约与该官方指引对齐，不另造汇报纪律。

## 5. 失败路径表

| 故障 | 检测信号 | 行为 | 恢复 | 回滚 |
|---|---|---|---|---|
| 闸门关闭 | CreateWorkflow 不可见 | C1 报错退出 | 用户开启设置后重试 | 无需（无副作用） |
| 脚本违反 facade/契约 | run errored | 模型读错误，改脚本发新 run | 旧 run 留 journal 可审计 | 新旧 run 天然隔离（runId） |
| 子代理失败 | 引擎 run 事件（ask 以 WorkflowError 拒绝，非 null） | 逐项 try/catch，失败项计入失败清单或需人工介入，**不静默丢弃**（与手册铁律 5 对齐；审计类宁可保守标记） | 原生 resume 重跑失败调用 | — |
| run 停滞 | stall 通知（有界） | 模型判断 escalate / 等待 / stop | resume（journal 重放保证已完成调用幂等不重跑） | TaskStop 可停（【码】`notification.ts:53-59` stopReason） |
| return 过大 | 通知被 120k 截断 | 引擎兜底截断；教学纪律为第一道防线 | — | — |
| 会话中断 | 用户重新进入 | ListWorkflowRuns 找 runId → 原生 resume | 同上 | — |
| 用户主动停止 | stopReason=user | 引擎指引「不要自行恢复」 | 用户显式要求才 resume | — |

无自建队列、无自建重试：v2.0 的队列与重试语义全部为引擎原生属性，本方案不在其上叠加无界重试或吞错逻辑。

## 6. 备选方案与取舍（含下游代价清单）

| 方案 | 收益 | 下游代价 | 裁决 |
|---|---|---|---|
| **A. 单层纯 dwf（本方案）** | 引擎级确定性；知识层最薄（删记账/并发/恢复三套教学）；上下文卫生机制化 | ① 强耦合 facade 版本，ZCode 升级可破坏 playbook（需重校准）；② 闸门可被配置关闭且无降级；③ 小任务也过确认窗；④ dwf 无 budget | 用户选定 |
| B. 双层（dwf 重编排 + Agent 轻量层） | 小任务免确认窗 | 双路径双套纪律长期维护；hooks 账本协议不能退役；SKILL.md 永久两倍厚 | 用户否决（要单层） |
| C. v1.x + hooks 持续硬化（含 DAG 计划校验器） | 不依赖 dwf 闸门 | 提示词编排的根本缺陷（上下文全文回归、调度靠注意力）无法机制化解决；硬化每前进一步都要新代码 | 调研后否决（引擎存在，硬撑无理） |
| D. 外部驱动（headless CLI 守护进程） | 完全自主编排 | 体验黑盒；子代理无编排会话上下文；认证依赖持久化默认模型（【码】`provider-node/src/model-selection-config-repository.ts:19`） | 否决（Route B 马甲） |
| 脚本产生：模板制品库 | 免生成、质量稳 | 模板库+playbook 双份维护；facade 签名一变模板即挂；D-b 未测前有赌的成分 | 一期不用；二期视 D-b |

## 7. 垂直切片计划

| 切片 | 内容 | 验证方式 | 回滚 |
|---|---|---|---|
| S1 | D 系列实测（**源码研究已完成大半，剩余项**）：D-a facade 桌面签名与 `files/git/world` 命名空间归属；D-b saved workflow 按名引用/传参（源码已证实机制：`.zcode/workflows/` 项目档 + `~/.zcode/workflows/` 全局档 + frontmatter args，【码】`contracts/src/tools/saved-workflow.ts:16-31`，桌面验证 3.17.2 行为）；D-c ~~子代理工具面~~ **源码已证实**：actor 保留 Bash/Write/Edit/搜索/web（【码】`workflow-actor-tools.ts:32-53`），**无原生 worktree 隔离**（dwf facade 无 isolation、legacy 路径显式抛 not-implemented、actor 与主会话共享 workingDirectory，【码】`script-workflow-runtime.ts:347-349`、`script-workflow-child-runtime.ts:155`）——硬需求改为骨架 D 模式（actor 经 Bash 自建 worktree + 主代理合并），桌面验证该模式可跑通；D-d ~~嵌套~~ **源码已关闭**（双重禁止，见 C4）；D-e 确认窗体验成本（源码已证实机制：alwaysAsk + 会话级"始终允许" + Refine，【码】`create-workflow.ts:430-441`）；D-f 新增：3.17.2 上技能门 428 的实际行为、`files.read` 尺寸上限 | 每项有桌面操作步骤与判定标准；结果回写本节 | 纯只读实测，无回滚需求 |
| S2 | SKILL.md v2 重写（门控→技能门前置→路由→范式铁律→四骨架→汇报契约→运行中回路→恢复→跨轮→质量纪律→遗留说明）；command 更新 | 桌面新会话加载验证章节完整 | git 版本化 |
| S3 | 桌面验收 U' 系列：并行 worktree 写文件、评审-修复循环收敛（≤3 轮）、中断后 resume 不重跑、汇报契约形状、闸门关闭报错 | 会话证据 + journal 五表核对 | — |
| S4 | 插件 v2.0.0 发版：版本 bump、README、旧文档 supersede、提交推送 | 从 git 重装验证 | 版本回退 |

## 8. 已知限制与遗留

### 桌面校准记录（2026-11-07，ZCode.app 3.17.2，进行中）

| 项 | 结果 |
|---|---|
| D-a facade 签名 | **PASS**：`await files.glob` 全局命名空间、`agent().ask<T>`+interface/JSDoc、逐项 try/catch、`report()` 单参数、汇报契约五字段 return——手册骨架 A 在 3.17.2 逐字成立（草稿与 `dwf_run.result_json` 取证）；run completed、5/5 节点完成、默认并发 8 |
| D-b 存档工作流 | **机制可用**：模型两次将"创建工作流"理解为 SaveWorkflow（参数化 args、作用域选择、权限弹窗齐全）；**用户裁决：一次性编排不存档**，与 ccb ultracode 用法一致（现场内联脚本 + 引擎自动归档，存档仅为用户显式要求的复用资产）。手册 §3 已补路由条款 |
| D-c / U'1 worktree 硬需求 | **PASS**（2026-11-07 实测，run `dwfrun-b1c74ce5`）：骨架 D 全链路——3 actor 并行建树（骨架模式，非引擎原语）、每文件单写者、隔离提交、`div` 样本未被误碰、run 内确定性核对（git log/diff）、合并征询（AskUserQuestion）、**部分合并路径**（只合并 calc + 清理其 worktree/分支，另两套原样保留）、主代理按「结论→证据→确定性核对/仅判断→未覆盖」汇报。12/12 节点 completed |
| U'5 闸门关闭报错 | **BLOCKED（机制查明，不可复现）**：闸门是服务端灰度 key（`/api/v1/client/configs` 的 `dynamicWorkflow.mode`），生效优先级 = 用户已存选择（sticky，桌面私有存储）＞ 本地环境变量 `ZCODE_DYNAMIC_WORKFLOW_MODE` ＞ 服务端 key ＞ 默认 disabled。实测：注入 env=disabled + 重启后 CreateWorkflow 仍可用（用户选择压过覆盖），关闭态在已激活账号上无法复现。**风险照录**：若 Z.ai 服务端关闭灰度，手册 §2 报错路径生效（提示层行为，简单可信）；单通道原则的实际风险是"服务端可关"，非用户可关 |
| U'3 中断恢复 | **PASS**（run `dwfrun-8c0ddd4d` 全库扫描，事件级取证）：16:55:58 关窗中断，引擎将 34 个在途 ask 同秒 settle 为 cancelled；16:57:51 同 runId 恢复——已完成节点（glob）无 dispatch 直接 settled（journal 瞬时重放、零重算），34 个未完成子代理全部重派；17:04:40 完成 34/34、0 失败、五字段契约。**已完成的绝不重跑、未完成的不漏不重**——与 ccb resumeFromRunId 同级语义，引擎原生 |
| U'2 评审-修复循环 | **PASS**（run `math.ts 评审修复`）：2 轮收敛（≤3）；`div` 除零靶子被报出并修复（RangeError）；return 五字段契约；诚实披露"无测试/构建，验证为逐轮独立评审非机器检查"。**观察项**：修复落工作区未自动提交——符合 actor 共享工作目录机制，手册骨架 B 已补说明（run 后呈现 diff、提交由用户裁决） |
| D-f1 技能门 | **降级为兜底**：3.17.2 上模型会在 CreateWorkflow 前自发加载官方 dynamic-workflows 技能（工具描述引导），428 门从未实际触发；手册 §2 第 1 条保留作兜底 |
| 附带观察 | 模型自发使用 `EvalWorkflowSnippet` 做确定性摸底、扇出内主动论证计算名唯一性（9006 规则）——手册教学与模型自发行为对齐良好 |

### 固有限制

- **worktree 硬需求以模式满足，非引擎原语**：dwf 无工作区隔离，并行写依赖骨架 D（actor Bash 自建 worktree + 主代理裁决合并）；文件系统层冲突防护仅为"每文件单写者"约定 + 权限模式。这是 v2.0 相对 v1.x（Agent 路径同样无原生隔离，同为模式解决）的持平项，非倒退。
- **facade 版本差**：源码仓库新于 3.17.2，API 表以 S1 实测为准，不照抄源码。
- **确认窗成本未量化**（D-e）；若严重，向 Z.ai 反馈而非绕过。
- **官方插件市场上架**仍需联系 Z.ai（无公开 PR 通道），与本方案正交。
- **v1.x 遗留**：插件两个 hook 保留但退出主路径；其桌面验证（H1 账本 / H2 硬闸）降级为遗留项，不再阻塞 v2.0。

## 附：证据索引

| 主题 | 文件:行号 |
|---|---|
| 引擎执行模型 | `dynamic-workflow/src/engine/engine.ts`；`dynamic-workflow-runtime/src/harness.ts:1-45`；`cli/src/dwf-child-command.ts:11`；`bootstrap/src/app/workflow-driver.ts:112` |
| facade/原语 | `dynamic-workflow/src/facade/registry.ts` |
| 并发 | `engine/concurrency.ts:82,232`；`bootstrap/src/app/workflow-concurrency-governor.ts:72` |
| journal | `adapters/src/storage/session-store/migrations.ts:833-906` |
| workflow_child 会话类型 | `bootstrap/src/app/script-workflow-child-runtime.ts:150`；`workflow-facade.ts:297` |
| 回流四道闸 | `core/src/runtime/methods/dynamic-workflow-run-progress.ts`；`core/src/tool/handlers/get-workflow-run-summary.ts`；`core/src/runtime-task/notification.ts:18,15-60,265` |
| facade 契约真源（研究轮） | `dynamic-workflow/src/facade/dts.ts`（+`dts-model.ts`/`dts-hole.ts`）；`src/compiler/compile.ts:31-75`；`docs/dynamic-workflow/authoring.md`、`execution-engine.md` |
| 子代理能力边界（研究轮） | `core/src/runtime/helpers/tool-allowlist.ts:30-54`；`bootstrap/src/app/workflow-actor-tools.ts:32-53`；`script-workflow-child-runtime.ts:149-155`；`script-workflow-runtime.ts:347-349`（worktree not-implemented） |
| resume/amend 语义（研究轮） | `bootstrap/src/app/dynamic-workflow-run-submit.ts:427-587,555-562`；`engine/engine.ts:299`；`engine/imported-cache.ts:31-61` |
| 技能门与确认窗（研究轮） | `docs/dynamic-workflow/authoring.md:37-62`（428）；`core/src/tool/handlers/create-workflow.ts:341-441`；`launch.md:792-853` |
| saved workflow（研究轮） | `contracts/src/tools/saved-workflow.ts:16-146`；`core/src/tool/handlers/saved-workflows/store.ts:56-179`；`core/src/tool/handlers/create-workflow-source.ts:42-61` |
| 其余主动平面 | `core/src/tool/handlers/cron.ts`；`core/src/hooks/output.ts:30-45`；`core/src/tool/handlers/send-message.ts`；`bootstrap/src/zcode-protocol/mcp-ui/samplingProtocol.ts:35`；`contracts/src/plugins/index.ts:98` |
| ccb 对照 | `/Users/lzk/Desktop/claude-code/.claude/team-memory/_staging/20260703T110845-lizk172-ultracode-workflow-engine-internals.md`；`.claude/workflow-runs/*/{journal.jsonl,script.js,state.json}` |
