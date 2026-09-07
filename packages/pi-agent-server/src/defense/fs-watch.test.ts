import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsWatch } from './fs-watch.ts';

/**
 * Regression contract for the 2026-09-08 incident.
 *
 * The defense evaluator's cwd IS the session directory. The host appends to
 * `session.jsonl` on every turn (and writes under attachments/, downloads/,
 * long_responses/, .pi-agent/), so an unfiltered mtime scan reported "user
 * wrote files" on EVERY turn — force-resuming pure read-only Q&A turns
 * ("wrote but never verified") and burning the resume cap into state=failed.
 *
 * Contract: framework runtime files/dirs in the session cwd must never count
 * as write evidence; genuine user-work artifacts still must.
 */

function makeSessionDir(): { dir: string; turnStart: Date } {
  const dir = mkdtempSync(join(tmpdir(), 'fs-watch-test-'));
  // Anchor slightly in the past so writes made "during the turn" have
  // mtimes strictly greater than the turn-start marker (filesystem mtime
  // granularity can be coarser than 1ms).
  const turnStart = new Date(Date.now() - 50);
  // Framework layout of a session dir (top level).
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, '.pi-agent'), { recursive: true });
  mkdirSync(join(dir, '.pi-sessions'), { recursive: true });
  mkdirSync(join(dir, 'attachments'), { recursive: true });
  mkdirSync(join(dir, 'downloads'), { recursive: true });
  mkdirSync(join(dir, 'long_responses'), { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), '{"user":"..."}\n');
  writeFileSync(join(dir, 'tool-metadata.json'), '{}');
  writeFileSync(join(dir, 'data', 'pi-agent-server.log'), 'log\n');
  writeFileSync(join(dir, 'attachments', 'pic.png'), 'bin');
  return { dir, turnStart };
}

function touchAll(dir: string, after: number): void {
  // Simulate the host appending/writing every framework file mid-turn.
  const now = new Date();
  utimesSync(join(dir, 'session.jsonl'), now, now);
  utimesSync(join(dir, 'tool-metadata.json'), now, now);
  utimesSync(join(dir, 'data', 'pi-agent-server.log'), now, now);
  utimesSync(join(dir, 'attachments', 'pic.png'), now, now);
  void after;
}

describe('FsWatch — framework runtime noise in session cwd (2026-09-08 incident)', () => {
  it('host-written session transcript does NOT count as write evidence', () => {
    const { dir } = makeSessionDir();
    const fw = new FsWatch();
    fw.markTurnStart(new Date(Date.now() - 50));
    touchAll(dir, Date.now());
    const ev = fw.detectWrites(dir);
    expect(ev?.modifiedFiles ?? []).toEqual([]);
  });

  it('read-only Q&A turn with zero user writes → evaluator must NOT resume', () => {
    const { DefenseEvaluator } = require('./evaluator.ts') as typeof import('./evaluator.ts');
    const { dir } = makeSessionDir();
    const e = new DefenseEvaluator({ enabled: true, cwd: dir });
    e.resetTurn();
    // Host writes runtime files mid-turn:
    touchAll(dir, Date.now());
    // Turn is a pure Q&A: one bash read, final answer with visible text.
    e.recordToolCall({ type: 'bash', command: 'python -c "print(datetime.now(...))"', output: '2026-09-07 20:38' });
    const result = e.evaluate({ hasVisibleText: true, aborted: false });
    expect(result.shouldResume).toBe(false);
    expect(result.state).not.toBe('failed');
  });

  it('genuine user-work artifacts still count as write evidence', () => {
    const { dir } = makeSessionDir();
    const fw = new FsWatch();
    fw.markTurnStart(new Date(Date.now() - 50));
    // User work: agent edits a project file the user asked about.
    writeFileSync(join(dir, 'output.txt'), 'user artifact');
    const ev = fw.detectWrites(dir);
    expect(ev?.modifiedFiles).toContain('output.txt');
  });

  it('framework dirs are skipped even when freshly touched', () => {
    const { dir } = makeSessionDir();
    const fw = new FsWatch();
    fw.markTurnStart(new Date(Date.now() - 50));
    writeFileSync(join(dir, 'data', 'pi-agent-server.log'), 'more log\n');
    writeFileSync(join(dir, 'attachments', 'new.bin'), 'x');
    const ev = fw.detectWrites(dir);
    expect(ev?.modifiedFiles ?? []).toEqual([]);
  });
});
