import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

const dirs: string[] = [];
function makeConfig(): BackendConfig {
  const rootPath = mkdtempSync(join(tmpdir(), 'pi-progress-agent-'));
  dirs.push(rootPath);
  return {
    provider: 'pi',
    workspace: { id: 'ws-progress', name: 'Progress', rootPath } as any,
    session: { id: 'session-progress', workspaceRootPath: rootPath, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    isHeadless: true,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PiAgent persistent progress journal integration', () => {
  it('persists parallel same-name tool events with exact call-ID correlation', () => {
    const config = makeConfig();
    const agent = new PiAgent(config);
    try {
      const adapter = (agent as any).adapter;
      adapter.startTurn();
      (agent as any)._isProcessing = true;
      (agent as any).progressJournal.recordUserRequest('Preserve the original request and do not repeat completed reads.');
      (agent as any).handleSubprocessEvent({
        type: 'tool_execution_start', toolName: 'Read', toolCallId: 'read-a', args: { file_path: 'a.ts' },
      });
      (agent as any).handleSubprocessEvent({
        type: 'tool_execution_start', toolName: 'Read', toolCallId: 'read-b', args: { file_path: 'b.ts' },
      });
      (agent as any).handleSubprocessEvent({
        type: 'tool_execution_end', toolName: 'Read', toolCallId: 'read-b', isError: false,
        result: { content: [{ type: 'text', text: 'result-b' }] },
      });
      (agent as any).handleSubprocessEvent({
        type: 'tool_execution_end', toolName: 'Read', toolCallId: 'read-a', isError: false,
        result: { content: [{ type: 'text', text: 'result-a' }] },
      });

      const journalPath = join(config.workspace.rootPath, 'sessions', config.session!.id, 'progress.jsonl');
      const records = readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const starts = records.filter((record) => record.kind === 'tool_start');
      const results = records.filter((record) => record.kind === 'tool_result');
      expect(starts.map((record) => record.callId)).toEqual(['read-a', 'read-b']);
      expect(results.map((record) => [record.callId, record.resultSummary])).toEqual([
        ['read-b', 'result-b'], ['read-a', 'result-a'],
      ]);
      const anchor = (agent as any).buildProgressAnchor() as string;
      expect(anchor).toContain('Preserve the original request and do not repeat completed reads.');
      expect(anchor).toContain('result-b');
      expect(anchor).toContain(join(config.workspace.rootPath, 'sessions', config.session!.id, 'session.jsonl'));
      expect(anchor).toContain('Read or grep');
    } finally {
      agent.destroy();
    }
  });
});
