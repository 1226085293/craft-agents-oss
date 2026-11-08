/**
 * A delivered message must be input, and it must wake its session.
 *
 * Reported repeatedly as 「任务完成了但没反馈」. Every other link in the chain had been
 * fixed — the worker filed a hand-off, the gate passed, the task paused for a decision,
 * the working supervisor called `report_to_user` and was told 「已用 report_to_user 告知用户」.
 * What actually happened: `deliverToUserLane` wrote the request with `role: 'assistant'`
 * and id = randomUUID, so in the user lane's transcript it reads as the supervisor talking
 * to itself, and nothing ran it.
 *
 * The UI showed 「任务 T-1 已建好… 等它回报后再决定下一步」 as the last thing, and the user
 * waited for a report that had already been written into a transcript nobody was reading.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getSessionFilePath } from '@craft-agent/shared/sessions/storage';

import { SessionManager, createManagedSession } from './SessionManager.ts';

describe('a delivered message is input, and it wakes the session', () => {
  let tmpRoot: string;
  let sm: SessionManager;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-synthetic-'));
    sm = new SessionManager();
  });

  afterEach(async () => {
    await sm.flushAllSessions();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function buildSession(id: string, sent: string[] = []) {
    const workspace = { id: 'ws_test', name: 'Test', rootPath: tmpRoot, createdAt: Date.now() };
    const managed = createManagedSession(
      { id, name: 'user lane' },
      workspace as never,
      { messagesLoaded: true },
    );
    // A live but idle agent: deliveries to it have to restart the turn.
    managed.agent = { chat: () => undefined } as never;
    managed.isProcessing = false;
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed);
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = async (
      sessionId: string,
      message: string,
    ) => {
      sent.push(`${sessionId}:${message}`);
    };
    return managed;
  }

  const append = (managed: unknown, text: string) =>
    (sm as unknown as {
      appendSyntheticMessage: (m: unknown, t: string) => Promise<void>;
    }).appendSyntheticMessage(managed, text);

  async function readPersisted(sessionId: string): Promise<Array<Record<string, unknown>>> {
    // Writes go through a queue; reading before it drains finds nothing.
    await sm.flushAllSessions();
    const path = getSessionFilePath(tmpRoot, sessionId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line));
  }

  it('writes the row as a user message, not as the session’s own answer', async () => {
    const managed = buildSession('lane-user');
    await append(managed, '〔来自督导·任务·需要拍板〕只剩 1.2 和 2 未授权');

    const rows = await readPersisted('lane-user');
    const delivered = rows.find((row) => String(row.content).includes('需要拍板'));
    expect(delivered).toBeDefined();
    // `assistant` rendered it as a final answer and, worse, started no turn.
    expect(JSON.stringify(delivered)).toContain('"user"');
  })

  it('wakes the session so the message is actually handled', async () => {
    const sent: string[] = [];
    const managed = buildSession('lane-wake', sent);
    await append(managed, '〔来自督导·任务·需要拍板〕请决定');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('请决定');
  })

  it('does not wake a session that is already working', async () => {
    const sent: string[] = [];
    const managed = buildSession('lane-busy', sent);
    managed.isProcessing = true;
    await append(managed, '一条进度消息');

    // It is mid-turn; the row will be read when that turn ends.
    expect(sent).toHaveLength(0);
    const busyRows = await readPersisted('lane-busy');
    expect(busyRows.some((row) => String(row.content).includes('进度消息'))).toBe(true);
  })
})
