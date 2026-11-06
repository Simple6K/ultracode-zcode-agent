# 设计方案：/ultracode 移植到 ZCode 官方客户端（Agent 引擎版）

> 产出日期：2026-11-05。
> 本方案是本轮架构讨论的最终定稿，取代此前的源码 fork 路线（见附录 C 决策时间线）。
> 事实来源分三类，文中逐条标注：
> - **【码】**= ZCode 源码仓库一手证据（`/Users/lzk/Desktop/个人学习/zcode改造/ZCode`，v3.17.2，与官方客户端同版本）；
> - **【测】**= 本机官方客户端实测（ZCode.app 3.17.2，桌面端 + 内嵌 CLI 0.17.1，会话证据存于 `~/.zcode/cli/db/db.sqlite`）；
> - **【ccb】**= claude-code 仓库证据（`/Users/lzk/Desktop/claude-code`）。

---

## 0. 结论摘要

在 ZCode **官方客户端**（不自建 fork、零宿主改动）上实现 /ultracode：

- **形态**：1 个知识型技能 + 1 个薄斜杠命令 + 1 条 journal 目录约定（+ 可选插件封装用于分发），全部为声明性文件，与 ccb /ultracode 的 knowledge-only 形态同构。
- **引擎**：官方客户端默认可见的 **Agent 子代理工具族**（Agent / TaskOutput / TaskStop / SendMessage）+ Bash（worktree）。不引入任何自研引擎代码。
- **dwf 定位**：不是本方案主体，手册内保留一节路由指引——大型只读审计场景建议走 CreateWorkflow（灰度门本机已开），享用其类型校验与 resume；本方案主体覆盖 dwf 给不了的 worktree 并行写。
- **两项 dwf 长处的嫁接**：结构化输出以提示词强制 + 编排者校验重派实现（与 ccb 生产现状同级）；resume 以 `run_in_background` 的 outputFile 机制 + 任务日志纪律实现（任务粒度增量补跑，拿到"不重付已完成子代理"的经济效果）。

## 1. 目标与约束

| 项 | 内容 | 来源 |
|---|---|---|
| 目标 | 在官方客户端上获得与 ccb /ultracode 对等的多代理编排体验：知识手册注入 + 编排引擎 | 用户 |
| 载体约束 | Z.ai 官方客户端（ZCode.app 3.17.2），源码仓库仅作行为参考；**一切改源码手段不可用** | 用户，2026-11-05 |
| 硬需求 | worktree 并行改文件（实测 A+D 满足） | 用户 |
| 降级需求 | 子工作流嵌套 → 降级为"主循环多回合组合"（Agent 与 dwf 两引擎均机制级禁止，实测确认） | 实测 T2 + 用户知情 |
| 明确不做 | budget 驱动扩缩（用户实际用法为无限预算）；外部 MCP 引擎路线（B 方案，用户裁决放弃） | 用户 |
| 流程约定 | 先架构设计（用户裁决）后执行；本方案即架构定稿 | 用户 |

## 2. 事实基础（方案赖以成立的一手证据）

### 2.1 官方客户端能力面

1. **官方客户端 = 源码仓库构建**：`/Applications/ZCode.app` 3.17.2，内嵌 agent runtime 即 `apps/zcode-cli`（0.17.1）打包（`Resources/glm/zcode.cjs`）【测】。源码默认值即客户端行为。
2. **旧 Workflow 工具已死**：`core/src/tool/handlers/index.ts:75,152` 将 `workflowToolEntry` 注释出内置工具注册表，**任何配置下不可用**【码，亲手核实】。此前的"删除旧工具"决策失去对象。
3. **dwf（CreateWorkflow 十一工具族）灰度门本机已开**：桌面端 `/workflow` 会话实跑记录存在（`model-io-sess_dwf-dwfrun-*` 系列，2026-11-05）【测】。CLI 独立跑默认 disabled（`--help` 明示），桌面端由服务端 `/client/configs` 推送开启。
4. **默认会话可见的编排工具**：Agent、TaskOutput、TaskStop、SendMessage、Skill——子代理派发、后台任务、技能加载开箱可用【码+测】。
5. **MCP 不支持标准 sampling**：全仓无 `createMessage` handler，外部 MCP 服务器无法经标准 MCP 协议回调客户端跑 LLM——外部引擎路线（B）的技术死因【码】。（核查补充：仓内存在非标准的 "MCP Apps sampling" 旁路，`core/src/runtime/methods/sample-model.ts`，走 mcp-apps 应用邮箱协议，非通用 MCP 能力，不改变本结论。）
6. **headless `-p` 的鉴权死路**：独立运行 `zcode.cjs -p` 时账户 provider 静默失败（"Select a model"，桌面端正常）——自动化测试通道不可用，测试须走桌面端【测】。headless 对 CreateWorkflow/AmendWorkflow 有审批旁路（`cli/src/headless-workflow.ts`），其余审批面走 deny【码】。

### 2.2 Agent 工具契约（引擎的精确能力边界）

`contracts/src/tools/agent.ts`【码】：

- 输入仅 `{description, prompt, subagent_type?, run_in_background?}`。**无 schema 参数**（机制级结构化输出不存在）；**无 per-call model**（官方刻意移除，注释在 25-26 行：防历史 tool call 覆盖当前配置——子代理模型由 Settings/Markdown profile 统一决定）。
- `run_in_background: true` → 返回 `{status: "async_launched", outputFile, canReadOutputFile: true}`——**每个后台子代理的产出被运行时持久化到文件**，这是嫁接 resume 的机制支点。
- 子代理工具面（T2 实测）：有 Bash/Read/Write/Edit/Skill/TaskOutput/TaskStop/WebFetch；**无 Agent/Task 派发工具**（嵌套机制禁止的实证）；子代理可加载技能。

### 2.3 免构建扩展面（官方客户端直接生效）

| 面 | 位置 | 验证 |
|---|---|---|
| 技能 | `~/.zcode/skills/<name>/SKILL.md`（用户级）/ `<repo>/.zcode/skills/`（项目级） | 官方 CLI `skills list` 识别【测】 |
| 斜杠命令 | `~/.zcode/commands/<name>.md` / `<repo>/.zcode/commands/`，frontmatter 支持 `skills:`/`argument-hint`/`$ARGUMENTS` | 官方 CLI `commands list` 识别【测】 |
| 插件 | `.zcode-plugin/plugin.json`，组件类型 `agent|command|skill|hook|mcp`（**不含 tool**） | 【码】contracts/src/plugins/index.ts:98 |
| 配置 | `config.json`（permission / mcp.servers / hooks） | 【码】 |
| 命名工作流 | `.zcode/workflows/<name>.dwf.ts`（dwf 路线用，依赖灰度门） | 【码】 |

**实现细节陷阱**（实测发现）：命令 frontmatter 的 `skills:` 字段必须**内联写法**（`skills: ultracode`）；YAML 列表写法（`skills:\n  - ultracode`）会**静默解析为空**——分发资产时必须用内联写法。

### 2.4 实测记录（2026-11-05，测试床 `/Users/lzk/Desktop/个人学习/zcode改造/ultracode-lab`）

| 测试 | 场景 | 结果 | 关键证据 |
|---|---|---|---|
| T1 并行派发 | 2 独立写文件任务 | ✅ | 两个 Agent 调用间隔 **17ms**（同回合并行）；编排者未亲自写文件；交付物精确（sess_e38847ed） |
| T2 两层嵌套 | 子代理再派子代理 | ❌ 机制禁止 | 子代理逐一核对工具清单后如实报告无派发工具，按手册容错规则回退自完成（sess_30a21751 → sess_subagent_agent_08882a57） |
| T3 worktree 并行写 | 2 worktree 各写一文件 | ✅ 全链路 | 主会话 Bash 建树（wt/agentA、wt/agentB）→ 同秒并行派发 → 零互相污染 → `git add -N` 汇总 diff 并给出合并选项（sess_127a2175） |

附带观察：GLM-5.3 对手册的遵循度良好——分相叙述、交付物自核验、容错回退均执行到位，证明提示词纪律在该模型上有可用的地基。

## 3. 能力对照与路线裁决

### 3.1 三条候选路线的终局

| 路线 | 裁决 | 一句话理由 |
|---|---|---|
| A+D：手册 + Agent 引擎（+插件分发） | **采用（主体）** | 唯一满足 worktree 硬需求（实测通过）；纯 Markdown 资产；升级零冲突 |
| C：手册改写对齐 dwf | 降级为手册内一节路由指引 | worktree 无对等物；大只读审计场景让给 dwf（其类型校验/resume 恰在该场景价值最大） |
| B：外部 MCP 服务器托管 ccb 引擎 | 放弃（用户裁决） | MCP 无 sampling 被证伪；headless 派发带两处未实测硬风险；复杂度最高 |

### 3.2 与 ccb /ultracode 的能力对照（定稿版）

| ccb 能力 | 本方案对应物 | 保证级别变化 |
|---|---|---|
| knowledge-only 手册注入 | SKILL.md + 命令（`skills:` 自动挂载 + `$ARGUMENTS`） | 同级 |
| `agent(prompt, {schema})` 结构化输出 | 提示词强制 JSON + 编排者字段校验 + 不合格重派 | **机制→纪律**；但 ccb 生产现状同为 prompt-forced（claudeCodeBackend.ts:262-285，工具调用层强制曾致 8/12 子代理死亡后回退）——实际同级【ccb】 |
| `parallel()`/`pipeline()` | 同回合多 Agent 调用（实测 17ms 并行）；依赖串行回合 | 同级（无 barrier 语义差） |
| `isolation:'worktree'` | Bash 建树 + 每子代理绑 worktree 路径（T3 实测） | **实测同级**（合并由编排者人工驱动，非引擎自动） |
| `workflow()` 子工作流嵌套 | 多回合组合：每回合一次编排、主代理留在回合间读结果定下一步 | 机制→协议；ccb 手册本就推荐多相任务如此拆 |
| `budget` 硬顶 | 不做（用户裁决：无限预算手法） | 显式放弃（ccb 生产亦恒 null【ccb】） |
| journal/resume 前缀缓存 | ① `run_in_background` 的 outputFile（机制持久化）② 任务日志 `.ultracode/journal-*.jsonl`（纪律：逐批落盘、重开先读日志只派缺失项） | 机制+纪律混合；拿到"不重付已完成子代理"经济效果，拿不到字节级缓存导入 |
| 并发默认 3/上限 16/1000 总数 | 提示层纪律：默认并行 ≤5、大扇出（>12 子代理）先报价 | 机制→纪律（官方客户端不可改引擎默认值） |
| 七类质量模式 | 手册全量改写为 Agent 引擎惯用法（对抗验证=独立复核者多数票；评审团；loop-until-dry=轮上限+干涸检查；多镜头；完整性批评家；无静默截断=显式报告丢弃项） | 同级（提示层） |
| `/workflows` 进度面板 | 后台任务通知 + TaskOutput + journal 文件 | 降级（可观测性弱于面板） |

## 4. 架构设计

### 4.1 资产清单

```
~/.zcode/                          ← 用户级（跨项目生效）
├── skills/ultracode/SKILL.md     ← 核心：编排手册（正文见 4.3）
└── commands/ultracode.md         ← 入口：薄命令（frontmatter: skills: ultracode + $ARGUMENTS）

<repo>/.ultracode/                ← 工作目录级（运行时由编排者创建）
└── journal-<任务指纹前 8 位>.jsonl ← 任务日志（resume 纪律的载体，协议见 4.4.2）
```

**暂缓项**：`.zcode-plugin` 插件封装（技能+命令打包分发）——团队分发的真实用例出现前不做（抽象延迟纪律）；届时成本仅一份 plugin.json 清单。

命令文件全文（内联 `skills:` 写法——列表写法会静默失效，见 2.3）：

```markdown
---
description: 多代理编排模式：加载 ultracode 手册，把本次任务作为编排对象（opt-in 通道）
argument-hint: "要编排的任务"
skills: ultracode
---
用户通过 /ultracode 显式进入多代理编排模式。先加载 ultracode 技能（若本会话尚未加载），
再按手册以编排者身份处理本次请求：

## User input

$ARGUMENTS

若上文为空：向用户确认要编排的任务，并给出一个默认建议。
```

### 4.2 数据流

```
用户敲 /ultracode <任务>
  → 命令展开：skills 自动挂载 ultracode 手册 + $ARGUMENTS 注入任务
  → 模型按手册：门控确认 → 任务分解 → （读场景）直接同回合并行 Agent 派发
                            → （写场景）Bash 建 worktree → 并行派发（每代理绑树）
  → 收集：逐个校验结构化输出（不合格重派）→ 逐批追加 journal
  → 汇总：去重、呈现、（写场景）diff 汇总 + 合并选项征询
  → 多回合组合：读结果定下一回合（嵌套降级协议）
  → 中断恢复：新回合先读 journal / outputFile，只派缺失项
```

### 4.3 手册（SKILL.md）章节设计

frontmatter：`name: ultracode`；`description` 前 250 字符写足触发词（ultracode、多代理、编排、并行、对抗复核、审计）——模型靠描述触发，无关键词匹配器。

正文章节（每节列关键规则句，行为契约，改措辞须重跑验收）：

1. **前提与分工**：本手册只管"何时编排、编排多大、质量模式、迭代纪律"；工具语法以官方工具契约为准。
2. **门控（opt-in）**：仅当用户敲 /ultracode、消息含 ultracode、或原话要求多代理编排时进入；否则用单个 Agent 或自己做，可一句话报价并告知跳过话术。会话级常开 = 用户宣布"本会话 ultracode 开启"（口头 standing opt-in，压缩后不确定就问一次）。
3. **任务分解**：拆 2–6 个独立子任务；子代理提示词自包含（工作目录/目标/交付格式/约束）；有依赖的串行。
4. **并行纪律**：独立子任务同一回合并行派发（多个 Agent 调用一次发出）；默认并行 ≤5（**初始默认，待验收第 11 条高扇出实测校准**）；>12 子代理先报价再启动（同待校准）；每代理只碰自己的文件/目录。
5. **worktree 规范（写场景）**：并行改文件必须先 `git worktree add ../<项目>-wt-<代理名> -b wt/<代理名>`；每代理绑绝对路径；完成后编排者逐一 `git diff` 汇总、征询合并；无 git 仓库的写场景退化为文件级互斥分工。**生命周期（必做收尾）**：合并完成后 `git worktree remove` + `git branch -d` 清理对应树与分支；用户拒绝合并或需保留审查时，保留 worktree 并向用户明示残留位置与清理命令；编排回合中断（异常结束）时，下回合恢复协议须先检测并报告孤儿 worktree。
6. **多回合组合（嵌套替代协议）**：子代理不能再派子代理（机制限制，不要尝试）；大任务的"子工作流"= 拆成多个编排回合，主代理留在回合间读结果定下一步；每回合结束向用户汇报阶段结论。
7. **结构化输出纪律**：要求子代理返回 fenced JSON（字段清单写死在提示词里）；编排者收到后校验字段，不合格带着错误信息重派；作者不复核自己的产出。
8. **journal / resume 纪律**：协议见 4.4.2——任务指纹命名、状态机、逐批落盘、恢复时指纹校验 + 只派缺失项；大批量（>6）派发用 `run_in_background: true`（产出落 outputFile，会话丢失也不重付，journal 记录 outputFile 路径映射）。
9. **质量模式目录**：对抗复核（N 个独立反驳者多数票）、评审团（N 独立方案+评分+嫁接）、loop-until-dry（轮上限 + 连续无新发现即收敛 + 对 seen 全集去重）、多镜头扫掠、完整性批评家（交付前独立读者问"漏了什么"）、无静默截断（丢弃必须明说）。
10. **规模纪律**：按用户措辞缩放（"找个 bug"单票复核，"彻底审计"大池对抗）；任何截断/降采样的丢弃项必须显式报告。
11. **dwf 路由（一节，不展开）**：大型**只读**审计（预计 >20 子代理、小时级、需要逐项 resume——**阈值待校准**）时，建议用户改走 `CreateWorkflow` 动态工作流（先加载 dynamic-workflows 技能）；其编译校验、确认窗、Amend 缓存在该场景价值最大。**写文件场景不适用**（无 worktree 隔离），留在本引擎。

### 4.4 两个嫁接设计详述

#### 4.4.1 结构化输出（对应 dwf 的 `ask<T>` 编译期校验）

- **做法**：子代理提示词模板含交付 JSON 的字段清单与示例；编排者收到后做三项校验（可解析 / 字段齐 / 值域合理），不合格者带着具体错误重派一次，再失败则降级为"标记不可信并保留"。
- **诚实定位**：这是提示层保证。但 ccb 的生产实现同为 prompt-forced JSON（工具调用层强制因 8/12 子代理死亡被废弃）【ccb】，故本方案与其线上现状**同级**，非劣化。

#### 4.4.2 journal / resume（对应 dwf 的 Amend 字节级缓存导入）

**机制半成品（白嫖官方）**：`run_in_background: true` 时每个子代理产出持久化到 `outputFile`【码，contracts/src/tools/agent.ts:57-68】——付过钱的结果在会话压缩/客户端重启后仍可读。

**任务日志协议（失效协议是一等公民）**：

- **命名与指纹**：日志文件名 = `journal-<指纹前 8 位>.jsonl`；指纹 = 编排开始时对"用户原始指令 + 编排者分解方案"整体做 sha256（编排者经 Bash `echo ... | shasum` 计算）。指纹取代自由命名的任务名——同名漂移不再碰撞，异名同任务不再失联。
- **首行声明（meta 记录）**：每份日志第一行固定写 `{type:"meta", fingerprint, taskDigest, createdAt, status:"open"}`；后续每批结果一行 `{type:"entry", agent, summary, status, result, outputFile?}`。
- **状态机**：`open`（编排进行中）→ `done`（全部子任务完成且已汇总）| `abandoned`（用户放弃/任务改向）。恢复时：`done` 拒绝重放（直接读最终结果呈现）；`open` 才进入补跑；`abandoned` 不再复用，新指纹开新日志。
- **失效条件（显式）**：① 恢复时重算指纹，与 meta 不匹配 → 日志作废、全量重派（任务漂移保护）；② 用户指令变更 → 新指纹新日志，旧日志若 `open` 则补一行改 `abandoned`；③ `.ultracode/` 下超过 30 天的日志文件在编排回合开始时提示用户可清理（不自动删）。
- **读入边界校验**：解析逐行进行，坏行（JSON 解析失败或必填字段缺失）**跳过并计数**，恢复报告中明示"跳过 N 条坏行，对应子任务将重派"——跳过的条目视为缺失项，不中断恢复。
- **恢复协议**：读 meta（指纹校验 + 状态机判定）→ 逐行读 entry → 与分解方案对齐计算缺失项 → 只派缺失项；后台代理的 outputFile 路径从 entry.outputFile 找回。

**拿到的**：已完成子代理不重付（经济效果）；**拿不到的**：字节一致缓存匹配、无需模型自觉的自动导入——编排者漏记的那批要重跑。这是与 dwf 的真实差距，手册以"逐批立即落盘"纪律压低发生概率。

#### 4.4.3 失败路径表

| 故障 | 检测信号 | 行为 | 恢复 |
|---|---|---|---|
| worktree 创建失败（非 git 仓库 / 脏树 / 分支名已存在） | Bash 命令非零退出 | 不派发该写者；向用户报告原因；分支名冲突时换 `wt/<代理名>-2` 重试一次；非 git 仓库降级为文件级互斥分工并告知 | 修复 git 状态后重跑该子任务 |
| 子代理挂死/超长 | TaskOutput 查询无进展（手册规定：后台派发后按批次轮询，单代理超过约 10 分钟无产出即视为可疑） | TaskStop 终止该代理，标记 entry status=timeout，继续其余代理 | 恢复协议把 timeout 条目计为缺失项重派（可换措辞） |
| 合并冲突 | `git merge` 非零退出 | **不自动解决**：列出冲突文件清单与双方意图，交用户裁决（选边/手工改/放弃） | 用户裁决后由编排者执行对应合并操作 |
| journal 写入失败（磁盘/权限） | Write/Edit 工具报错 | **继续派发与汇总**（编排不因日志失败停摆），但明确告知用户"本任务 resume 不可用"；后续批次再尝试写入 | 无恢复——中断后全量重跑该任务 |
| 孤儿 worktree（上回合异常中断） | 恢复协议开始时 `git worktree list` 检查 | 向用户报告残留 worktree 清单及内容摘要，征询保留/清理 | 用户裁决后清理或复用 |

## 5. 实施与验收

### 5.1 实施（纯文件，约半天）

1. 写 `~/.zcode/skills/ultracode/SKILL.md`（按 4.3，中文为主，正文预计 180–220 行，含 4.4.2 journal 协议与 4.4.3 失败路径表的紧凑改写）；
2. 写 `~/.zcode/commands/ultracode.md`（按 4.1 全文）；
3. 重启客户端 / 新会话生效。

**暂缓项**：插件封装（见 4.1，出现真实分发需求再做）。

测试床 `ultracode-lab`（含 T1–T3 的资产原型）保留作回归环境。

### 5.2 验收清单

**安装完整性**
1. 官方 CLI `commands list --json` 显示 `ultracode` 且 `skills: ["ultracode"]` **非空**（空 = frontmatter 用了列表写法，回退内联）；
2. `skills list --json` 显示 ultracode（scope: user）。

**门控**
3. 新会话普通任务不触发编排（单 Agent 或直答）；
4. "用多代理并行处理 X" 触发手册门控通道 3。

**编排行为（在 ultracode-lab 回归）**
5. T1 场景：两个 Agent 调用同回合并行（会话 DB 中时间戳差 < 1s）；交付物正确；
6. T3 场景：worktree 建立 → 并行写 → diff 汇总 → 合并征询，全链路无冲突；
7. 结构化输出：注入一个要求返回固定 JSON 的子任务，编排者完成校验（构造一个字段缺失场景验证重派）；
8. journal：中断（会话中途新开）后以同名任务重入，编排者读日志只派缺失项（验证 `.ultracode/journal-*.jsonl` 存在且被消费）；
9. 规模纪律：要求"对 200 个文件每个 5 个评审"时先报价而非直接派。

**dwf 路由**
10. 大型只读审计请求时，手册建议 CreateWorkflow 且不与本引擎混用。

**校准实测**
11. 高扇出实测：8 个独立只读子任务同回合并行派发——验证实际并发执行上限、全部返回率与总耗时，据实回调手册的并行默认值与报价阈值（F3 校准项）；顺带验证 journal 指纹协议（中断其一后续跑）与孤儿 worktree 检测。

### 5.3 回归与维护

- 手册关键规则句是行为契约，改措辞重跑验收 3–11；
- 监测点：客户端升级后 Agent 工具契约（agent.ts 的输入/outputFile 字段）与 `skills:` frontmatter 解析行为——这两处是本方案的全部机制依赖，变更即需修订手册对应章节。

### 5.4 主要决策的移除条件

| 决策 | 移除/重评条件 |
|---|---|
| journal 纪律（提示层缓存） | 官方 Agent 工具族提供原生 resume/结果重放机制，或用户长期不中断大任务使 resume 场景消失 |
| dwf 路由一节（§4.3 第 11 条） | 灰度关闭且无重开计划（删除该节），或 dwf 支持工作区隔离/并行写（反向吸收本引擎的写场景，重新评估主体路线） |
| 并行默认 ≤5 / 报价阈值 >12 | 验收第 11 条高扇出实测后回调；此后每次手册大版本修订复测 |
| 多回合组合协议（嵌套替代） | 官方客户端放开子代理嵌套派发（子代理工具面出现 Agent/Task）——改为原生嵌套并简化手册 |

## 6. 风险与未决

| 风险 | 等级 | 缓解 |
|---|---|---|
| 提示层纪律无机制保证（并行上限、journal 忠实记账、结构化校验） | 中 | 关键规则句强断言 + 验收回归；GLM-5.3 实测遵循度良好（2.4） |
| 客户端升级改变 Agent 契约 / frontmatter 解析 | 低频高影响 | 5.3 监测点；资产全在用户目录，修订即一份 SKILL.md |
| dwf 路由节依赖灰度持续开放 | 低 | 该节自带"若不可用则留在本引擎"回退句 |
| 子代理模型统一由 Settings 决定，无法 per-call 覆盖（与 ccb 混 tier 策略不同） | 已接受 | 官方机制如此（2.2）；如需分层可配多个 subagent_type profile |
| 未决：`SendMessage` 工具与后台代理的交互面（能否向运行中子代理追加指令）未实测 | 低 | 实现后补一次专项测试；不影响首版 |

## 附录

### A. 会话证据索引（`~/.zcode/cli/db/db.sqlite`）

- T1：`sess_e38847ed-…`（并行派发，Agent 调用时间戳 1793857355943 / 1793857355960）
- T2：`sess_30a21751-…` + `sess_subagent_agent_08882a57-…`（嵌套禁止实证）
- T3：`sess_127a2175-…` + `sess_subagent_agent_29441ae5/65df9466-…`（worktree 并行）
- dwf 门开证据：`sess_dwf-dwfrun-c39543b1-…` 系列（2026-11-05 桌面端 /workflow 实跑）

### B. 调研产物索引

- 工作流 1（`whd2ivbod`）：双代码库 5 路深读 + 综合设计（含 gapAnalysis、三选项、删除清单——fork 路线产物，已被载体约束废止，仅作事实参考）
- 工作流 2（`wp6jlv08j`）：路线 1/2 深挖 + 决策矩阵（budget 分水岭分析、dwf 补 budget 四触点账单——B/C 路线评估依据）
- 工作流 3（`wu1csjyaa`）：官方客户端约束重评估（默认工具面、扩展面、MCP sampling 证伪、客户端形态）
- 测试床：`/Users/lzk/Desktop/个人学习/zcode改造/ultracode-lab/`

### C. 决策时间线（2026-11-05）

| 时点 | 决策 |
|---|---|
| 上午 | 用户在桌面端以 /workflow（dwf）跑同目标任务，产出一版 dwf 路线实现（另一会话产物，本轮按用户指示**屏蔽不计入评估**；其存在恰好实证 dwf 灰度门开） |
| 本轮早期 | 源码 fork 路线调研（路线 1 引擎移植 / 路线 2 dwf 改写）；用户裁决：budget 不做、/expert 一并删、并发默认 5（后均随载体变更废止） |
| 中期 | **载体约束揭晓**：目标是官方客户端，源码仅参考——fork 类决策全部失效；B（外部 MCP 引擎）因无 sampling 被证伪后用户裁决放弃 |
| 后期 | 澄清 budget 概念后用户裁决：worktree + 嵌套为硬需求、budget 非必需；实测 T1–T3 后嵌套确认不可实现（两引擎均机制禁止），降级为多回合组合 |
| 定稿 | A+D 主体 + 嫁接两项 dwf 长处 + dwf 路由一节；本文档 |

### D. 修订记录

**2026-11-06 实测校准注记**：本文档为 2026-11-05 定稿时点快照。实测后两处数值已在正式资产（SKILL.md）中校准，以资产为准：并行默认 ≤5 → **≤8**（U6 实测 8/8 返回）；指纹源文件由共享名 fingerprint.txt → **`fingerprint-<指纹>.txt`**（U4 实测发现多任务覆盖缺陷，手册追认）；指纹长度统一为 16 位（原 §4.4.2 的"前 8 位"与 meta"16 位"矛盾已在实现中裁决为 16 位）。详见 SKILL.md 与验收记录。

**2026-11-05 架构评审修订（七项，均经用户确认）**

- **F1/F4（G4/G2）——journal 无失效协议、schema 未定义。** 评审指出：journal 是"已完成子代理结果的缓存"，原文只有写入与恢复、无失效条件，任务漂移会错误跳过派发。修订：4.4.2 全量补全——指纹命名（指令+分解方案 sha256 前 8 位）、meta 首行声明、open→done/abandoned 状态机、三条显式失效条件（指纹不匹配作废 / 指令变更转 abandoned / 30 天提示清理）、坏行跳过计数并计为缺失项。
- **F2（G5）——失败路径未枚举。** 新增 4.4.3 失败路径表：worktree 创建失败（降级文件级互斥）、子代理挂死（TaskOutput 轮询检测 + TaskStop + 计为缺失项）、合并冲突（不自动解决、清单交用户裁决）、journal 写失败（编排不停摆但明示 resume 不可用）、孤儿 worktree（恢复时检测报告）。
- **F3（G1）——三个魔法数字无量化依据。** 并行 ≤5、报价阈值 >12、dwf 路由 >20 全部标注"初始默认待校准"；验收新增第 11 条高扇出实测（8 并行）校准。
- **F5（G4）——worktree 泄漏（实测印证：T3 后 wt/agentA、wt/agentB 残留）。** 4.3 第 5 节补生命周期：合并后 remove+删分支、拒绝合并时保留并明示、中断后孤儿检测。
- **F6（铁律 3）——插件封装属推测性抽象。** 降级为暂缓项（4.1/5.1），出现真实分发需求再做。
- **F7（A6）——决策缺移除条件。** 新增 5.4：journal 纪律、dwf 路由节、并行默认、多回合组合协议四项各附移除/重评条件。
- 事实核查修正：MCP sampling 断言补非标准旁路注脚；ccb 行号引用校正为 262-285。
