---
name: ultracode
description: 多代理编排模式（dwf 引擎版）。当用户敲 /ultracode、消息里说 ultracode、或用自己的话明确要求多代理并行编排/工作流式深挖时使用。Use when the user says "ultracode" or explicitly asks for multi-agent orchestration via workflows.
when_to_use: 仅限显式 opt-in（见手册 §1）。普通任务不触发。
---

# ultracode 编排手册（dwf 引擎版）

你是编排者：把任务翻译成**一段 dwf 工作流脚本**，经 CreateWorkflow 交给引擎自主执行。引擎管调度、并发、记账、恢复；你留在循环外，通过确认窗、escalation、留白、终态通知与 run 交互。工具的精确契约以官方 `dynamic-workflows` 技能为准——本手册只讲**判断层**（何时编排、怎么切分、质量模式），不重复工具参考，也不自维护 API 表（官方技能内嵌 facade 全文，随客户端更新）。

## 1. 门控（opt-in）

仅当以下之一成立才进入编排：用户敲了 /ultracode；消息含 "ultracode"；用户用自己的话明确要求多代理/工作流编排；用户调用的技能或命令正文明确要求编排。判定标准是**用户显式意图**，不是任务性质。皆不成立时：自己做或单个 Agent 派发；可一句话说明编排能做什么并告知下次说"用多代理编排"可跳过询问。会话级常开同旧例：用户宣布"本会话 ultracode 开启"后默认编排，压缩后不确定就问一次。

## 2. 前置（技能门，必做）

1. **先加载官方 `dynamic-workflows` 技能**（Skill 工具）——CreateWorkflow 提交 script/path 前要求该技能已在会话中加载，否则被拒（业务码 428）。
2. 确认 CreateWorkflow 工具可见。不可见 → 向用户报错"需在设置中启用动态工作流"，**不降级、不重试**。
3. 并发上限与子代理模型不必写死在脚本里：脚本内没有并发原语（默认值由引擎按核数决定），提交后的确认窗里用户可直接调整。

**提交后第一步是确认窗**：引擎向用户展示脚本全文（默认折叠）、阶段时间线、子代理模型与并发（窗内可调）；用户批准 → run 启动、CreateWorkflow 立即返回；用户**拒绝或选 Refine（拒绝+反馈）** → 按反馈修改脚本重新提交。等待确认期间正常与用户对话，不要重复提交。

## 3. 路由判断（何时值得一个 run）

- **值得编排**：任务可分解为并行覆盖（多文件/多视角审计、迁移、广扫）；需要独立视角相互校验（先找后对抗验证）；规模超出单上下文。
- **不值得**：单委派任务、两三个独立查询——直接 Agent 工具或自己做。门控通过但判不值得时，直接执行并向用户说明本次为何未起 run，用户可要求强制编排。
- **确定性先行**：work-list 能用脚本内确定性手段拿到的（`files.glob/grep`、`git.diff/status`、`world.run`），就不要派子代理去"看"——发现是代码的事，判断才是子代理的事。
- **一次性编排不存档**：用户要"跑一个任务"就直接 CreateWorkflow 内联脚本（引擎自动归档 run 记录与脚本，中断可 resume，无需保存）。仅当用户**明确**要求"沉淀/保存/以后复用这个工作流"时才 SaveWorkflow——不要在一次性任务上主动提议存档。

## 4. 脚本范式（现场写，十条铁律）

1. 现场写 TypeScript，无 `import/export/declare`；顶层 `return` 值即给模型的产物。
2. 子代理 = `agent(name?, persona?)` 返回的 agent，用 `.ask<T>(instructions)` 派活；`ask` 不带 T 时返回子代理最终文本。
3. **具名即身份**：字面量重名 = 编译错；动态计算出的重名 = 运行期 run 失败（DuplicateActorName）。fan-out 循环体内不得用固定名。一次性子代理用匿名 `agent()`；要跨 amend 复用缓存的才具名。
4. **结构化输出用类型**：`ask<T>` 的 T 写成脚本内 `interface`，JSDoc 注释即子代理看到的字段说明；受支持约束标签为 `@minimum/@maximum/@minLength/@maxLength/@pattern/@format/@minItems/@maxItems/@default`（**没有** `@min/@max` 简写，写错会被静默忽略）。校验失败引擎自动让子代理重试，3 次仍不过才失败——不要自己约定 JSON 格式再手工解析。
5. **失败是 throw 不是 null**：`ask` 失败以 `WorkflowError` 拒绝。逐项容错用 `try/catch` 包住单个 ask，失败的**计入报告**（失败清单或需人工介入），不静默丢弃；容错方向按错误代价选：审计类宁可保守标记，不把失败当通过。
6. 并发就是普通 JS：不 await + `Promise.all`；多阶段默认流水线（不设人为 barrier），衔接语义（chaining/channel/join）按官方技能决策表选。
7. 禁 `Date.now()` / `Math.random()` / 无参 `new Date()`——运行期直接抛错。时间戳经 `args` 传入；随机性用索引变体。
8. **指令文本即缓存键**：ask 的指令哈希是其重放/导入匹配键——resume 按它比对 journal，amend 导入缓存按**具名子代理 + 指令哈希序列**命中，匿名 agent 永不参与缓存。因此：要跨 amend 复用的具名子代理，指令必须是稳定模板（可变数据经控制流分流，不拼进指令）；一次性的匿名 ask 允许内插数据。
9. 全局限量（引擎硬限）：`report` 65,536 条/run；artifact 32 个 id/run、单 markdown ≤256KB；骨架里用了更紧的自限值。
10. 阶段名、子代理名用用户的语言——它们出现在确认窗和进度时间线上。

## 5. 骨架模式

语法以官方 facade 为准；`files`/`git`/`world` 是脚本内全局命名空间（成员均为 Promise 返回，须 await），命名空间归属属桌面校准项。

**A. map-reduce 扫描**（确定性发现 + 匿名扇出 + 逐项容错 + 显式截断）：

```ts
const all = await files.glob("src/**/*.ts")        // 脚本内确定性，不派代理
const paths = all.slice(0, 200)
const results = await Promise.all(paths.map(async (f) => {
  try {
    return await agent().ask<{file: string, summary: string, risks: string[]}>(
      `读工作区文件 ${f}，概括职责、依赖与最大风险`)
  } catch (e) { return {file: f, error: String(e)} }
}))
const failed = results.filter(r => "error" in r)
report({scanned: results.length, failed: failed.length, truncated: all.length - paths.length})
return {结论: `扫描 ${results.length}/${all.length}（截断 ${all.length - paths.length}），失败 ${failed.length}`,
        已完成: results.filter(r => !("error" in r)).map(r => r.file),
        失败: failed.map(f => f.file), 产物: [], 需人工介入: []}
```

**B. 评审-修复循环**（typed ask + 引擎侧循环 ≤3 轮；评审失败 ≠ 通过，进人工介入）：

```ts
const targets = await git.changedFiles()
const unresolved = new Set<string>()                 // 评审失败者：不进修复循环，交人工（Set 去重）
for (const round of [1, 2, 3]) {
  const reviews = await Promise.all(targets.map(async (f) => {
    try { return await agent().ask<{file: string, pass: boolean, score: number, issues: string[]}>(
      `评审 ${f} 的改动。pass=是否达标，score=0-10`) }
    catch (e) { return {file: f, pass: false, score: -1, issues: [`评审失败：${e}`]} }
  }))
  const failing = reviews.filter(r => !r.pass && r.score >= 0)
  reviews.forEach(r => { if (r.score < 0) unresolved.add(r.file) })
  log(`第 ${round} 轮：${failing.length} 待修，${unresolved.size} 评审失败`)
  if (!failing.length) break
  await Promise.all(failing.map((r, i) =>
    agent(`fixer-${round}-${i}`).ask(`修复 ${r.file}：${r.issues.join("；")}`)))
}
return {结论: "评审-修复完成", 已完成: [], 失败: [], 产物: [], 需人工介入: [...unresolved]}
```

**C. 多路对抗验证**（每发现 3 个反驳者，多数反驳即丢弃；反驳者默认反驳立场，验证者失败保守丢弃）：

```ts
const survivors: {finding: string, votes: string}[] = []
for (const finding of findings) {
  const verdicts = await Promise.all([1, 2, 3].map(async () => {
    try { return await agent().ask<{refuted: boolean, reason: string}>(
      `仅凭仓库证据尝试反驳以下发现，拿不准即 refuted=true：${finding}`) }
    catch { return {refuted: true, reason: "验证者失败，保守丢弃"} }
  }))
  if (verdicts.filter(v => !v.refuted).length >= 2)
    survivors.push({finding, votes: verdicts.map(v => v.reason).join(" | ")})
}
return {结论: `${findings.length} 项发现，${survivors.length} 项存活`, 已完成: [], 失败: [],
        产物: [], 需人工介入: []}
```

**D. 并行 worktree 写入**（引擎无工作区隔离，靠 actor 自建；指令与命令分离，不把散文拼进 && 链）：

```ts
// 每 actor：先建 worktree，再在其中完成任务并提交；合并留在脚本外（见 §7）
await Promise.all(tasks.map(async (t) => {
  const msg = JSON.stringify(t.msg)                 // commit 消息转义，防引号断链
  await agent().ask(
    `在独立 worktree 中完成并行写入任务，步骤：\n` +
    `1. cd "$(git rev-parse --show-toplevel)" && git worktree add ../wt-${t.id} -b wt/${t.id}\n` +
    `2. cd ../wt-${t.id} 并完成任务：${t.goal}（只改 ${t.files.join(", ")}）\n` +
    `3. git add -A && git commit -m ${msg}\n` +
    `最终回复只报分支名与改动文件清单`)
}))
```

**E. 审计组合管线**（发现 → 对抗验证 → 综合；"彻底审计"的完整形态）：

```ts
const changed = await git.diff()                     // 确定性输入
const found = (await Promise.all(lenses.map(async (lens) => {   // 多镜头扇出，每代理不同 lens
  try { return await agent().ask<{findings: {file: string, title: string, detail: string}[]}>(
    `以 ${lens} 视角审查以下改动，只报有证据的问题：\n${changed.slice(0, 8000)}`) }
  catch { return {findings: []} }
}))).flatMap(r => r.findings)
// …对 found 逐项跑骨架 C 的对抗验证（代码同上，略）…
const reportMd = await agent().ask<string>(          // 综合阶段：一个代理产出用户面报告
  `把以下存活发现整理为 markdown 审计报告（结论先行、逐项附证据路径）：
   ${survivors.map(s => `- ${s.finding}`).join("\n")}`)
await artifact.markdown("audit-report", reportMd, {title: "审计报告"})
return {结论: `发现 ${found.length}，存活 ${survivors.length}，报告见产物`,
        已完成: [], 失败: [], 产物: ["audit-report"], 需人工介入: []}
```

## 6. 汇报契约（承重结构——上下文卫生靠它）

- **return 必须是小结构**：`{结论, 已完成[], 失败[], 产物[], 需人工介入[]}`。终态通知里 `result` 是唯一全文位，return 几十万字符会把上下文撑爆（引擎 120k 截断只是兜底）。
- **全文走 `report(item)`/`artifact.*`**：report 渐进发布、journal 化（run 失败也随通知送达；未声明 dashboard 时省略第二参数）；`artifact.file/markdown` 发布用户面交付物。终态通知对二者只带 count+preview，全量按 runId 可取。
- 汇报顺序遵循引擎交付指引：结论 → 证据（路径/命令输出）→ 哪些经确定性检查或独立子代理确认、哪些仅判断 → 未覆盖范围。

## 7. 提交后行为与运行中回路

- **提交后不轮询**：run 后台执行，结果以终态通知到达；期间正常响应用户（确认窗流程见 §2）。
- **escalation**（子代理向主代理提问）：通知到达即处理，用 `ResolveWorkflowQuestion` 按 qid 作答；不确定先 AskUserQuestion 问用户。注意：**无超时**，不处理子代理会一直等；每 ask 上限 3 次。
- **留白**（脚本向你要代码）：写脚本时不确定的片段用 `hole<T>("名字", "提示")` 留白；通知到达用 `FillWorkflowHole` 补语句体。宁可留白也不要猜。
- **worktree 收尾**（骨架 D）：run 完成后由你（主代理）逐一 `git diff` 汇总各分支 → 征询用户合并；冲突不自动解决，列清单交用户裁决；合并后 `git worktree remove` + 删分支；中断后先 `git worktree list` 查孤儿。
- **停滞告警**：判断是等待（escalate 作答）、还是死锁（stop 后 resume）。

## 8. 失败与恢复

- **errored 不可 resume**：读诊断（带 文件:行号，指向 `.zcode/workflow-drafts/` 下的可编辑工作副本——与 `.zcode/workflow-runs/` 的执行归档分工）→ Edit 草稿 → 以 `path` 通道重提交新 run。
- **stopped/中断可 resume**：`ResumeWorkflowRun`，重放的是 journal 里字节同一的脚本与存档实参——resume 不接受改脚本、不接受换实参。
- **改脚本续跑**走 `AmendWorkflow` + `path`：铸新 run，已结算的具名子代理工作经导入缓存零 token 沿用（这就是铁律 3/8"要复用才具名、指令即缓存键"的原因）。
- **会话中断后找回**：`ListWorkflowRuns` → `GetWorkflowRun` 看状态与 `scriptPath` → resume 或 amend。
- **用户停止的 run（stopReason=user）不自行恢复**；要继续必须用户显式要求。

## 9. 跨轮组合（替代嵌套）

子代理没有 CreateWorkflow（结构性双重禁止）——**嵌套不可能，也不要在 ask 文本里要求子代理起工作流**。大任务 = 多个 run 接力：你读上一 run 的 return，决定下一 run 的脚本；每轮结束向用户汇报阶段结论。

## 10. 规模与质量纪律

- **事前报价**：预计子代理总数 >50、或扇出对象需要截断/降采样时，提交前先向用户陈述规模、轮数与截断策略，获准再提交——确认窗看到的只是脚本，不是规模语义。
- 按用户措辞缩放："找个 bug" = 少量查找者 + 单票复核；"彻底审计" = 骨架 E 完整管线。
- 验证投向错误代价最高处。多视角扇出必须**每代理不同 lens**，不要 N 份相同提示词。连续 2 轮无新发现才收敛（loop-until-dry，轮数上限写死在代码）。交付前自问"哪里没支撑、用户接下来会问什么"。丢弃/降采样/跳过的项必须显式报告数量与原因（骨架 A 的 `truncated` 即为例）。

## 11. 旧引擎遗留说明

本插件仍带 v1.x 的两个 hook（并发闸门 + 机制账本），仅作用于 **Agent 工具通道**，与 dwf 路径无关、无需理会。本手册不再使用 Agent 编排路径；dwf 闸门关闭时不降级到旧路径（§2 报错退出）。
