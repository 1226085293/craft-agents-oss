import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgressJournal, buildHistoryRecoveryPointer, loadProgressSnapshot } from '../progress-journal.ts';

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'progress-journal-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ProgressJournal', () => {
  it('keeps a bounded in-memory fallback when the ledger path is unwritable', () => {
    const root = makeDir();
    const blocker = join(root, 'not-a-directory');
    writeFileSync(blocker, 'file');
    const journal = new ProgressJournal(join(blocker, 'session'));
    journal.recordUserRequest('Still answer even though disk persistence is blocked.');

    expect(journal.latestUserRequest()?.includes('Still answer even though disk persistence is blocked.')).toBe(true);
  });

  it('persists and restores the current request and completed tool summary', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir);
    journal.recordUserRequest('Fix the compaction handoff');
    journal.recordToolStart({ callId: 'call-1', toolName: 'Read', argsSummary: 'src/agent/pi-agent.ts' });
    journal.recordToolResult({ callId: 'call-1', toolName: 'Read', resultSummary: 'Found the compaction event handler.' });

    const restored = new ProgressJournal(dir);
    expect(restored.latestUserRequest()).toBe('Fix the compaction handoff');
    expect(restored.recentSnapshot()).toContain('Read src/agent/pi-agent.ts');
    expect(restored.recentSnapshot()).toContain('Found the compaction event handler.');
    expect(loadProgressSnapshot(dir)).toContain('Found the compaction event handler.');
  });

  it('does not persist the internal compaction anchor as user guidance', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir);
    journal.recordUserRequest('Preserve the current user intent.');
    journal.recordGuidance('[SYSTEM PROGRESS ANCHOR — context was just compacted. Do NOT redo work.\\nAlready read x.ts.');
    journal.recordUserRequest('[SYSTEM PROGRESS ANCHOR — context was just compacted. Do NOT redo work.\\nAlready read x.ts.');

    expect(journal.latestUserRequest()).toBe('Preserve the current user intent.');
    expect(readFileSync(join(dir, 'progress.jsonl'), 'utf8')).not.toContain('SYSTEM PROGRESS ANCHOR');
  });

  it('keeps mid-turn user guidance alongside the original request', () => {
    const journal = new ProgressJournal(makeDir());
    journal.recordUserRequest('Implement the compaction handoff.');
    journal.recordGuidance('Do not change the SDK threshold; wrap the summary path.');

    expect(journal.latestUserRequest()).toContain('Implement the compaction handoff.');
    expect(journal.latestUserRequest()).toContain('Do not change the SDK threshold; wrap the summary path.');
  });

  it('refreshes snapshots when another process appends to the shared ledger', () => {
    const dir = makeDir();
    const reader = new ProgressJournal(dir);
    const writer = new ProgressJournal(dir);
    writer.recordUserRequest('New request written by host process');
    writer.recordConclusion('New conclusion visible across processes');

    expect(reader.latestUserRequest()).toBe('New request written by host process');
    expect(reader.recentSnapshot()).toContain('New conclusion visible across processes');
  });

  it('correlates parallel same-name tool results by call ID', () => {
    const journal = new ProgressJournal(makeDir());
    journal.recordToolStart({ callId: 'read-a', toolName: 'Read', argsSummary: 'a.ts' });
    journal.recordToolStart({ callId: 'read-b', toolName: 'Read', argsSummary: 'b.ts' });
    journal.recordToolResult({ callId: 'read-b', toolName: 'Read', resultSummary: 'contents of b' });
    journal.recordToolResult({ callId: 'read-a', toolName: 'Read', resultSummary: 'contents of a' });

    const snapshot = journal.recentSnapshot();
    expect(snapshot.indexOf('Read b.ts → contents of b')).toBeGreaterThanOrEqual(0);
    expect(snapshot.indexOf('Read a.ts → contents of a')).toBeGreaterThanOrEqual(0);
  });

  it('collapses consecutive identical executions in the compact snapshot', () => {
    const journal = new ProgressJournal(makeDir());
    for (let i = 0; i < 20; i++) {
      const callId = `loop-${i}`;
      journal.recordToolStart({ callId, toolName: 'Bash', argsSummary: 'python parse.py' });
      journal.recordToolResult({ callId, toolName: 'Bash', resultSummary: 'same output' });
    }
    const snapshot = journal.recentSnapshot();
    expect(snapshot.match(/already executed:/g)).toHaveLength(1);
    expect(snapshot).toContain('20 identical executions');
  });

  it('redacts API credentials embedded in JSON-shaped arguments', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir);
    journal.recordToolStart({
      callId: 'credential-args',
      toolName: 'Tool',
      argsSummary: '{"apiKey":"sensitive-value-123","safe":"ok"}',
    });
    const file = readFileSync(join(dir, 'progress.jsonl'), 'utf8');
    expect(file).not.toContain('sensitive-value-123');
    expect(file).toContain('[REDACTED]');
  });

  it('records conclusion-level entries and redacts credential-shaped text', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir);
    journal.recordConclusion('Confirmed the token is invalid: Bearer abc.def.ghi');

    const file = readFileSync(join(dir, 'progress.jsonl'), 'utf8');
    expect(file).toContain('Confirmed the token is invalid');
    expect(file).not.toContain('abc.def.ghi');
    expect(journal.recentSnapshot()).toContain('Confirmed the token is invalid');
  });

  it('keeps the newest results and conclusions when the rendered snapshot is capped', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir);
    for (let i = 0; i < 10; i++) {
      journal.recordToolStart({ callId: `cap-${i}`, toolName: 'Read', argsSummary: `file-${i}.ts` });
      journal.recordToolResult({ callId: `cap-${i}`, toolName: 'Read', resultSummary: `result-${i}-${'x'.repeat(300)}` });
    }
    journal.recordConclusion(`latest-conclusion-${'y'.repeat(500)}`);
    const snapshot = loadProgressSnapshot(dir, 1_000);
    expect(snapshot.length).toBeLessThanOrEqual(1_000);
    expect(snapshot).toContain('file-9.ts');
    expect(snapshot).toContain('latest-conclusion');
    expect(snapshot).not.toContain('file-0.ts');
  });

  it('preserves a fresh request even after many later records rotate the ledger', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir, { maxBytes: 8_192, maxRecords: 10 });
    journal.recordUserRequest('The current request must survive ledger rotation.');
    for (let i = 0; i < 40; i++) journal.recordConclusion(`conclusion-${i}`);

    const restored = new ProgressJournal(dir, { maxBytes: 8_192, maxRecords: 10 });
    expect(restored.latestUserRequest()).toBe('The current request must survive ledger rotation.');
    expect(restored.recentSnapshot()).toContain('conclusion-39');
  });

  it('preserves the latest guidance across ledger rotation', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir, { maxBytes: 8_192, maxRecords: 10 });
    journal.recordUserRequest('Start with the original request.');
    journal.recordGuidance('Latest steer: use the SDK summary wrapper.');
    for (let i = 0; i < 40; i++) journal.recordConclusion(`later-${i}`);

    const restored = new ProgressJournal(dir, { maxBytes: 8_192, maxRecords: 10 });
    expect(restored.latestUserRequest()).toContain('Start with the original request.');
    expect(restored.latestUserRequest()).toContain('Latest steer: use the SDK summary wrapper.');
  });

  it('keeps the latest user request when a progress entry exceeds the file budget', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir, { maxBytes: 1_024, maxRecords: 30 });
    journal.recordUserRequest('Keep this request available for the next summary.');
    for (let i = 0; i < 5; i++) journal.recordConclusion(`huge-${i}-${'x'.repeat(2_000)}`);

    const restored = new ProgressJournal(dir, { maxBytes: 1_024, maxRecords: 30 });
    expect(restored.latestUserRequest()).toBe('Keep this request available for the next summary.');
    expect(statSync(join(dir, 'progress.jsonl')).size).toBeLessThanOrEqual(1_024);
  });

  it('keeps even a single oversized record within the configured byte cap', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir, { maxBytes: 1_024, maxRecords: 30 });
    journal.recordConclusion(`oversized-${'z'.repeat(20_000)}`);
    expect(statSync(join(dir, 'progress.jsonl')).size).toBeLessThanOrEqual(1_024);
  });

  it('uses hysteresis and does not rewrite the capped file after every append', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir, { maxBytes: 1_024, maxRecords: 30 });
    for (let i = 0; i < 100; i++) journal.recordConclusion(`entry-${i}-${'x'.repeat(70)}`);
    const file = join(dir, 'progress.jsonl');
    const beforeAppend = readFileSync(file, 'utf8');
    const oldestRetained = JSON.parse(beforeAppend.split('\n').filter(Boolean)[0]!).text as string;

    journal.recordConclusion('one-more-entry');

    const afterAppend = readFileSync(file, 'utf8');
    expect(afterAppend).toContain(oldestRetained);
    expect(afterAppend).toContain('one-more-entry');
    expect(statSync(file).size).toBeLessThanOrEqual(1_024);
  });

  it('builds a transcript recovery pointer with the exact JSONL path', () => {
    const pointer = buildHistoryRecoveryPointer('C:/sessions/s-4/session.jsonl');
    expect(pointer).toContain('C:/sessions/s-4/session.jsonl');
    expect(pointer).toContain('Read or grep');
    expect(pointer).toContain('do not redo completed work');
  });

  it('keeps the JSONL file within its configured cap while retaining recent records', () => {
    const dir = makeDir();
    const journal = new ProgressJournal(dir, { maxBytes: 1_024, maxRecords: 30 });
    for (let i = 0; i < 100; i++) journal.recordConclusion(`conclusion-${i}-${'x'.repeat(80)}`);

    expect(statSync(join(dir, 'progress.jsonl')).size).toBeLessThanOrEqual(1_024);
    const restored = new ProgressJournal(dir, { maxBytes: 1_024, maxRecords: 30 });
    expect(restored.recentSnapshot()).toContain('conclusion-99');
  });
});
