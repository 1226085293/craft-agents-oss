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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_DIR } from './paths.ts';

// ============================================================================
// Types
// ============================================================================

/** One persisted gateway decision. Mirrors the gateway's UsageRecord. */
export interface LlmUsageRecord {
  /** Epoch milliseconds when the request finished — the day-file key. */
  ts: number;
  /**
   * Epoch milliseconds when the request was *sent*.
   *
   * `ts` is the completion stamp: a request that took 69s used to be listed at
   * the second it failed, which reads as if it had been made then. The log
   * shows this column when present and falls back to `ts` on rows written
   * before the field existed.
   */
  startedAt?: number;
  /**
   * One upstream attempt inside a longer request, kept for the log only.
   *
   * A request that failed on provider A and died on B used to produce a single
   * row (B's), so A's 60s first-byte timeout left no trace at all. Every
   * attempt now gets its own row; this flag marks the ones that were followed
   * by another attempt, so aggregates still count one outcome per request
   * instead of one per try.
   */
  superseded?: boolean;
  strategy: string;
  provider: string;
  keyId: string;
  publicModel: string;
  upstreamModel: string;
  /**
   * Switching unit that served (or died on) the request: `provider::model`.
   *
   * Recorded since units exist; absent on rows written before that, which the
   * log renders as an em dash rather than inventing a unit.
   */
  unitId?: string;
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

/**
 * True for an upstream attempt that was followed by another attempt.
 *
 * Those rows exist to show *what happened* in the log; they are not a request
 * outcome, so aggregates skip them — otherwise "failed once, then succeeded"
 * would count as one failure and one success instead of one retried success.
 */
export function isSupersededAttempt(record: LlmUsageRecord): boolean {
  return record.superseded === true
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
    // across midnight. The day follows `startedAt` when it exists: a request
    // made at 23:59 belongs to that day even if it finishes after midnight, and
    // bucketing by the completion stamp put it in a file whose rows read as
    // yesterday's time.
    if (usagePersistEnabled()) {
      const byDay = new Map<string, string[]>();
      for (const r of records) {
        const day = localDay(r.startedAt ?? r.ts);
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
  const sources = days.map((name) => join(usageDir(), name));
  sources.push(usagePath());

  // The merged result itself is cached, not only the per-file parses: the
  // cross-file de-duplication is a string key per record, which over ~50k
  // records costs more than the parse does once the parse is cached. Readers
  // get a shallow copy so a caller that sorts in place cannot reorder the cache.
  const sig = sources.map((path) => `${path}#${statSig(path) ?? '-'}`).join('\n');
  if (mergedCache?.sig === sig) return mergedCache.records.slice();

  const out: LlmUsageRecord[] = [];
  const seen = new Set<string>();
  for (const path of sources) {
    // Keys are collected per file and merged afterwards on purpose: a repeated
    // request inside *one* file is legitimate and must survive, while the copy
    // of it in the other file must not.
    const local = new Set<string>();
    for (const rec of parsedFile(path)) {
      if (!rec) continue;
      const key = recordKey(rec);
      // Only a key contributed by a *previous* source is a duplicate: the same
      // request repeated inside one file is legitimate.
      if (seen.has(key)) continue;
      local.add(key);
      out.push(rec);
    }
    for (const key of local) seen.add(key);
  }
  pruneFileCache(sources);
  mergedCache = { sig, records: out };
  return out.slice();
}

let mergedCache: { sig: string; records: LlmUsageRecord[] } | null = null;

// ============================================================================
// Parse cache
// ============================================================================

/**
 * Records of one already-parsed file, keyed by its stat signature.
 *
 * Both readers used to `readFileSync` + `JSON.parse` every line of every file
 * per call. With ~50k records and 28 MB on disk that cost ~220 ms of *synchronous*
 * work per call, and the settings page calls the read path once per provider
 * (15 of them) on mount while the log view polls every 3 s — seconds of a
 * blocked main process, which is what made the page feel frozen.
 *
 * Files are append-only, so a file whose size/mtime/inode did not change cannot
 * have new records: the parsed array is safe to reuse. Inode and ctime are part
 * of the signature so a file recreated at the same size (tests, a pruned and
 * re-written day file) is never mistaken for the cached one.
 */
interface ParsedFile {
  sig: string
  /** Index-aligned with the file's lines; `null` = blank or unparseable line. */
  records: Array<LlmUsageRecord | null>
}

const parsedFiles = new Map<string, ParsedFile>()
let cachedLines = 0
/** Bound on retained parsed lines, so a long history cannot grow unbounded. */
const MAX_CACHED_LINES = 200_000

function statSig(path: string): string | null {
  try {
    const st = statSync(path)
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`
  } catch {
    return null
  }
}

/** Parsed records of one source, parsing only when the file actually changed. */
function parsedFile(path: string): Array<LlmUsageRecord | null> {
  const sig = statSig(path)
  if (sig === null) return []
  const hit = parsedFiles.get(path)
  if (hit && hit.sig === sig) {
    // Re-insert to keep Map order ≈ least-recently-used first.
    parsedFiles.delete(path)
    parsedFiles.set(path, hit)
    return hit.records
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n')
  const records = new Array<LlmUsageRecord | null>(lines.length).fill(null)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    try {
      records[i] = JSON.parse(line) as LlmUsageRecord
    } catch {
      // A torn final line (crash mid-append) or a corrupt one in the middle:
      // losing that record beats failing the whole dashboard.
    }
  }
  if (hit) cachedLines -= hit.records.length
  cachedLines += records.length
  parsedFiles.set(path, { sig, records })
  evictParsedFiles()
  return records
}

function evictParsedFiles(): void {
  for (const [path, entry] of parsedFiles) {
    if (cachedLines <= MAX_CACHED_LINES) return
    parsedFiles.delete(path)
    cachedLines -= entry.records.length
  }
}

/** Forget entries for files that no longer exist (a pruned day file). */
function pruneFileCache(live: ReadonlyArray<string>): void {
  if (parsedFiles.size <= live.length) return
  const keep = new Set(live)
  for (const [path, entry] of parsedFiles) {
    if (keep.has(path)) continue
    parsedFiles.delete(path)
    cachedLines -= entry.records.length
  }
}

/**
 * Cross-file identity of one record.
 *
 * The two sinks receive byte-identical JSON for the same request, so any
 * faithful field signature identifies the copy. Derived from the record rather
 * than the raw line so the cache does not have to retain 28 MB of source text
 * just to de-duplicate against it.
 */
function recordKey(r: LlmUsageRecord): string {
  return `${r.ts}|${r.startedAt ?? ''}|${r.provider}|${r.keyId}|${r.publicModel}|${r.upstreamModel}|${r.status}|${r.statusCode}|${r.attempts ?? ''}|${r.totalMs ?? ''}|${r.promptTokens ?? ''}|${r.completionTokens ?? ''}|${r.error ?? ''}`
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
    const records = parsedFile(path)
    // Per-file keys, merged after the file: a repeated identical request inside
    // one file is kept, its copy in the other sink is not.
    const local = new Set<string>()
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i]
      if (!rec) continue
      const key = recordKey(rec)
      if (seen.has(key)) { local.add(key); continue }
      local.add(key)
      if (tags.length > 0 && !tags.every((t) => tagMatches(rec, t))) continue
      if (rows.length >= limit) {
        truncated = true
        break outer
      }
      rows.push(rec)
    }
    for (const key of local) seen.add(key)
  }
  pruneFileCache(sources)

  // Sources are already newest-first, but each file is only internally ordered;
  // sort so a batch appended out of order (or a clock skew) cannot misorder rows.
  // The time column is the start stamp, so the sort follows it: a 69s request
  // that ended last must not jump above a request sent after it began. Rows
  // sharing a start (the attempts of one request) fall back to completion
  // order, so the final outcome sits above the attempts it superseded.
  const at = (r: LlmUsageRecord): number => r.startedAt ?? r.ts
  rows.sort((a, b) => at(b) - at(a) || b.ts - a.ts)
  if (query.sort === 'asc') rows.reverse()
  return { rows, truncated }
}
