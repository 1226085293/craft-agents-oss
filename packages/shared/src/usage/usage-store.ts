/**
 * Usage Store — Persistent record of source & skill usage.
 *
 * Writes one JSONL line per tool invocation that targets a source or a skill,
 * keyed by slug. Aggregation (use count + last-used timestamp) is computed by
 * a full scan on read — the append-only design mirrors `api-errors.jsonl` /
 * `execution_journal.jsonl`, so concurrent appends from multiple sessions are
 * safe and a torn write can never corrupt prior records.
 *
 * Data lives at `~/.craft-agent/usage/usage.jsonl` (respects `CRAFT_CONFIG_DIR`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from '../config/paths.ts';

// ============================================================================
// Types
// ============================================================================

export type UsageKind = 'source' | 'skill';

/** One persisted usage event. */
export interface UsageRecord {
  /** Unique record ID (UUID) */
  id: string;
  /** What was used */
  kind: UsageKind;
  /** Source or skill slug */
  slug: string;
  /** The (proxy) tool name that produced this usage, for traceability */
  toolName: string;
  /** Workspace the usage happened in (empty when unknown) */
  workspaceId?: string;
  /** Session that performed the usage (empty when unknown) */
  sessionId?: string;
  /** Epoch milliseconds */
  timestamp: number;
}

/** Input for {@link appendUsage}. */
export type UsageRecordInput = Omit<UsageRecord, 'id' | 'timestamp'>;

/** Resolved usage target for a single tool invocation. */
export interface UsageTarget {
  kind: UsageKind;
  slug: string;
}

/** Aggregated per-slug stats. */
export interface UsageStats {
  sources: Record<string, { useCount: number; lastUsedAt: number }>;
  skills: Record<string, { useCount: number; lastUsedAt: number }>;
}

// ============================================================================
// Tool-name resolution
// ============================================================================

/** Internal MCP server slugs whose tools must NOT be counted as source usage. */
const INTERNAL_SERVER_SLUGS = new Set(['session']);

/**
 * Resolve a tool invocation to a source/skill slug, or `null` when it is not
 * attributable to a tracked entity (native tools, internal session tools, …).
 *
 * Naming conventions (kept in sync with `SessionManager.resolveToolDisplayMeta`):
 *   - MCP source:   `mcp__{slug}__{tool}`          (slug sanitized by proxyToolName)
 *   - API source:   `mcp__api-bridge__api_{slug}__{tool}` → slug = `{slug}`
 *   - Skill:        `Skill` with `input.skill` = `"slug"` or `"workspaceId:slug"`
 */
export function resolveUsageTarget(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): UsageTarget | null {
  // Skill tool
  if (toolName === 'Skill' && toolInput) {
    const skillParam = toolInput.skill as string | undefined;
    if (skillParam) {
      const skillSlug = skillParam.includes(':') ? skillParam.split(':').pop() : skillParam;
      if (skillSlug) return { kind: 'skill', slug: skillSlug };
    }
    return null;
  }

  // MCP tools: mcp__<serverSlug>__<toolSlug...>
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) {
      const serverSlug = parts[1] ?? '';
      const toolSlug = parts.slice(2).join('__');

      // Internal MCP servers (session) are not tracked entities.
      if (INTERNAL_SERVER_SLUGS.has(serverSlug)) return null;

      // API bridge embeds the source slug in the tool name as "api_{slug}".
      if (serverSlug === 'api-bridge' && toolSlug.startsWith('api_')) {
        const sourceSlug = toolSlug.slice(4);
        if (sourceSlug) return { kind: 'source', slug: sourceSlug };
      }

      if (serverSlug) return { kind: 'source', slug: serverSlug };
    }
    return null;
  }

  return null;
}

// ============================================================================
// Storage
// ============================================================================

function getUsageDir(): string {
  return join(CONFIG_DIR, 'usage');
}

function getUsageFilePath(): string {
  return join(getUsageDir(), 'usage.jsonl');
}

/**
 * Append one usage record. Best-effort by design — usage tracking must never
 * break the tool invocation that produced it.
 */
export function appendUsage(record: UsageRecordInput): void {
  try {
    const entry: UsageRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...record,
    };
    const dir = getUsageDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(getUsageFilePath(), `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (error) {
    console.warn('[UsageStore] Failed to append usage record:', error);
  }
}

/**
 * Read all usage records, oldest first. Returns an empty array when the file
 * does not exist or contains only malformed lines (each bad line is skipped).
 */
export function readUsageRecords(opts?: { workspaceId?: string }): UsageRecord[] {
  const file = getUsageFilePath();
  if (!existsSync(file)) return [];
  const workspaceId = opts?.workspaceId;

  try {
    const raw = readFileSync(file, 'utf-8');
    const out: UsageRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as UsageRecord;
        if (workspaceId && record.workspaceId && record.workspaceId !== workspaceId) continue;
        out.push(record);
      } catch {
        // Skip a torn line rather than losing the whole trail.
      }
    }
    return out;
  } catch (error) {
    console.warn('[UsageStore] Failed to read usage records:', error);
    return [];
  }
}

/**
 * Aggregate usage records into per-slug counts + last-used timestamps.
 */
export function getUsageStats(opts?: { workspaceId?: string }): UsageStats {
  const stats: UsageStats = { sources: {}, skills: {} };

  for (const record of readUsageRecords(opts)) {
    const bucket = record.kind === 'source' ? stats.sources : stats.skills;
    const existing = bucket[record.slug];
    if (existing) {
      existing.useCount += 1;
      if (record.timestamp > existing.lastUsedAt) existing.lastUsedAt = record.timestamp;
    } else {
      bucket[record.slug] = { useCount: 1, lastUsedAt: record.timestamp };
    }
  }

  return stats;
}
