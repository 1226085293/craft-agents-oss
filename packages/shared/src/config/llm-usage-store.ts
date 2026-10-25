/**
 * LLM usage store — append-only record of every gateway decision.
 *
 * Mirrors `usage/usage-store.ts`'s design: one JSONL line per event,
 * `appendFileSync` so concurrent appends from multiple sessions are safe, and
 * aggregation computed by a full scan on read. A torn write can therefore only
 * cost the record it was writing, never corrupt the history.
 *
 * Data lives at `~/.craft-agent/llm-usage/usage.jsonl` (respects
 * `CRAFT_CONFIG_DIR`).
 *
 * Deliberately separate from the existing session usage store: that one's
 * `inputTokens` means "current context size", not a cumulative total, so it
 * cannot answer "how many tokens did I spend today". The design doc §7 calls
 * this out explicitly.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_DIR } from './paths.ts';

// ============================================================================
// Types
// ============================================================================

/** One persisted gateway decision. Mirrors the gateway's UsageRecord. */
export interface LlmUsageRecord {
  /** Epoch milliseconds. */
  ts: number;
  strategy: string;
  provider: string;
  keyId: string;
  publicModel: string;
  upstreamModel: string;
  /**
   * What the request was for — 对话 / call_llm / 忙碌决策 / 标题 / 记忆 …
   *
   * Stored verbatim so a log row can always be traced back to the feature that
   * made it. Set from `X-Craft-Model-Kind` (one kind per backend process) or
   * `X-Craft-Model-Kind-Override` (per call, inside a session that serves
   * several kinds); connection probes are written directly with
   * `kind: 'connection_test'` because they never reach the gateway.
   *
   * Absent on rows written before this existed, and on requests from clients
   * that declare nothing.
   */
  kind?: string;
  status: 'success' | 'error' | 'no_healthy_account';
  statusCode: number;
  attempts: number;
  error?: string;
  sessionId?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  firstByteMs?: number;
  totalMs?: number;
  retried?: boolean;
  trace?: string[];
}

export const LLM_USAGE_DIRNAME = 'llm-usage';
/** Current session's log. Always written, cleared at startup. */
export const LLM_USAGE_TEMP_FILENAME = 'usage-temp.jsonl';
/** One file per local day, written only when persistence is enabled. */
export const LLM_USAGE_DAY_PREFIX = 'usage-';
export const LLM_USAGE_FILENAME = LLM_USAGE_TEMP_FILENAME;

/**
 * Resolved per call rather than at import: tests (and a relaunched dev instance)
 * can point the store at another config dir without a fresh module instance.
 */
function configDir(): string {
  return process.env.CRAFT_CONFIG_DIR || CONFIG_DIR;
}

function usageDir(): string {
  return join(configDir(), LLM_USAGE_DIRNAME);
}

function usagePath(): string {
  return join(usageDir(), LLM_USAGE_TEMP_FILENAME);
}

function dayPath(day: string): string {
  return join(usageDir(), `${LLM_USAGE_DAY_PREFIX}${day}.jsonl`);
}

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/**
 * Detail persistence is off unless the config says otherwise.
 *
 * Reads the file directly from the same config dir the usage files live in
 * (rather than through the loader's module-level path) so the flag can never
 * disagree with where the records are written.
 */
export function usagePersistEnabled(): boolean {
  try {
    const raw = readFileSync(join(configDir(), 'llm-config.json'), 'utf8');
    return (JSON.parse(raw) as { usage?: { persist?: boolean } })?.usage?.persist === true;
  } catch {
    return false;
  }
}

/** Wipe the session log. Called once at startup, before the first request. */
export function clearLlmUsageTemp(): void {
  try {
    const dir = usageDir();
    if (!existsSync(dir)) return;
    writeFileSync(usagePath(), '', 'utf8');
  } catch {
    // Observability only.
  }
}

/** Detail files on disk, newest day first. */
function listDayFiles(): string[] {
  try {
    return readdirSync(usageDir())
      .filter((f) => f.startsWith(LLM_USAGE_DAY_PREFIX) && f.endsWith('.jsonl') && f !== LLM_USAGE_TEMP_FILENAME)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ============================================================================
// Write path
// ============================================================================

/**
 * Append one or more records.
 *
 * Never throws: a failed usage write must not take down a request that already
 * succeeded. Callers pass records in the order the gateway produced them.
 */
export function appendLlmUsage(records: LlmUsageRecord[]): void {
  if (records.length === 0) return;
  try {
    const dir = usageDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // One write per batch rather than per record: the gateway drains at most a
    // few records at a time and this keeps the file's line count predictable.
    const text = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
    appendFileSync(usagePath(), text, 'utf8');

    // Persistence is per record, by that record's local day — not "whatever day
    // the process started", which would keep writing into yesterday's file
    // across midnight.
    if (usagePersistEnabled()) {
      const byDay = new Map<string, string[]>();
      for (const r of records) {
        const day = localDay(r.ts);
        const list = byDay.get(day) ?? [];
        list.push(JSON.stringify(r));
        byDay.set(day, list);
      }
      for (const [day, lines] of byDay) {
        appendFileSync(dayPath(day), `${lines.join('\n')}\n`, 'utf8');
      }
      const retain = readRetainDays();
      pruneDayFiles(retain);
    }
  } catch {
    // Usage is observability, not a dependency of the request path.
  }
}

function readRetainDays(): number | undefined {
  try {
    const raw = readFileSync(join(configDir(), 'llm-config.json'), 'utf8');
    return (JSON.parse(raw) as { usage?: { retainDays?: number } })?.usage?.retainDays;
  } catch {
    return undefined;
  }
}

/** Drop day files older than `retainDays` (0/undefined = keep). */
export function pruneDayFiles(retainDays: number | undefined): void {
  if (!retainDays || retainDays <= 0) return;
  const cutoff = localDay(Date.now() - retainDays * 86_400_000);
  for (const name of listDayFiles()) {
    const day = name.slice(LLM_USAGE_DAY_PREFIX.length, -'.jsonl'.length);
    if (day < cutoff) {
      try {
        unlinkSync(join(usageDir(), name));
      } catch {
        // ignore
      }
    }
  }
}

// ============================================================================
// Read path
// ============================================================================

/**
 * Read every record, skipping malformed lines.
 *
 * A truncated final line (crash mid-append) is expected and ignored rather than
 * surfaced: losing the newest record is better than failing the whole dashboard.
 *
 * Records are de-duplicated **across sources**, not within one: with persistence
 * on, a record is appended both to the session log and to its day file, so
 * reading both returned every request twice — the log listed each one twice and
 * the overview counted its tokens twice.
 */
export function readLlmUsage(): LlmUsageRecord[] {
  // Persisted days first (oldest → newest), then the session file, so the
  // merged list stays time-ordered without a sort.
  const days = listDayFiles().reverse();
  const out: LlmUsageRecord[] = [];
  const seen = new Set<string>();
  for (const name of days) out.push(...parseLines(readFileSafe(join(usageDir(), name)), seen));
  out.push(...parseLines(readFileSafe(usagePath()), seen));
  return out;
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Parse one source, skipping lines another source already contributed.
 *
 * The comparison is on the raw line: the two files receive byte-identical
 * records, and two requests that are identical in *every* field and land in the
 * same millisecond are not distinguishable anyway — while two identical lines in
 * the *same* file are kept, because a repeated request is legitimate.
 */
function parseLines(raw: string, seen?: Set<string>): LlmUsageRecord[] {
  if (!raw) return [];
  const lines = raw.split('\n');
  const out: LlmUsageRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (seen?.has(line)) continue;
    // The last line may be a torn write; only tolerate that on the final entry.
    if (i === lines.length - 1) {
      try {
        out.push(JSON.parse(line) as LlmUsageRecord);
      } catch {
        break;
      }
      continue;
    }
    try {
      out.push(JSON.parse(line) as LlmUsageRecord);
    } catch {
      // A bad line in the middle is skipped; the rest of the history remains
      // readable, which is the point of an append-only log.
    }
  }
  if (seen) for (const l of lines) {
    const t = l.trim();
    if (t) seen.add(t);
  }
  return out;
}

/** Most recent `limit` records, oldest first. */
export function readRecentLlmUsage(limit = 200): LlmUsageRecord[] {
  const all = readLlmUsage();
  if (all.length <= limit) return all;
  return all.slice(all.length - limit);
}

// ============================================================================
// Query (log page)
// ============================================================================

export type UsageTagField = 'any' | 'provider' | 'key' | 'model' | 'status' | 'code' | 'session' | 'strategy'

/** One filter chip. Multiple chips are AND-ed. */
export interface UsageTag {
  field: UsageTagField
  value: string
}

export interface UsageQuery {
  tags?: UsageTag[]
  /** Default 'desc' (newest first). */
  sort?: 'desc' | 'asc'
  /** Maximum matches to return; the log page uses 5000. */
  limit?: number
}

export interface UsageQueryResult {
  rows: LlmUsageRecord[]
  /** True when more matches exist beyond `limit`. */
  truncated: boolean
}

function tagMatches(r: LlmUsageRecord, tag: UsageTag): boolean {
  const needle = tag.value.trim().toLowerCase()
  if (!needle) return true
  const has = (v: string | number | undefined): boolean =>
    v != null && String(v).toLowerCase().includes(needle)
  switch (tag.field) {
    case 'provider':
      return has(r.provider)
    case 'key':
      return has(r.keyId)
    case 'model':
      return has(r.upstreamModel) || has(r.publicModel)
    case 'status':
      return has(r.status)
    case 'code':
      return String(r.statusCode ?? '') === needle
    case 'session':
      return has(r.sessionId)
    case 'strategy':
      return has(r.strategy)
    case 'any':
    default:
      return (
        has(r.provider) ||
        has(r.keyId) ||
        has(r.upstreamModel) ||
        has(r.publicModel) ||
        has(r.status) ||
        has(r.statusCode) ||
        has(r.sessionId)
      )
  }
}

/**
 * Read the log from the newest record backwards and stop at `limit` matches.
 *
 * The cap applies *after* filtering on purpose: taking "the last 5000 records,
 * then filtering" would make an old record unfindable even though it matches.
 */
/**
 * Record a settings-page connection probe.
 *
 * The probe talks to the upstream directly — that is the only way to test the
 * key — so the gateway never sees it and cannot write the row itself. It is
 * still worth a log line: "when was this key last tried, and did it work?" is
 * the question the log exists to answer, and it has no other home.
 *
 * Two fields are deliberately empty:
 *
 *   `strategy` — there is no group. A probe must not appear to have been
 *                routed, or the per-group totals would count traffic the
 *                gateway never carried.
 *   `keyId`    — may be empty when the user is testing a key they have not
 *                saved yet. Never put key material here.
 *
 * Aggregates skip these rows (see `isProbe` in the aggregate module): a
 * deliberately wrong key is an *expected* failure, and counting it would drag
 * the provider's success rate down for a test that worked as intended.
 */
export function recordProbeUsage(input: {
  provider: string
  keyId?: string
  model: string
  success: boolean
  totalMs: number
  error?: string
}): void {
  appendLlmUsage([
    {
      ts: Date.now(),
      strategy: '',
      provider: input.provider,
      keyId: input.keyId ?? '',
      publicModel: input.model,
      upstreamModel: input.model,
      kind: 'connection_test',
      status: input.success ? 'success' : 'error',
      // A probe has no HTTP status of its own (the failure is often a transport
      // error before any response). 0 renders as an em dash.
      statusCode: input.success ? 200 : 0,
      attempts: 1,
      ...(input.error ? { error: input.error } : {}),
      totalMs: Math.max(0, Math.round(input.totalMs)),
    },
  ])
}

export function queryLlmUsage(query: UsageQuery = {}): UsageQueryResult {
  const limit = Math.max(1, query.limit ?? 5000)
  const tags = (query.tags ?? []).filter((t) => t.value.trim().length > 0)
  const rows: LlmUsageRecord[] = []
  let truncated = false

  const sources: string[] = [usagePath()]
  for (const name of listDayFiles()) sources.push(join(usageDir(), name))

  // With persistence on a record lands in the session log *and* in its day file,
  // so the same line is reachable from two sources. Without this the log showed
  // every request twice (and one expand click opened two identical details).
  const seen = new Set<string>()

  outer: for (const path of sources) {
    const raw = readFileSafe(path)
    if (!raw) continue
    const lines = raw.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      if (seen.has(line)) continue
      let rec: LlmUsageRecord
      try {
        rec = JSON.parse(line) as LlmUsageRecord
      } catch {
        // Torn last line (or a corrupt one) — skip it, keep walking.
        continue
      }
      if (tags.length > 0 && !tags.every((t) => tagMatches(rec, t))) continue
      if (rows.length >= limit) {
        truncated = true
        break outer
      }
      rows.push(rec)
    }
    for (const l of lines) {
      const t = l.trim()
      if (t) seen.add(t)
    }
  }

  // Sources are already newest-first, but each file is only internally ordered;
  // sort so a batch appended out of order (or a clock skew) cannot misorder rows.
  rows.sort((a, b) => b.ts - a.ts)
  if (query.sort === 'asc') rows.reverse()
  return { rows, truncated }
}
