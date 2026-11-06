import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SupervisorRuntime, type SupervisorSessionInfo } from './supervisor-runtime.ts';
import { getRoutesPath } from '@craft-agent/shared/routing';

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-sup-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  runtime: SupervisorRuntime;
  sent: Array<{ sessionId: string; text: string }>;
  spawned: Array<{ scope: string; instruction: string; spawnDepth: number }>;
  written: string[];
  asked: Array<{ question: string }[]>;
  supervisor: SupervisorSessionInfo;
}

function harness(root: string, opts: { processeing?: boolean; spawnDepth?: number } = {}): Harness {
  const sent: Harness['sent'] = [];
  const spawned: Harness['spawned'] = [];
  const written: string[] = [];
  const asked: Harness['asked'] = [];
  const supervisor: SupervisorSessionInfo = {
    id: 'sess_sup',
    role: 'supervisor',
    spawnDepth: opts.spawnDepth ?? 0,
    isProcessing: opts.processeing ?? false,
  };
  const sessions = new Map<string, SupervisorSessionInfo>([[supervisor.id, supervisor]]);

  const runtime = new SupervisorRuntime({
    workspaceRoot: root,
    ensureSupervisorSession: async () => supervisor,
    getSession: (id) => sessions.get(id) ?? null,
    spawnWorker: async (params) => {
      spawned.push({
        scope: params.scope,
        instruction: params.instruction,
        spawnDepth: params.spawnDepth,
      });
      const id = `sess_worker_${spawned.length}`;
      sessions.set(id, { id, role: 'worker', spawnDepth: params.spawnDepth, isProcessing: false });
      return { sessionId: id };
    },
    sendToSession: async (sessionId, text) => {
      sent.push({ sessionId, text });
    },
    writeToSupervisor: async (_sessionId, text) => {
      written.push(text);
    },
    askUser: async (_sessionId, questions) => {
      asked.push(questions);
    },
  });

  return { runtime, sent, spawned, written, asked, supervisor };
}

const event = (overrides: Partial<Parameters<SupervisorRuntime['routeUnclaimed']>[0]> = {}) => ({
  id: 'e1',
  source: 'qqmail-idle',
  type: 'mail.received',
  title: '新的账单',
  summary: '本月账单已出',
  ...overrides,
});

describe('unclaimed events', () => {
  it('queues events no rule mentions for the supervisor', async () => {
    const ws = workspace();
    const h = harness(ws);
    // There is no opt-out tier: an unclaimed event reaches the supervisor even
    // when routes.json does not exist at all — that was the gap the delivery
    // test caught (ignore used to drop it silently).
    expect(await h.runtime.routeUnclaimed(event({ source: 'unknown' }))).toBe('queued');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain('未处理的事件');
  });

  it('queues undecidable events and nudges the supervisor once', async () => {
    const ws = workspace();
    writeFileSync(
      getRoutesPath(ws),
      JSON.stringify([{ name: '账单', when: { source: 'qqmail-idle', textMatch: '账单' }, to: { agentId: 'x' } }]),
      'utf-8',
    );
    const h = harness(ws);
    expect(await h.runtime.routeUnclaimed(event({ title: '团建通知', summary: '' }))).toBe('queued');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain('未处理的事件');
  });

  it('keeps the backlog while the supervisor is busy', async () => {
    const ws = workspace();
    const h = harness(ws, { processeing: true });
    await h.runtime.routeUnclaimed(event({ source: 'no-rule' }));
    expect(h.sent).toHaveLength(0);
    expect(h.runtime.pendingEvents).toBe(1); // parked, drained on idle
  });

  it('drains the backlog when the supervisor goes idle', async () => {
    const ws = workspace();
    writeFileSync(
      getRoutesPath(ws),
      JSON.stringify([{ name: '只认账单', when: { source: 'qqmail-idle', textMatch: '账单' }, to: { agentId: 'x' } }]),
      'utf-8',
    );
    const h = harness(ws, { processeing: true });
    await h.runtime.routeUnclaimed(event({ title: '别的邮件', summary: '' }));
    expect(h.sent).toHaveLength(0);

    h.supervisor.isProcessing = false;
    await h.runtime.onSupervisorIdle();
    expect(h.sent).toHaveLength(1);
  });
});

describe('dispatch guards', () => {
  it('spawns a worker for a new target and carries the depth', async () => {
    const h = harness(workspace());
    const result = await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'new' },
      scope: '改前端',
      instruction: '把输入框改成两行',
      parallel: true,
    });
    expect(result.sessionId).toBe('sess_worker_1');
    expect(h.spawned[0].spawnDepth).toBe(1);
  });

  it('sends into an existing session instead of spawning', async () => {
    const h = harness(workspace());
    const result = await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'session', sessionId: 'sess_existing' },
      scope: '继续',
      instruction: '接着改',
      parallel: false,
    });
    expect(result.sessionId).toBe('sess_existing');
    expect(h.sent[0].sessionId).toBe('sess_existing');
  });

  it('refuses past the depth cap', async () => {
    const h = harness(workspace(), { spawnDepth: 2 });
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'new' },
        scope: 'x',
        instruction: 'y',
        parallel: false,
      }),
    ).rejects.toThrow();
  });

  it('refuses a fourth parallel dispatch', async () => {
    const h = harness(workspace());
    for (let i = 0; i < 3; i += 1) {
      await h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'new' },
        scope: `范围 ${i}`,
        instruction: `任务 ${i}`,
        parallel: true,
      });
    }
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'new' },
        scope: '第四个',
        instruction: '第四个任务',
        parallel: true,
      }),
    ).rejects.toThrow();
  });

  it('rejects dispatch from a worker session', async () => {
    const h = harness(workspace());
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_not_supervisor',
        target: { kind: 'new' },
        scope: 'x',
        instruction: 'y',
        parallel: false,
      }),
    ).rejects.toThrow();
  });
});

describe('user channel', () => {
  it('writes the supervisor message instead of the worker transcript', async () => {
    const h = harness(workspace());
    await h.runtime.reportToUser({ supervisorSessionId: 'sess_sup', text: '已完成' });
    expect(h.written).toEqual(['已完成']);
  });

  it('caps questions at two', async () => {
    const h = harness(workspace());
    await h.runtime.askUser({
      supervisorSessionId: 'sess_sup',
      questions: [{ question: 'a' }, { question: 'b' }, { question: 'c' }],
    });
    expect(h.asked[0]).toHaveLength(2);
  });
});

/**
 * The cap backoff has to cover *both* ways the supervisor is woken: a turn
 * ending (`onSupervisorIdle`) and a fresh event arriving (`routeUnclaimed`).
 *
 * Gating only the first was a real hole: a busy channel would re-wake the
 * supervisor immediately after every cap kill, so the delay written for one path
 * was bypassed by the other. These cases pin the shared gate.
 */
describe('cap backoff applies to every wake path', () => {
  it('drains immediately on the first hit — one slow turn is not a pattern', async () => {
    const h = harness(workspace());
    h.runtime.noteCapHit();
    await h.runtime.routeUnclaimed({ id: 'e1', source: 'qq', type: 'message.received', title: 'hi' });
    expect(h.sent.filter((s) => s.sessionId === 'sess_sup')).toHaveLength(1);
    h.runtime.dispose();
  });

  it('holds a new event while the window is open', async () => {
    const h = harness(workspace());
    h.runtime.noteCapHit();
    h.runtime.noteCapHit();
    await h.runtime.routeUnclaimed({ id: 'e1', source: 'qq', type: 'message.received', title: 'hi' });
    // Nothing delivered: the event waits in the backlog rather than starting a
    // turn that would be killed the same way.
    expect(h.sent).toHaveLength(0);
    h.runtime.dispose();
  });

  it('holds the post-turn drain while the window is open', async () => {
    const h = harness(workspace());
    h.runtime.noteCapHit();
    h.runtime.noteCapHit();
    await h.runtime.routeUnclaimed({ id: 'e1', source: 'qq', type: 'message.received', title: 'hi' });
    await h.runtime.onSupervisorIdle();
    expect(h.sent).toHaveLength(0);
    h.runtime.dispose();
  });

  it('delivers the held events once a turn completes normally', async () => {
    const h = harness(workspace());
    h.runtime.noteCapHit();
    h.runtime.noteCapHit();
    await h.runtime.routeUnclaimed({ id: 'e1', source: 'qq', type: 'message.received', title: 'hi' });
    expect(h.sent).toHaveLength(0);
    // A good turn proves the cap is not the problem; the backlog is released.
    h.runtime.noteTurnCompleted();
    await h.runtime.onSupervisorIdle();
    expect(h.sent.filter((s) => s.sessionId === 'sess_sup')).toHaveLength(1);
    h.runtime.dispose();
  });

  it('dispose stops a pending window from firing later', async () => {
    const h = harness(workspace());
    h.runtime.noteCapHit();
    h.runtime.noteCapHit();
    await h.runtime.routeUnclaimed({ id: 'e1', source: 'qq', type: 'message.received', title: 'hi' });
    h.runtime.dispose();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.sent).toHaveLength(0);
  });
});
