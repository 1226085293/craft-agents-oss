import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMostRecentSessionFile, shouldForkBranch } from './branch-fork.ts';

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-branch-fork-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('shouldForkBranch — one-shot branch materialization', () => {
  it('forks when the branch has no .pi-sessions directory yet', () => {
    expect(shouldForkBranch(join(makeDir(), '.pi-sessions'))).toBe(true);
  });

  it('forks when the branch directory exists but holds no session file', () => {
    const sessionDir = join(makeDir(), '.pi-sessions');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'notes.txt'), 'not a session');
    expect(shouldForkBranch(sessionDir)).toBe(true);
  });

  it('does NOT fork once the branch owns a Pi session file', () => {
    const sessionDir = join(makeDir(), '.pi-sessions');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '2026-10-18T10-01-11-173Z_child.jsonl'), '{"type":"session"}\n');
    // The branch's own file must win even though the parent has newer turns:
    // re-forking here would copy the parent's LIVE transcript into the branch.
    expect(shouldForkBranch(sessionDir)).toBe(false);
  });

  it('treats a legacy branch (file written by an older build) as materialized', () => {
    const sessionDir = join(makeDir(), '.pi-sessions');
    mkdirSync(sessionDir, { recursive: true });
    const legacy = join(sessionDir, '2026-10-16T10-53-56-322Z_legacy.jsonl');
    writeFileSync(legacy, '{"type":"session"}\n');
    expect(shouldForkBranch(sessionDir)).toBe(false);
  });
});

describe('findMostRecentSessionFile', () => {
  it('returns null for a missing directory', () => {
    expect(findMostRecentSessionFile(join(makeDir(), 'nope'))).toBeNull();
  });

  it('returns the newest .jsonl by mtime and ignores other files', () => {
    const dir = makeDir();
    const older = join(dir, 'older.jsonl');
    const newer = join(dir, 'newer.jsonl');
    writeFileSync(older, '{}\n');
    writeFileSync(newer, '{}\n');
    writeFileSync(join(dir, 'ignored.txt'), 'x');
    utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(newer, new Date(1_700_000_100_000), new Date(1_700_000_100_000));

    expect(findMostRecentSessionFile(dir)).toBe(newer);
  });
});
