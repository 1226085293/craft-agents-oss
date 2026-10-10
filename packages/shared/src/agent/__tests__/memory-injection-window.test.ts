/**
 * Regression tests: the memory-injection keyword window must contain the
 * CURRENT user message, and JSONL message roles must survive the
 * type→role mapping (stored lines carry `type`, not `role`).
 *
 * Without these, a user's latest intent (e.g. "更新craft") never reaches
 * keyword extraction, so the matching workflow memory is gated out and the
 * agent improvises instead of following the stored instruction.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestAgent, createMockBackendConfig, createMockWorkspace } from './test-utils.ts';
import type { MemoryStore } from '../../memory/types.ts';

let root: string;

function sessionDir(): string {
  return join(root, 'sessions', 'test-session-id');
}

function writeJsonl(): void {
  // 4 history turns about unrelated work (draft/navigation fix), written with
  // the real on-disk shape: role stored as `type`.
  const lines = [
    JSON.stringify({ id: 'test-session-id' }), // header line
    JSON.stringify({ id: 'm1', type: 'assistant', content: '全部完成 ✅ 修复 NavigationContext 自动删除检查草稿附件，提交 08767684', timestamp: Date.now() }),
    JSON.stringify({ id: 'm2', type: 'tool', content: 'Running Bash...', timestamp: Date.now() }),
    JSON.stringify({ id: 'm3', type: 'assistant', content: '已验证 08767684 提交通过，草稿会话不再误删', timestamp: Date.now() }),
    JSON.stringify({ id: 'm4', type: 'tool', content: 'Running Bash...', timestamp: Date.now() }),
  ];
  writeFileSync(join(sessionDir(), 'session.jsonl'), lines.join('\n') + '\n');
}

function targetStore(): MemoryStore {
  return {
    version: 1,
    extractionHistory: [],
    totalInjectionTokens: 0,
    entries: [
      {
        id: 'target-workflow',
        type: 'behavioral',
        content: '更新craft按照仓库docs下的文档进行',
        tags: [],
        confidence: 1,
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        injectedCount: 0,
        sourceSessionId: 's',
      },
    ],
  };
}

function makeAgent(): TestAgent {
  const agent = new TestAgent(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }) }));
  (agent as any)._memoryStore = targetStore();
  return agent;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-window-'));
  mkdirSync(sessionDir(), { recursive: true });
  writeJsonl();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('memory injection window (current user message)', () => {
  it('recalls a matching workflow memory when the current user message is in the window', () => {
    const agent = makeAgent();
    const ctx = (agent as any).buildMemoryContext('更新craft');
    expect(ctx).toContain('更新craft按照仓库docs下的文档进行');
  });

  it('injects nothing when only unrelated history is available', () => {
    const agent = makeAgent();
    const ctx = (agent as any).buildMemoryContext();
    expect(ctx).toBe('');
  });

  it('maps stored message `type` to `role` for keyword weighting', () => {
    const agent = makeAgent();
    const window = (agent as any).getRecentMessagesForInjection(4);
    expect(window).toHaveLength(4);
    expect(window.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
  });
});
