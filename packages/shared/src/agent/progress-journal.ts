import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE_NAME = 'progress.jsonl';
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_RECORDS = 1_024;
const MAX_REQUEST_CHARS = 32_000;
const MAX_ARGS_CHARS = 800;
const MAX_RESULT_CHARS = 1_200;
const MAX_CONCLUSION_CHARS = 1_600;
const SNAPSHOT_ITEMS = 12;
const RETENTION_HYSTERESIS_RATIO = 0.7;

export interface ProgressJournalOptions {
  maxBytes?: number;
  maxRecords?: number;
}

interface ProgressRecord {
  version: 1;
  timestamp: string;
  kind: 'user_request' | 'guidance' | 'tool_start' | 'tool_result' | 'conclusion';
  text?: string;
  callId?: string;
  toolName?: string;
  argsSummary?: string;
  resultSummary?: string;
  isError?: boolean;
}

interface ToolSnapshot {
  callId: string;
  toolName: string;
  argsSummary: string;
  resultSummary?: string;
  isError?: boolean;
  repeats: number;
}

/**
 * Session-scoped append-only progress ledger. Records deliberately contain
 * bounded summaries rather than raw tool payloads; tool results correlate by
 * call ID so parallel same-name calls cannot overwrite one another.
 */
export class ProgressJournal {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private records: ProgressRecord[];

  constructor(sessionDir: string, options: ProgressJournalOptions = {}) {
    this.filePath = join(sessionDir, FILE_NAME);
    this.maxBytes = Math.max(1_024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxRecords = Math.max(2, options.maxRecords ?? DEFAULT_MAX_RECORDS);
    try {
      mkdirSync(sessionDir, { recursive: true });
      this.records = readRecords(this.filePath);
      this.trimToLimits();
    } catch {
      // Progress persistence is best-effort; a read-only/full disk must not
      // prevent the agent from starting or completing a turn.
      this.records = [];
    }
  }

  recordUserRequest(text: string): void {
    // System-owned anchors never replace the latest real user request, even
    // if a continuation arrives through the prompt path after compaction.
    if (text.startsWith('[SYSTEM PROGRESS ANCHOR')) return;
    this.append({ kind: 'user_request', text: boundedRedactedText(text, MAX_REQUEST_CHARS) });
  }

  recordGuidance(text: string): void {
    // The anchor itself is delivered through the same steer channel as user
    // guidance. Never persist this system-owned message as new user intent.
    if (text.startsWith('[SYSTEM PROGRESS ANCHOR')) return;
    const guidance = boundedRedactedText(text, MAX_REQUEST_CHARS);
    if (!guidance) return;
    this.append({ kind: 'guidance', text: guidance });
  }

  recordToolStart(input: { callId: string; toolName: string; argsSummary: string }): void {
    if (!input.callId) return;
    this.append({
      kind: 'tool_start',
      callId: boundedRedactedText(input.callId, 200),
      toolName: boundedRedactedText(input.toolName, 160),
      argsSummary: boundedRedactedText(input.argsSummary, MAX_ARGS_CHARS),
    });
  }

  recordToolResult(input: { callId: string; toolName: string; resultSummary: string; isError?: boolean }): void {
    if (!input.callId) return;
    this.append({
      kind: 'tool_result',
      callId: boundedRedactedText(input.callId, 200),
      toolName: boundedRedactedText(input.toolName, 160),
      resultSummary: boundedRedactedText(input.resultSummary, MAX_RESULT_CHARS),
      isError: input.isError === true,
    });
  }

  recordConclusion(text: string): void {
    const safe = boundedRedactedText(text, MAX_CONCLUSION_CHARS);
    if (safe) this.append({ kind: 'conclusion', text: safe });
  }

  latestUserRequest(): string | undefined {
    const diskRequest = latestRequestFromRecords(readRecords(this.filePath));
    return diskRequest ?? latestRequestFromRecords(this.records);
  }

  recentSnapshot(): string {
    const diskRecords = readRecords(this.filePath);
    return renderProgressSnapshot(diskRecords.length > 0 ? diskRecords : this.records);
  }

  private append(input: Omit<ProgressRecord, 'version' | 'timestamp'>): void {
    const record: ProgressRecord = {
      version: 1,
      timestamp: new Date().toISOString(),
      ...input,
    };
    this.records.push(record);
    try {
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
      this.trimToLimits();
    } catch {
      // Fail open if the ledger becomes unavailable mid-session. Keep only a
      // bounded memory fallback; normal agent work must continue.
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  private trimToLimits(): void {
    const currentBytes = statSize(this.filePath);
    if (currentBytes <= this.maxBytes && this.records.length <= this.maxRecords) return;

    const targetBytes = Math.floor(this.maxBytes * RETENTION_HYSTERESIS_RATIO);
    const targetRecords = Math.max(1, Math.floor(this.maxRecords * RETENTION_HYSTERESIS_RATIO));
    const latestRequest = [...this.records].reverse().find((record) => record.kind === 'user_request');
    const latestRequestIndex = latestRequest ? this.records.lastIndexOf(latestRequest) : -1;
    const latestGuidance = latestRequestIndex >= 0
      ? this.records.slice(latestRequestIndex + 1).reverse().find((record) => record.kind === 'guidance')
      : undefined;
    const protectedRecords = new Set([latestRequest, latestGuidance].filter((record): record is ProgressRecord => !!record));
    const recentRecords = this.records.filter((record) => !protectedRecords.has(record)).slice(-targetRecords);
    let retained = [
      ...(latestRequest ? [latestRequest] : []),
      ...recentRecords,
      ...(latestGuidance ? [latestGuidance] : []),
    ];

    while (retained.length > protectedRecords.size && Buffer.byteLength(serializeRecords(retained)) > targetBytes) {
      const removableIndex = retained.findIndex((record) => !protectedRecords.has(record));
      if (removableIndex < 0) break;
      retained.splice(removableIndex, 1);
    }

    if (Buffer.byteLength(serializeRecords(retained)) > this.maxBytes) {
      retained = retained.map((record) => fitRecordToByteLimit(record, this.maxBytes));
      while (retained.length > protectedRecords.size && Buffer.byteLength(serializeRecords(retained)) > this.maxBytes) {
        const removableIndex = retained.findIndex((record) => !protectedRecords.has(record));
        if (removableIndex < 0) break;
        retained.splice(removableIndex, 1);
      }
      if (Buffer.byteLength(serializeRecords(retained)) > this.maxBytes) {
        retained = retained.map((record) => fitRecordToByteLimit(record, Math.floor(this.maxBytes / retained.length)));
      }
    }

    const serialized = serializeRecords(retained);
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, serialized, 'utf8');
    renameSync(tempPath, this.filePath);
    this.records = retained;
  }
}

/** Create a deterministic history-recovery instruction for compaction anchors. */
export function buildHistoryRecoveryPointer(sessionJsonlPath: string): string {
  return `The full conversation before compaction is persisted at ${sessionJsonlPath}. If this handoff lacks a needed detail, first search/read that file with Read or grep; do not redo completed work.`;
}

/** Read a session's persisted progress ledger without constructing a writer. */
export function loadProgressSnapshot(sessionDir: string, maxChars = 6_000): string {
  return renderProgressSnapshot(readRecords(join(sessionDir, FILE_NAME)), maxChars);
}

export function loadLatestUserRequest(sessionDir: string): string | undefined {
  return latestRequestFromRecords(readRecords(join(sessionDir, FILE_NAME)));
}

function latestRequestFromRecords(records: ProgressRecord[]): string | undefined {
  let request: string | undefined;
  let latestGuidance: string | undefined;
  for (const record of records) {
    if (record.kind === 'user_request') {
      request = record.text;
      latestGuidance = undefined;
    } else if (record.kind === 'guidance' && request && record.text) {
      latestGuidance = record.text;
    }
  }
  if (!request || !latestGuidance) return request;
  const suffix = `\n\nLatest mid-turn user guidance (retain alongside the original request):\n${latestGuidance}`;
  return request.slice(0, Math.max(0, MAX_REQUEST_CHARS - suffix.length)) + suffix;
}

function renderProgressSnapshot(records: ProgressRecord[], maxChars = 6_000): string {
  const tools = new Map<string, ToolSnapshot>();
  const conclusions: string[] = [];
  for (const record of records) {
    if (record.kind === 'tool_start' && record.callId) {
      tools.set(record.callId, {
        callId: record.callId,
        toolName: record.toolName || 'tool',
        argsSummary: record.argsSummary || '',
        repeats: 1,
      });
    } else if (record.kind === 'tool_result' && record.callId) {
      const entry = tools.get(record.callId);
      if (entry) {
        entry.resultSummary = record.resultSummary || '(no output)';
        entry.isError = record.isError;
      }
    } else if (record.kind === 'conclusion' && record.text) {
      conclusions.push(record.text);
    }
  }

  const compacted: ToolSnapshot[] = [];
  for (const entry of tools.values()) {
    const previous = compacted[compacted.length - 1];
    if (entry.resultSummary !== undefined && previous && previous.resultSummary !== undefined &&
        previous.toolName === entry.toolName && previous.argsSummary === entry.argsSummary &&
        previous.resultSummary === entry.resultSummary && previous.isError === entry.isError) {
      previous.repeats += entry.repeats;
    } else {
      compacted.push({ ...entry });
    }
  }
  const lines = compacted.slice(-SNAPSHOT_ITEMS).map((entry) => {
    const call = `${entry.toolName} ${entry.argsSummary}`.trim();
    const result = entry.resultSummary ?? '(still in progress; result not recorded)';
    const repeats = entry.repeats > 1 ? ` (${entry.repeats} identical executions)` : '';
    return `- already executed: ${call} → ${result}${entry.isError ? ' [FAILED]' : ''}${repeats}`;
  });
  for (const conclusion of conclusions.slice(-3)) lines.push(`- confirmed conclusion: ${conclusion}`);
  const selected: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const cost = line.length + (selected.length ? 1 : 0);
    if (used + cost > maxChars) {
      if (selected.length === 0) selected.unshift(line.slice(0, maxChars));
      break;
    }
    selected.unshift(line);
    used += cost;
  }
  return selected.join('\n');
}

function readRecords(filePath: string): ProgressRecord[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line): ProgressRecord[] => {
        try {
          const record = JSON.parse(line) as ProgressRecord;
          return record?.version === 1 && typeof record.kind === 'string' ? [record] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function serializeRecords(records: ProgressRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}

function fitRecordToByteLimit(record: ProgressRecord, maxBytes: number): ProgressRecord {
  const fitted = { ...record };
  const fields = ['text', 'resultSummary', 'argsSummary', 'toolName', 'callId'] as const;
  for (const field of fields) {
    const value = fitted[field];
    if (!value || Buffer.byteLength(`${JSON.stringify(fitted)}\n`) <= maxBytes) continue;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      fitted[field] = value.slice(0, mid) as never;
      if (Buffer.byteLength(`${JSON.stringify(fitted)}\n`) <= maxBytes) low = mid;
      else high = mid - 1;
    }
    fitted[field] = value.slice(0, low) as never;
  }
  return fitted;
}

function statSize(filePath: string): number {
  try { return statSync(filePath).size; } catch { return 0; }
}

function boundedRedactedText(value: string, maxChars: number): string {
  return redactProgressText(String(value ?? '')).slice(0, maxChars);
}

/** Redact common credential forms before any text reaches the session ledger. */
function redactProgressText(text: string): string {
  return text
    .replace(/("?(?:api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|token|secret|password|authorization|credential)"?\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]');
}
