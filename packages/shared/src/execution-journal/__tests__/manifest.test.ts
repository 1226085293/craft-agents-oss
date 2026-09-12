import { describe, it, expect, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { JournalState } from '../types.ts';
import {
  buildManifest,
  writeManifest,
  loadManifest,
  getManifestPath,
  estimateReplayTokens,
  analyzeCrashState,
  type TapeStatus,
} from '../manifest.ts';

function makeState(overrides?: Partial<JournalState>): JournalState {
  return {
    entries: [],
    pendingCalls: new Map(),
    totalTokens: 0,
    stubCount: 0,
    ...overrides,
  };
}

function makeEntry(overrides: {
  type?: string;
  sessionId?: string;
  toolName?: string;
  toolUseId?: string;
  turnId?: string;
  toolInput?: Record<string, unknown>;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}): import('../types.ts').JournalEntry {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: 'test-session',
    ...overrides,
  } as import('../types.ts').JournalEntry;
}

describe('buildManifest', () => {
  it('should create a valid manifest from empty state', () => {
    const state = makeState();
    const manifest = buildManifest('session-1', '/workspace', state, 'completed');
    
    expect(manifest.sessionId).toBe('session-1');
    expect(manifest.status).toBe('completed');
    expect(manifest.totalEntries).toBe(0);
    expect(manifest.turnCount).toBe(0);
    expect(manifest.toolSequence).toEqual([]);
  });

  it('should populate tool summary from results', () => {
    const state = makeState({
      entries: [
        makeEntry({ type: 'tool_dispatch', toolName: 'read', toolUseId: 'u1', turnId: '1' }),
        makeEntry({ type: 'tool_result', toolName: 'read', toolUseId: 'u1', durationMs: 100, metadata: { parentJournalId: 'e1' } }),
        makeEntry({ type: 'tool_dispatch', toolName: 'bash', toolUseId: 'u2', turnId: '1' }),
        makeEntry({ type: 'tool_result', toolName: 'bash', toolUseId: 'u2', durationMs: 50, metadata: { parentJournalId: 'e2' } }),
      ],
      totalTokens: 1000,
    });
    state.entries[0]!.id = 'e1';
    state.entries[2]!.id = 'e2';
    
    const manifest = buildManifest('s1', '/ws', state);
    
    expect(manifest.toolSummary.read).toEqual({ count: 1, totalDurationMs: 100 });
    expect(manifest.toolSummary.bash).toEqual({ count: 1, totalDurationMs: 50 });
    expect(manifest.turnCount).toBe(1);
  });
});

describe('writeManifest / loadManifest', () => {
  const tmpDir = join(tmpdir(), `tape-test-${randomUUID()}`);
  
  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write and load manifest', () => {
    const manifest = buildManifest('session-1', tmpDir, makeState(), 'completed');
    writeManifest(tmpDir, 'session-1', manifest);
    
    const loaded = loadManifest(tmpDir, 'session-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('session-1');
    expect(loaded!.status).toBe('completed');
  });

  it('should return null for non-existent manifest', () => {
    const loaded = loadManifest(tmpDir, 'nonexistent');
    expect(loaded).toBeNull();
  });

  it('should return correct path', () => {
    const path = getManifestPath('/workspace', 'session-1');
    expect(path).toContain('tape_manifest.json');
    expect(path).toContain('session-1');
  });
});

describe('estimateReplayTokens', () => {
  it('should estimate based on turn count and average result size', () => {
    const manifest = {
      sessionId: 's1',
      workspaceRootPath: '/ws',
      createdAt: new Date().toISOString(),
      endedAt: null,
      status: 'completed' as TapeStatus,
      totalEntries: 20,
      totalTokens: 5000,
      stubCount: 0,
      compactionCount: 0,
      errorCount: 0,
      toolSummary: {},
      turnCount: 10,
      toolSequence: [],
    };
    
    const estimated = estimateReplayTokens(manifest);
    // 10 turns * (500 input + 250 avg result) = 7500
    expect(estimated).toBeGreaterThan(5000);
    expect(estimated).toBeLessThan(15000);
  });
});

describe('analyzeCrashState', () => {
  it('should identify completed turns and pending tools', () => {
    const manifest = buildManifest('s1', '/ws', makeState(), 'crashed');
    const state = makeState({
      entries: [
        makeEntry({ type: 'tool_dispatch', toolName: 'read', toolUseId: 'u1', turnId: '1' }),
        makeEntry({ type: 'tool_result', toolName: 'read', toolUseId: 'u1', turnId: '1', metadata: { parentJournalId: 'e0' } }),
        makeEntry({ type: 'tool_dispatch', toolName: 'bash', toolUseId: 'u2', turnId: '2' }),
        makeEntry({ type: 'tool_dispatch', toolName: 'write', toolUseId: 'u3', turnId: '2' }),
      ],
    });
    state.entries[0]!.id = 'e0';
    
    const crashState = analyzeCrashState(manifest, state);
    
    expect(crashState.lastCompletedTurn).toBe(1);
    expect(crashState.pendingTools).toHaveLength(2);
    expect(crashState.pendingTools.map(p => p.name)).toContain('bash');
    expect(crashState.pendingTools.map(p => p.name)).toContain('write');
    expect(crashState.canReplay).toBe(true);
  });
});
