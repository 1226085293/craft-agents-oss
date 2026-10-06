import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  API_ERROR_HISTORY_LIMIT,
  getLastApiError,
  getLastErrorFromHistory,
  peekStoredError,
  setStoredError,
  appendErrorToHistory,
  readErrorHistory,
  formatErrorHistoryEntry,
  toolMetadataStore,
  type LastApiError,
} from '../interceptor-common.ts';

describe('interceptor-common', () => {
  let sessionDirA: string;
  let sessionDirB: string;

  beforeEach(() => {
    sessionDirA = mkdtempSync(join(tmpdir(), 'interceptor-a-'));
    sessionDirB = mkdtempSync(join(tmpdir(), 'interceptor-b-'));
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDirA, { recursive: true, force: true });
    rmSync(sessionDirB, { recursive: true, force: true });
  });

  it('keeps API errors session-scoped when session dir is switched', () => {
    toolMetadataStore.setSessionDir(sessionDirA);
    setStoredError({
      status: 401,
      statusText: 'Unauthorized',
      message: 'Session A auth failed',
      timestamp: Date.now(),
    });

    toolMetadataStore.setSessionDir(sessionDirB);
    setStoredError({
      status: 429,
      statusText: 'Too Many Requests',
      message: 'Session B rate limit',
      timestamp: Date.now(),
    });

    toolMetadataStore.setSessionDir(sessionDirA);
    const errA = getLastApiError();
    expect(errA?.status).toBe(401);

    toolMetadataStore.setSessionDir(sessionDirB);
    const errB = getLastApiError();
    expect(errB?.status).toBe(429);
  });

  it('merges new metadata with existing on-disk entries', () => {
    const existing = {
      existingTool: {
        intent: 'Existing',
        displayName: 'Existing Tool',
        timestamp: Date.now() - 1000,
      },
    };

    writeFileSync(join(sessionDirA, 'tool-metadata.json'), JSON.stringify(existing), 'utf-8');
    toolMetadataStore.setSessionDir(sessionDirA);

    toolMetadataStore.set('newTool', {
      intent: 'New intent',
      displayName: 'New Tool',
      timestamp: Date.now(),
    });

    const persisted = JSON.parse(readFileSync(join(sessionDirA, 'tool-metadata.json'), 'utf-8')) as Record<string, unknown>;
    expect(persisted.existingTool).toBeDefined();
    expect(persisted.newTool).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// API error history (2026-09-13)
//
// api-error.json is a single slot that getStoredError() DELETES on read, so a
// session's error trail was unrecoverable — debugging a session that failed
// twice meant cross-referencing two process logs by timestamp.
// ---------------------------------------------------------------------------
describe('API error history', () => {
  let dir: string;

  const err = (status: number, message: string): LastApiError => ({
    status,
    statusText: status === 400 ? 'Bad Request' : 'Too Large',
    message,
    timestamp: Date.now(),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'api-error-hist-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty trail when no errors were recorded', () => {
    expect(readErrorHistory(dir)).toEqual([]);
  });

  it('survives the single-slot file being consumed', () => {
    // This is the whole point: getLastApiError() pops api-error.json, and the
    // history must still have the record afterwards.
    toolMetadataStore.setSessionDir(dir);
    setStoredError(err(400, 'property reasoning_content is unsupported'));
    expect(getLastApiError(dir)).not.toBeNull();

    const history = readErrorHistory(dir);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe(400);
  });

  it('keeps multiple errors in order, oldest first', () => {
    appendErrorToHistory(err(400, 'first'), dir);
    appendErrorToHistory(err(413, 'second'), dir);
    appendErrorToHistory(err(429, 'third'), dir);

    const history = readErrorHistory(dir);
    expect(history.map(e => e.status)).toEqual([400, 413, 429]);
  });

  it('caps the buffer and keeps the most recent entries', () => {
    for (let i = 0; i < API_ERROR_HISTORY_LIMIT + 20; i++) {
      appendErrorToHistory(err(500, `error-${i}`), dir);
    }
    const history = readErrorHistory(dir);
    expect(history).toHaveLength(API_ERROR_HISTORY_LIMIT);
    // Oldest kept entry is the one 49 back from the final `error-N`.
    const lastIndex = API_ERROR_HISTORY_LIMIT + 19;
    expect(history[0]?.message).toBe(`error-${lastIndex - (API_ERROR_HISTORY_LIMIT - 1)}`);
    expect(history[history.length - 1]?.message).toBe(`error-${lastIndex}`);
  });

  it('skips torn lines instead of losing the whole trail', () => {
    writeFileSync(join(dir, 'api-errors.jsonl'), '{"status":400}\nnot-json\n{"status":413}\n', 'utf-8');
    const history = readErrorHistory(dir);
    expect(history.map(e => e.status)).toEqual([400, 413]);
  });

  it('formats an entry as a single truncatable line', () => {
    const line = formatErrorHistoryEntry(err(413, 'Request too large for model x'));
    expect(line).toContain('413');
    expect(line).toContain('Request too large');

    const long = formatErrorHistoryEntry(err(400, 'x'.repeat(500)), 20);
    expect(long.length).toBeLessThan(80);
    expect(long).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// Non-consuming readers (2026-10-06)
//
// getStoredError() DELETES api-error.json on read and getLastApiError() drops
// anything older than 5 minutes — both let a transient 429 absorbed by the
// retry ladder vanish before the session's "completed without response" path
// can surface it. peekStoredError()/getLastErrorFromHistory() fix that:
// probes must not consume, and the reporting path reads the durable history.
// ---------------------------------------------------------------------------
describe('non-consuming API error readers', () => {
  let dir: string;
  const slotFile = () => join(dir, 'api-error.json');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'api-error-peek-'));
    toolMetadataStore.setSessionDir(dir);
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  it('peekStoredError reads the slot WITHOUT consuming it', () => {
    setStoredError({ status: 429, statusText: 'Too Many Requests', message: 'rate limited', timestamp: Date.now() });

    const err = peekStoredError(dir);
    expect(err?.status).toBe(429);
    // The whole point: the slot must still be there for the session's own
    // reporting path (getLastApiError would have deleted it).
    expect(existsSync(slotFile())).toBe(true);
  });

  it('peekStoredError honors the 5-minute staleness window', () => {
    writeFileSync(
      slotFile(),
      JSON.stringify({ status: 429, statusText: 'Too Many Requests', message: 'stale', timestamp: Date.now() - 6 * 60 * 1000 }),
      'utf-8',
    );
    expect(peekStoredError(dir)).toBeNull();

    writeFileSync(
      slotFile(),
      JSON.stringify({ status: 429, statusText: 'Too Many Requests', message: 'fresh', timestamp: Date.now() }),
      'utf-8',
    );
    expect(peekStoredError(dir)?.message).toBe('fresh');
  });

  it('getLastErrorFromHistory returns the most recent durable entry with no TTL drop', () => {
    // An hour-old 400 (well past MAX_ERROR_AGE_MS) must still be retrievable.
    appendErrorToHistory({ status: 400, statusText: 'Bad Request', message: 'old', timestamp: Date.now() - 60 * 60 * 1000 }, dir);
    expect(getLastErrorFromHistory(dir)?.status).toBe(400);

    appendErrorToHistory({ status: 429, statusText: 'Too Many Requests', message: 'new', timestamp: Date.now() }, dir);
    const last = getLastErrorFromHistory(dir);
    expect(last?.status).toBe(429);
    expect(last?.message).toBe('new');
  });

  it('getLastErrorFromHistory consumes nothing (slot and history both survive)', () => {
    setStoredError({ status: 413, statusText: 'Too Large', message: 'tpm', timestamp: Date.now() });

    const err = getLastErrorFromHistory(dir);
    expect(err?.status).toBe(413);
    expect(existsSync(slotFile())).toBe(true);
    expect(readErrorHistory(dir)).toHaveLength(1);
  });

  it('getLastErrorFromHistory falls back to the slot when the history is empty', () => {
    writeFileSync(
      slotFile(),
      JSON.stringify({ status: 503, statusText: 'Service Unavailable', message: 'no history', timestamp: Date.now() - 30 * 60 * 1000 }),
      'utf-8',
    );

    const err = getLastErrorFromHistory(dir);
    expect(err?.status).toBe(503);
    // Fallback read is also non-destructive.
    expect(existsSync(slotFile())).toBe(true);
  });
});
