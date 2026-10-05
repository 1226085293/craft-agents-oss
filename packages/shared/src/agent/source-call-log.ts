/**
 * Source Call Log — 数据源调用最小审计日志（阶段 1）。
 *
 * 与 execution-journal（含参数/返回体，供崩溃恢复）不同，本日志只记元数据，
 * 满足“时间、会话、源、工具、风险、结果、是否确认、耗时”的最小审计要求，
 * 且**不记录 tool 参数与返回体**（隐私）。
 *
 * 存储：{workspaceRootPath}/sessions/{sessionId}/source-call-log.jsonl（按会话分文件，
 * 避免多会话并发写同一文件交错损坏）。超过 5MB 时截断保留尾部（保留最近 ~4000 条）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourcePermissionKey, SourceRiskLevel } from '../sources/types.ts';
import { parseSourceSlugFromTool } from './source-policy.ts';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_TAIL_LINES = 4000;

export interface SourceCallLogEntry {
  ts: number;
  sessionId: string;
  sourceSlug: string;
  tool: string;
  risk: SourceRiskLevel;
  operation: SourcePermissionKey;
  result: 'ok' | 'error' | 'blocked';
  confirmed: 'none' | 'once' | 'session' | 'always';
  durationMs?: number;
  policyApplied?: string;
}

/**
 * 记录一次数据源工具调用（仅来源工具；非来源工具 no-op）。
 * 任何 IO 异常都被吞掉 —— 审计日志失败不得影响主流程。
 */
export function recordSourceCall(
  workspaceRootPath: string,
  sessionId: string,
  entry: Omit<SourceCallLogEntry, 'ts' | 'sessionId' | 'sourceSlug'>,
): void {
  const parsed = parseSourceSlugFromTool(entry.tool);
  if (!parsed) return;

  const dir = join(workspaceRootPath, 'sessions', sessionId);
  const file = join(dir, 'source-call-log.jsonl');

  try {
    mkdirSync(dir, { recursive: true });

    // 上限保护：超限截断保尾（保留最近 KEEP_TAIL_LINES 行）
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      const raw = readFileSync(file, 'utf-8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > KEEP_TAIL_LINES) {
        writeFileSync(file, lines.slice(-KEEP_TAIL_LINES).join('\n') + '\n', 'utf-8');
      }
    }

    const full: SourceCallLogEntry = {
      ts: Date.now(),
      sessionId,
      sourceSlug: parsed.slug,
      tool: entry.tool,
      risk: entry.risk,
      operation: entry.operation,
      result: entry.result,
      confirmed: entry.confirmed,
      durationMs: entry.durationMs,
      policyApplied: entry.policyApplied,
    };
    appendFileSync(file, JSON.stringify(full) + '\n', 'utf-8');
  } catch {
    // 审计日志失败绝不阻断工具执行
  }
}
