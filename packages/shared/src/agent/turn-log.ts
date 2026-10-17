/**
 * Turn Log Archiver
 *
 * Rebuilds per-turn Markdown archives from the two live session records so
 * that (a) the agent can re-read a full turn's history from disk instead of
 * the conversation context, and (b) debugging has a durable per-turn record.
 *
 * Data sources:
 * - progress.jsonl  (ProgressRecord): user_request / guidance / tool_start /
 *   tool_result / conclusion. Result summaries here are truncated at 1200
 *   chars at write time, and the file itself rotates (1MB / 1024 records) —
 *   a rolling window, NOT a full archive.
 * - session.jsonl   (StoredMessage): full tool results (toolResult) and the
 *   final assistant bubbles (type 'assistant', isIntermediate=false).
 *
 * Turn boundaries (user-confirmed rules):
 * - A turn STARTS at a REAL user message: after stripping
 *   <system-reminder>…</system-reminder> blocks the remainder must be
 *   non-empty, not pure punctuation, and not start with
 *   "Continue the previous user request that was interrupted" (system
 *   recovery injection).
 * - Errors / user aborts / compactions / recovery injections do NOT split a
 *   turn. Recovery injections and empty messages are recorded in the current
 *   turn's "## Interruptions" section.
 * - A turn may contain MULTIPLE assistant bubbles (mid-turn user guidance can
 *   trigger several final replies). All non-intermediate bubbles are kept.
 *
 * Write model: append-only. Each turn is written to its own file
 * `turns/{startIso-compact}-{index}.md`; an existing file is never
 * overwritten, which makes the archiver idempotent and crash-safe.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLocalTime } from '../memory/injector.ts';
import type { ProgressRecord } from './progress-journal.ts';

// ============================================================================
// Message classification
// ============================================================================

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const RECOVERY_INJECTION_RE = /^Continue the previous user request that was interrupted\b/i;
const PURE_PUNCTUATION_RE = /^[\s\u3000.,。，、;；:：!！?？'"'‘’“”`~·…—\-_()（）\[\]【】]+$/;

/**
 * Is this user_request record a REAL user message (turn boundary), or a
 * system injection that belongs inside the current turn?
 *
 * System injections seen in the wild:
 *  1. "Continue the previous user request that was interrupted by an
 *     application restart or agent shutdown.\n\nOriginal user request:\n…"
 *  2. "." (empty message after a user abort)
 *  3. "<real intent>\n\n<system-reminder>The previous assistant response was
 *     interrupted…</system-reminder>" — REAL: the remainder after stripping
 *     the reminder block is the user's actual input.
 */
export function isRealUserMessage(text: string | undefined | null): boolean {
  const stripped = (text ?? '').replace(SYSTEM_REMINDER_RE, '').trim();
  if (!stripped) return false;
  if (PURE_PUNCTUATION_RE.test(stripped)) return false;
  if (RECOVERY_INJECTION_RE.test(stripped)) return false;
  return true;
}

// ============================================================================
// Data model
// ============================================================================

/** Structural subset of StoredMessage — keeps this module decoupled. */
export interface TurnSessionMessage {
  type?: string;
  content?: string;
  timestamp?: number;
  isIntermediate?: boolean;
  toolName?: string;
  toolUseId?: string;
  toolResult?: string;
  isError?: boolean;
}

export interface TurnToolCall {
  callId: string;
  toolName: string;
  argsSummary: string;
  startedIso: string;
  endedIso?: string;
  durationMs?: number;
  isError?: boolean;
  /** Best available result text. */
  resultText?: string;
  /** Where resultText came from — drives the inline marker. */
  resultSource: 'full' | 'summary' | 'none';
}

export interface TurnLogData {
  /** 1-based index among REAL turns in the session. */
  turnIndex: number;
  /** ISO timestamp of the turn's first user_request record. */
  turnStartIso: string;
  /** ISO timestamp of the next real user_request (null while turn is open). */
  turnEndIso: string | null;
  userMessage: string;
  guidance: Array<{ iso: string; text: string }>;
  interruptions: Array<{ iso: string; text: string }>;
  tools: TurnToolCall[];
  assistantReplies: Array<{ iso: string; text: string }>;
  conclusions: Array<{ iso: string; text: string }>;
}

// ============================================================================
// Turn extraction
// ============================================================================

function toMs(ts: string | number | undefined): number | null {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string' && ts) {
    const ms = Date.parse(ts);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function fmtDuration(startIso: string, endIso: string): number | undefined {
  const s = toMs(startIso);
  const e = toMs(endIso);
  if (s == null || e == null || e < s) return undefined;
  return e - s;
}

/**
 * Split the raw progress ledger into per-turn logs and enrich tool results
 * with full text from session.jsonl. Pure — no file I/O.
 *
 * @param progressRecords  Raw progress.jsonl records (in order).
 * @param sessionMessages  Raw session.jsonl messages (tool full results +
 *                         assistant bubbles).
 */
export function buildTurnLogs(
  progressRecords: ProgressRecord[],
  sessionMessages: TurnSessionMessage[],
): TurnLogData[] {
  const sessionTools = new Map<string, TurnSessionMessage>();
  const sessionAssistant: Array<{ ms: number; text: string }> = [];
  for (const m of sessionMessages) {
    if (m.type === 'tool' && m.toolUseId) sessionTools.set(m.toolUseId, m);
    else if (m.type === 'assistant' && !m.isIntermediate && typeof m.content === 'string' && m.content) {
      const ms = toMs(m.timestamp);
      if (ms != null) sessionAssistant.push({ ms, text: m.content });
    }
  }
  sessionAssistant.sort((a, b) => a.ms - b.ms);

  const turns: TurnLogData[] = [];
  let current: TurnLogData | null = null;
  const toolStarts = new Map<string, { record: ProgressRecord }>();

  const closeTurn = () => {
    if (!current) return;
    turns.push(current);
    current = null;
    toolStarts.clear();
  };

  for (const rec of progressRecords) {
    if (rec.kind === 'user_request') {
      if (isRealUserMessage(rec.text)) {
        // The new real message closes the previous turn's time window.
        if (current) current.turnEndIso = rec.timestamp;
        closeTurn();
        current = {
          turnIndex: turns.length + 1,
          turnStartIso: rec.timestamp,
          turnEndIso: null,
          userMessage: rec.text ?? '',
          guidance: [],
          interruptions: [],
          tools: [],
          assistantReplies: [],
          conclusions: [],
        };
      } else if (current && rec.text) {
        // System injection mid-session (recovery / abort artifact) — belongs
        // to the current turn, recorded as an interruption.
        current.interruptions.push({ iso: rec.timestamp, text: rec.text });
      }
      // A system injection before any real turn is unattributable — skip.
      continue;
    }

    if (!current) continue;

    switch (rec.kind) {
      case 'guidance':
        if (rec.text) current.guidance.push({ iso: rec.timestamp, text: rec.text });
        break;
      case 'tool_start':
        if (rec.callId) toolStarts.set(rec.callId, { record: rec });
        break;
      case 'tool_result': {
        const callId = rec.callId ?? '';
        const start = callId ? toolStarts.get(callId) : undefined;
        const startedIso = start?.record.timestamp ?? rec.timestamp;
        const durationMs = start ? fmtDuration(startedIso, rec.timestamp) : undefined;
        const full = callId ? sessionTools.get(callId) : undefined;
        const tool: TurnToolCall = {
          callId,
          toolName: rec.toolName ?? 'tool',
          argsSummary: start?.record.argsSummary ?? '',
          startedIso,
          endedIso: rec.timestamp,
          durationMs,
          isError: rec.isError,
          resultSource: 'none',
        };
        if (full?.toolResult) {
          tool.resultText = full.toolResult;
          tool.resultSource = 'full';
        } else if (rec.resultSummary) {
          tool.resultText = rec.resultSummary;
          tool.resultSource = 'summary';
        } else {
          tool.resultSource = 'none';
        }
        current.tools.push(tool);
        break;
      }
      case 'conclusion':
        if (rec.text) current.conclusions.push({ iso: rec.timestamp, text: rec.text });
        break;
    }
  }
  closeTurn();

  // Attribute assistant bubbles by turn time window. The last (open) turn's
  // window ends at +Infinity so its bubbles land in it regardless.
  for (const turn of turns) {
    const startMs = toMs(turn.turnStartIso);
    const endMs = turn.turnEndIso ? toMs(turn.turnEndIso) : null;
    if (startMs == null) continue;
    for (const a of sessionAssistant) {
      if (a.ms < startMs) continue;
      if (endMs != null && a.ms >= endMs) continue;
      turn.assistantReplies.push({ iso: new Date(a.ms).toISOString(), text: a.text });
    }
  }

  return turns;
}

// ============================================================================
// Rendering
// ============================================================================

function fmtDurationShort(ms: number | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function esc(text: string): string {
  return text.replace(/```/g, '``\u200b`');
}

/**
 * Render one turn as Markdown. Pure — no file I/O.
 */
export function renderTurnLog(turn: TurnLogData): string {
  const lines: string[] = [];
  const startLocal = formatLocalTime(turn.turnStartIso);
  lines.push(`# Turn ${turn.turnIndex} — ${startLocal}`);
  lines.push('');
  lines.push('## User message');
  lines.push('');
  lines.push(turn.userMessage);
  lines.push('');

  if (turn.guidance.length > 0) {
    lines.push('## Mid-turn guidance');
    lines.push('');
    turn.guidance.forEach((g, i) => {
      lines.push(`${i + 1}. \`${formatLocalTime(g.iso)}\` — ${g.text}`);
    });
    lines.push('');
  }

  if (turn.interruptions.length > 0) {
    lines.push('## Interruptions');
    lines.push('');
    turn.interruptions.forEach((it, i) => {
      lines.push(`${i + 1}. \`${formatLocalTime(it.iso)}\` — ${it.text}`);
    });
    lines.push('');
  }

  if (turn.tools.length > 0) {
    lines.push('## Process blocks');
    lines.push('');
    turn.tools.forEach((t, i) => {
      const dur = fmtDurationShort(t.durationMs);
      const head = [t.toolName, t.argsSummary, dur && `\`${formatLocalTime(t.startedIso)}\`, ${dur}`]
        .filter(Boolean)
        .join(' — ');
      lines.push(`### ${i + 1}. ${head}`);
      lines.push('');
      if (t.resultText) {
        if (t.resultSource !== 'full') {
          lines.push(`> result source: ${t.resultSource === 'summary' ? 'truncated summary (full text unavailable)' : 'none'}`);
          lines.push('');
        }
        lines.push('```text');
        lines.push(esc(t.resultText));
        lines.push('```');
        lines.push('');
      } else if (t.isError) {
        lines.push('(error — no result text captured)');
        lines.push('');
      }
    });
  }

  if (turn.assistantReplies.length > 0) {
    lines.push('## Assistant replies');
    lines.push('');
    turn.assistantReplies.forEach((a, i) => {
      lines.push(`### Reply ${i + 1} — \`${formatLocalTime(a.iso)}\``);
      lines.push('');
      lines.push(a.text);
      lines.push('');
    });
  }

  if (turn.conclusions.length > 0) {
    lines.push('## Conclusion');
    lines.push('');
    turn.conclusions.forEach((c, i) => {
      lines.push(`${i + 1}. \`${formatLocalTime(c.iso)}\` — ${c.text}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Writing
// ============================================================================

/** Directory holding per-turn archive files. */
export function getTurnLogsDir(sessionDir: string): string {
  return join(sessionDir, 'turns');
}

/**
 * Windows-safe file name: `{turnStart compact ISO}-{3-digit index}.md`.
 * Colons are replaced with dashes (illegal in Windows file names); the index
 * keeps same-second starts unique and preserves turn order for sorting.
 */
export function turnLogFileName(turn: TurnLogData): string {
  const compact = turn.turnStartIso.slice(0, 19).replace(/:/g, '-');
  return `${compact}-${String(turn.turnIndex).padStart(3, '0')}.md`;
}

/**
 * Write turn logs to `sessions/{id}/turns/`. Append-only: existing files are
 * never overwritten, so re-running the archiver is a no-op for already
 * archived turns. Best-effort — a failed write must never break the agent.
 *
 * @returns Number of files newly written.
 */
export function writeTurnLogs(sessionDir: string, turns: TurnLogData[]): number {
  if (turns.length === 0) return 0;
  let written = 0;
  try {
    const dir = getTurnLogsDir(sessionDir);
    mkdirSync(dir, { recursive: true });
    for (const turn of turns) {
      const path = join(dir, turnLogFileName(turn));
      if (existsSync(path)) continue;
      writeFileSync(path, renderTurnLog(turn), 'utf-8');
      written++;
    }
  } catch (err) {
    console.warn('[TurnLog] Failed to write turn logs:', err);
  }
  return written;
}
