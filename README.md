# ultracode-zcode-agent

把 claude-code 的 `/ultracode`（多代理编排模式）移植到 **ZCode 官方客户端**，v2.0 起运行在官方自带的 **dwf 动态工作流引擎**（CreateWorkflow）上。零宿主改动，编排、并发、记账、恢复全部由引擎承担。

> 设计权威依据：[docs/design/0001-ultracode-dwf引擎版设计方案.md](docs/design/0001-ultracode-dwf引擎版设计方案.md)（v2.0，dwf 引擎版）。
> v1.x（Agent 提示词编排路线）方案见 [docs/设计方案-ultracode-Agent引擎版.md](docs/设计方案-ultracode-Agent引擎版.md)（已标 superseded，保留为 v1.x 插件的权威描述与实测记录）。

## 形态

与 ccb /ultracode 同构：**1 个知识型技能 + 1 个薄斜杠命令**。技能是纯知识注入的编排手册（判断层 + 模式骨架），工具参考指回官方 `dynamic-workflows` 技能，不自研任何运行时代码、不自维护 API 表。

| 文件 | 作用 |
|---|---|
| `skills/ultracode/SKILL.md` | 编排手册：门控、技能门前置（官方 428 门）、路由判断、脚本范式十铁律、五个骨架模式（map-reduce / 评审-修复循环 / 多路对抗验证 / 并行 worktree 写入 / 审计组合管线）、汇报契约、运行中回路（确认窗/escalation/留白）、失败与恢复 |
| `commands/ultracode.md` | `/ultracode` 入口：`skills:` 自动挂载手册 + `$ARGUMENTS` 注入任务 |
| `hooks/*.mjs` | v1.x 遗留（Agent 通道并发闸门 + 机制账本），仅向后兼容，与 dwf 主路径无关 |

## 安装

**方式一：插件市场（推荐，支持一条命令更新）**

```bash
zcode plugins marketplace add Simple6K/ultracode-zcode-agent
zcode plugins install ultracode@simple6k-zcode-plugins
```

更新：`zcode plugins update ultracode@simple6k-zcode-plugins`（同版本号不重拷，需卸载重装或等版本号升级）。
注意插件技能带命名空间前缀（`ultracode:ultracode`），命令 frontmatter 引用规则以实测为准（列入桌面校准项）。

**方式二：直接复制（手工全局安装）**

```bash
mkdir -p ~/.zcode/skills/ultracode ~/.zcode/commands
cp skills/ultracode/SKILL.md ~/.zcode/skills/ultracode/SKILL.md
cp commands/ultracode.md ~/.zcode/commands/ultracode.md
```

重启 ZCode 客户端（或新开会话）生效。验证：

```bash
zcode commands list --json   # 应看到 ultracode 且 skills 非空
zcode skills list --json     # 应看到 ultracode（scope: user），描述含"dwf 引擎版"
```

## 使用

- `/ultracode <任务>`（或消息含 ultracode、原话要求多代理编排）进入编排模式；
- 模型现场写 dwf 脚本（typed ask 结构化输出、逐项容错），经确认窗启动 run，引擎自主推进；
- 子代理结果全文只落引擎 journal，主模型只收小结构汇报（上下文卫生由引擎机制保证）；
- 大任务 = 多个 run 跨轮接力（子代理嵌套工作流被引擎结构性禁止）；
- 中断续跑：resume（字节同一脚本）或 amend（改脚本、已结算工作零 token 沿用）。

## 验收状态

- v1.x 桌面验收（2026-11-06，ZCode.app 3.17.2）：安装/门控/并行/worktree/恢复/复合链路全部通过（记录见旧设计文档）。
- **v2.0 桌面验收（2026-11-07，ZCode.app 3.17.2）**：D-a facade 契约 PASS、D-b 存档机制可用（裁决：一次性编排不存档）、D-c/U'1 worktree 硬需求 PASS（含部分合并路径）、D-e 确认窗合格、D-f1 技能门降级兜底、U'2 评审-修复循环 PASS、U'3 中断恢复 PASS（journal 重放零重算）、U'4 汇报契约 PASS、U'6 组合编排 PASS（**单 run 形态**；协议原定的跨轮接力路径未触发，保留为后备）。**未决项**：U'5 闸门关闭态不可本地复现（BLOCKED，机制已查明为服务端灰度+用户选择 sticky，一票否决处置待用户裁决）；D-f2 files.read 上限未执行（低优先）；D-f3 插件模式命令挂载待发版后补测。详见设计文档 §8 记录表。
- 已知体验代价：前置开销 2-6 分钟/次（官方技能加载 + 现场写脚本），小任务按手册 §3 不起 run 规避。

## 已知边界

- 子代理不能嵌套工作流（引擎双重禁止）——大任务拆多 run 组合；
- dwf 无原生 worktree 隔离：并行写靠骨架模式（actor 经 Bash 自建 worktree + 主代理裁决合并），与 v1.x 持平；
- CreateWorkflow 有技能门（需先加载官方 dynamic-workflows 技能）与每次 run 的确认窗；
- 不做 budget（用户裁定不需要）。
