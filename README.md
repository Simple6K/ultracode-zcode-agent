# ultracode-zcode-agent

把 claude-code 的 `/ultracode`（多代理编排模式）移植到 **ZCode 官方客户端**，运行在官方 **Agent 子代理设施**上。零宿主改动、纯用户级 Markdown 资产。

> 设计与验收的完整依据见 [docs/设计方案-ultracode-Agent引擎版.md](docs/设计方案-ultracode-Agent引擎版.md)（2026-11-05 定稿，经事实核查与架构评审修订；2026-11-06 实测校准注记在文末修订记录）。

## 形态

与 ccb /ultracode 同构：**1 个知识型技能 + 1 个薄斜杠命令**，编排能力由官方 Agent 工具族承担（Agent / TaskOutput / TaskStop / run_in_background），不引入任何自研引擎代码。

| 文件 | 安装到 | 作用 |
|---|---|---|
| `skills/ultracode/SKILL.md` | `~/.zcode/skills/ultracode/SKILL.md` | 编排手册：门控、分解、并行纪律、worktree 规范、多回合组合、结构化输出、journal/resume、质量模式、dwf 路由 |
| `commands/ultracode.md` | `~/.zcode/commands/ultracode.md` | `/ultracode` 入口：`skills:` 自动挂载手册 + `$ARGUMENTS` 注入任务 |

## 安装

**方式一：插件市场（推荐，支持一条命令更新）**

```bash
zcode plugins marketplace add Simple6K/ultracode-zcode-agent
zcode plugins install ultracode@simple6k-zcode-plugins
```

更新：`zcode plugins update ultracode@simple6k-zcode-plugins`。
注意插件技能带命名空间前缀（`ultracode:ultracode`），命令 frontmatter 用限定名引用。

**方式二：直接复制（手工全局安装）**

```bash
mkdir -p ~/.zcode/skills/ultracode ~/.zcode/commands
cp skills/ultracode/SKILL.md ~/.zcode/skills/ultracode/SKILL.md
cp commands/ultracode.md ~/.zcode/commands/ultracode.md
```

重启 ZCode 客户端（或新开会话）生效。验证：

```bash
zcode commands list --json   # 应看到 ultracode 且 skills: ["ultracode"] 非空
zcode skills list --json     # 应看到 ultracode（scope: user）
```

## 使用

- `/ultracode <任务>`（或消息含 ultracode、原话要求多代理编排）进入编排模式；
- 并行子任务同回合并行派发（默认 ≤8，实测校准）；并行写文件走 worktree 隔离 + 合并征询；
- 大任务拆多回合，主代理留在回合间；每任务有 `.ultracode/journal-<指纹>.jsonl` 日志，中断后增量补跑；
- 大型只读审计（>20 子代理）建议路由到 ZCode 动态工作流（CreateWorkflow）。

## 实测验收（2026-11-06，ZCode.app 3.17.2）

| 验收项 | 结果 |
|---|---|
| 安装完整性 / 门控阴性 / 并行+journal / worktree 全链路+清理 / 规模报价 / dwf 路由 / 高扇出校准 | 全部通过 |
| 8 并行校准 | 8/8 返回、零越界 → 默认并行定为 ≤8 |
| journal 恢复三支路 | done 拒绝重放 / open 缺失补派 / 从 journal 确定性恢复文件 —— 实测通过 |
| 复合链路 | 侦察 → 报价（1000 代理请求被拦截征询）→ 路由 dwf 40 评审员 → 编译报错迭代重交 → 范围诚实披露 |

## 已知边界

- 子代理不能再派子代理（zcode 机制禁止）——大任务拆多回合组合；
- 并发上限、结构化校验、journal 记账均为提示层纪律（无引擎强制）；结构化输出与 ccb 生产现状同级（prompt-forced）；
- 不做 budget（引擎无该原语，且 ccb 生产同样未接线）。
