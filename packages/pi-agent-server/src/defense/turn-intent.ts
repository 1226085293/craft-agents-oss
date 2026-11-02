/**
 * turn-intent.ts
 *
 * Builds what the verification judge is allowed to treat as the user's
 * requirement, from the CANONICAL transcript (session.jsonl) instead of the
 * rolling progress ledger.
 *
 * Why not the ledger (2026-11-01 quiet-jasmine):
 * `loadLatestUserRequest()` reads progress.jsonl, a bounded rolling window.
 * When the current turn's `user_request` record is evicted by rotation, the
 * reader silently falls back to the PREVIOUS turn's request (plus that turn's
 * guidance) and the judge then rejects a perfectly good reply for "not
 * covering" an item the user asked about one turn earlier — twice, in the
 * reported incident. session.jsonl is append-only and never rotated, so it is
 * the right source of truth for "what did the user ask, in which turn".
 *
 * Turn model (mirrors `packages/shared/src/agent/turn-log.ts`, which renders
 * the per-turn `turns/*.md` archives):
 * - A turn STARTS at a REAL user message — `type: 'user'` without
 *   `isGuidance`, whose text survives isRealUserMessage() (system recovery
 *   injections and punctuation-only abort artifacts do not split a turn).
 * - A turn may carry MID-TURN GUIDANCE: `type: 'user'` + `isGuidance: true`
 *   (the main process tags mid-stream steers this way). Guidance belongs to
 *   the SAME turn and is part of its requirements — the judge sees the turn's
 *   user messages as ONE ordered list.
 * - A turn's delivered reply is the last non-intermediate assistant bubble.
 *
 * The judge gets: the CURRENT turn (authoritative) + up to three PREVIOUS
 * turns marked reference-only, so it can resolve references ("那个方案",
 * "继续") without ever demanding a previous turn's item again.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRealUserMessage } from '../../../shared/src/agent/turn-log.ts';
import type { JudgeHistoryTurn, JudgeTurnContext, JudgeTurnEntry } from './judge-prompt.ts';

/** Structural subset of the session.jsonl records we consume. */
export interface TranscriptMessage {
  type?: string;
  content?: string;
  timestamp?: number;
  isIntermediate?: boolean;
  isGuidance?: boolean;
}

export interface TranscriptTurn {
  /** The turn's user messages in order: opening request, then mid-turn guidance. */
  messages: JudgeTurnEntry[];
  /** Non-intermediate assistant bubbles, in order (last = delivered reply). */
  replies: JudgeTurnEntry[];
}

/** How many previous turns the judge may see (user spec: 前三轮). */
export const DEFAULT_JUDGE_HISTORY_TURNS = 3;

/**
 * Tail window used to avoid reading a multi-megabyte transcript. Most turns
 * fit in 4 MB, but a single tool-heavy turn can exceed it (measured: 1 of 340
 * turns reached 4.47 MB), which would cut the current turn's opening message
 * out of the window. The reader therefore grows the window until it holds
 * enough turns, up to a hard cap.
 */
const TRANSCRIPT_INITIAL_TAIL_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_MAX_TAIL_BYTES = 64 * 1024 * 1024;

function isoOf(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Split transcript messages into turns. Pure — no I/O, unit-testable.
 */
export function buildTurnsFromMessages(messages: TranscriptMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;

  for (const message of messages) {
    if (message.type === 'user') {
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (message.isGuidance) {
        // Mid-turn steer: belongs to the turn that is already open.
        if (current && text) current.messages.push({ at: isoOf(message.timestamp), text, guidance: true });
        continue;
      }
      if (!isRealUserMessage(text)) continue; // recovery injection / abort artifact
      current = { messages: [{ at: isoOf(message.timestamp), text }], replies: [] };
      turns.push(current);
      continue;
    }
    if (message.type === 'assistant' && !message.isIntermediate) {
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (current && text) current.replies.push({ at: isoOf(message.timestamp), text });
    }
  }

  return turns;
}

/**
 * Read a JSONL file's tail and parse the object records it contains. The first
 * line of a tail read is usually a partial record and is dropped when the read
 * did not start at byte 0.
 */
function readJsonlTail(filePath: string, maxBytes = TRANSCRIPT_INITIAL_TAIL_BYTES): TranscriptMessage[] {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return [];
  }
  if (size <= 0) return [];

  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.allocUnsafe(length);
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    readSync(fd, buffer, 0, length, start);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort — a failed close must not break verification.
      }
    }
  }

  const text = buffer.toString('utf8');
  // A non-zero start cuts the first record in half; drop it.
  const body = start > 0 ? text.slice(text.indexOf('\n') + 1 || text.length) : text;
  const messages: TranscriptMessage[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TranscriptMessage;
      if (parsed && typeof parsed === 'object') messages.push(parsed);
    } catch {
      // Tolerate a torn trailing line (the writer is mid-append).
    }
  }
  return messages;
}

/** Loose equality: the transcript copy and the prompt may differ by wrappers. */
function sameUserMessage(fromTranscript: string, fromPrompt: string): boolean {
  const a = fromTranscript.replace(/\s+/g, ' ').trim();
  const b = fromPrompt.replace(/\s+/g, ' ').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const head = (value: string): string => value.slice(0, 120);
  return a.length >= 20 && b.length >= 20 && (a.includes(head(b)) || b.includes(head(a)));
}

function toHistoryTurn(turn: TranscriptTurn): JudgeHistoryTurn {
  const reply = turn.replies.length > 0 ? turn.replies[turn.replies.length - 1] : undefined;
  return { messages: turn.messages, reply };
}

/**
 * Load the judge's turn context for the CURRENT turn.
 *
 * @param sessionDir  Session directory (contains session.jsonl).
 * @param fallbackUserMessage  The prompt this subprocess received for the
 *        current turn. Authoritative when the transcript lags behind (the main
 *        process persists asynchronously) — that mismatch is exactly how the
 *        old ledger path degraded into the previous turn's request.
 * @param maxHistoryTurns  Previous turns to include (default 3).
 */
export function loadJudgeTurnContext(opts: {
  sessionDir?: string | null;
  fallbackUserMessage?: string;
  maxHistoryTurns?: number;
}): JudgeTurnContext {
  const maxHistory = Math.max(0, opts.maxHistoryTurns ?? DEFAULT_JUDGE_HISTORY_TURNS);
  const promptText = (opts.fallbackUserMessage ?? '').trim();
  const transcriptPath = opts.sessionDir ? join(opts.sessionDir, 'session.jsonl') : null;

  // Grow the window until it contains this turn plus the reference turns (or
  // the file is exhausted). Without this, one oversized turn would hide its
  // own opening message and its early guidance from the judge.
  const wanted = maxHistory + 2; // current turn (+1 slack for a cut first turn)
  let turns: TranscriptTurn[] = [];
  for (let window = TRANSCRIPT_INITIAL_TAIL_BYTES; transcriptPath; window *= 4) {
    turns = buildTurnsFromMessages(readJsonlTail(transcriptPath, window));
    if (turns.length >= wanted || window >= TRANSCRIPT_MAX_TAIL_BYTES) break;
    try {
      if (statSync(transcriptPath).size <= window) break;
    } catch {
      break;
    }
  }

  const last = turns.length > 0 ? turns[turns.length - 1]! : undefined;
  const lastIsCurrentTurn = !!last && !!promptText && sameUserMessage(last.messages[0]?.text ?? '', promptText);

  if (lastIsCurrentTurn) {
    return {
      current: last!.messages,
      history: turns.slice(Math.max(0, turns.length - 1 - maxHistory), turns.length - 1).map(toHistoryTurn),
    };
  }

  if (promptText) {
    // Transcript lagged (or the turn is not persisted yet): the prompt is the
    // current turn; every parsed turn becomes history.
    return {
      current: [{ text: promptText }],
      history: turns.slice(Math.max(0, turns.length - maxHistory)).map(toHistoryTurn),
    };
  }

  if (last) {
    return {
      current: last.messages,
      history: turns.slice(Math.max(0, turns.length - 1 - maxHistory), turns.length - 1).map(toHistoryTurn),
    };
  }

  return { current: [] };
}
