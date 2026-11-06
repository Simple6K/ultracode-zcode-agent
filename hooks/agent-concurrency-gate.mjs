#!/usr/bin/env node
// ultracode 插件 · PreToolUse hook（matcher: Agent）
// 机制级并发上限：统计当前编排会话仍在运行的子代理数，超过上限直接 deny 本次 Agent 调用。
// 语义：fail-open——任何自身错误（db 缺失/查询失败/输入异常）都放行，绝不因 hook 故障卡死编排。
// 上限：默认 8；项目可在 <cwd>/.ultracode/max-parallel.txt 写一个数字覆盖。

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_PARALLEL = 8;

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function countLiveChildren(sessionId) {
  // 测试可用 ULTRACODE_DB 覆盖；生产默认读全局会话库
  const db = process.env.ULTRACODE_DB || join(homedir(), ".zcode", "cli", "db", "db.sqlite");
  await stat(db); // 不存在则抛错 → fail-open
  // sqlite3 CLI 无占位符：先做格式白名单，再转义内联
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return 0;
  const safe = sessionId.replace(/'/g, "''");
  const sql = `SELECT COUNT(*) FROM session WHERE parent_id='${safe}' AND task_type='subagent_child' AND last_outcome IS NULL AND time_archived IS NULL`;
  const { stdout } = await execFileAsync("sqlite3", [db, sql], { timeout: 5000 });
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

async function resolveLimit(cwd) {
  try {
    const raw = (await readFile(join(cwd, ".ultracode", "max-parallel.txt"), "utf8")).trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  } catch {}
  return DEFAULT_MAX_PARALLEL;
}

function deny(message) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    }),
  );
}

try {
  const input = await readStdinJson();
  const sessionId = input.sessionId;
  const live = await countLiveChildren(sessionId);
  const limit = await resolveLimit(input.cwd || process.cwd());
  if (live >= limit) {
    deny(
      `ultracode 并发上限已满：当前编排会话有 ${live} 个子代理仍在运行（上限 ${limit}）。` +
        `请等部分子代理返回后再派发，或先用 TaskStop 终止不再需要的子代理。` +
        `（上限可在 ${join(input.cwd || "", ".ultracode", "max-parallel.txt")} 调整）`,
    );
  }
  // 未超限：无输出 + 退出 0 = 放行
  process.exit(0);
} catch {
  // fail-open：hook 自身故障绝不阻塞编排
  process.exit(0);
}
