#!/usr/bin/env node
// ultracode 插件 · PostToolUse hook（matcher: Agent）
// 机制级账本：每次 Agent 调用（派发与返回）自动追加到 <cwd>/.ultracode/agent-ledger.jsonl。
// 这是 hook 写的"机制真账"——编排者漏写任务日志也不丢账；resume 协议可拿它与任务日志对账。
// 语义：绝不阻塞（PostToolUse 无阻塞语义），自身错误静默放行。

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

try {
  const input = await readStdinJson();
  const cwd = input.cwd || process.cwd();
  const toolInput = input.toolInput || {};
  const resp = input.toolResponse || {};

  const record = {
    type: "agent",
    ts: new Date().toISOString(),
    sessionId: input.sessionId,
    callId: String(input.toolCallId ?? ""),
    agentId: resp.agentId ?? null,
    status: resp.status ?? "unknown",
    description: toolInput.description ?? "",
    background: resp.isAsync === true,
    outputFile: resp.outputFile ?? null,
  };

  const dir = join(cwd, ".ultracode");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "agent-ledger.jsonl"), JSON.stringify(record) + "\n", "utf8");
  process.exit(0);
} catch {
  // 账本失败不影响编排（任务日志纪律仍在手册层兜底）
  process.exit(0);
}
