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
  spawned: Array<{ scope: string; instruction: string; spawnDepth: number; agentId?: string; taskId?: string }>;
  written: string[];
  asked: Array<{ question: string }[]>;
  supervisor: SupervisorSessionInfo;
  /** Live session table, so cases can build a session with or without a task. */
  sessions: Map<string, SupervisorSessionInfo>;
}

function harness(
  root: string,
  opts: {
    processeing?: boolean;
    spawnDepth?: number;
    /** Tasks the runtime can resolve, so a `task` target can be dispatched. */
    tasks?: Map<string, { id: string; currentSessionId?: string; assigneeAgentId?: string }>;
  } = {},
): Harness {
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
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.taskId ? { taskId: params.taskId } : {}),
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
    getTask: (taskId) => opts.tasks?.get(taskId) ?? null,
  });

  return { runtime, sent, spawned, written, asked, supervisor, sessions };
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


/**
 * A task names its executor. Both ways of starting it must agree.
 *
 * The cron/event runner (`spawnTaskRun`) has always passed `task.assigneeAgentId`
 * to `createSession`; this path did not, so the same task ran as its assigned
 * profile when a trigger fired it and as the workspace default when the
 * supervisor dispatched it. The lookup had been dropping the field, which made
 * the bug invisible: `dispatch` never received it to pass on.
 */
describe('dispatch honours the task assignee', () => {
  it("spawns the worker under the task's assigned profile", async () => {
    const tasks = new Map([
      ['T-1', { id: 'T-1', assigneeAgentId: 'agent-ui' }],
    ]);
    const h = harness(workspace(), { tasks });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '改前端',
      instruction: '把按钮改成蓝色',
      attachTaskId: 'T-1',
      parallel: false,
    });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.agentId).toBe('agent-ui');
    expect(h.spawned[0]?.taskId).toBe('T-1');
  });

  it('leaves the profile unset when the task assigns nobody', async () => {
    const tasks = new Map([['T-2', { id: 'T-2' }]]);
    const h = harness(workspace(), { tasks });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-2' },
      scope: '查资料',
      instruction: '查一下这个 API 怎么用',
      attachTaskId: 'T-2',
      parallel: false,
    });
    // Undefined, not a made-up id: the default profile is resolved downstream.
    expect(h.spawned[0]?.agentId).toBeUndefined();
  });

  it('sends a follow-up to the existing session instead of re-spawning', async () => {
    const tasks = new Map([['T-3', { id: 'T-3', currentSessionId: 'sess_worker_1', assigneeAgentId: 'agent-ui' }]]);
    const h = harness(workspace(), { tasks });
    h.sessions.set('sess_worker_1', { id: 'sess_worker_1', role: 'worker', spawnDepth: 1, isProcessing: false, taskId: 'T-3' });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-3' },
      scope: '改前端',
      instruction: '再加个 hover',
      parallel: false,
    });
    // A running task keeps its session (and therefore its profile); re-spawning
    // would silently switch executors mid-task.
    expect(h.spawned).toHaveLength(0);
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
      attachTaskId: 'T-1',
      parallel: true,
    });
    expect(result.sessionId).toBe('sess_worker_1');
    expect(h.spawned[0].spawnDepth).toBe(1);
  });

  it('refuses a new session that carries no task', async () => {
    // The structural rule: every dispatched unit of work is a task. Without this,
    // a throwaway session has no acceptance, no board entry and no way to answer
    // "what happened to that?" afterwards.
    const h = harness(workspace());
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'new' },
        scope: '改前端',
        instruction: '把输入框改成两行',
        parallel: true,
      }),
    ).rejects.toThrow(/attachTaskId/);
    expect(h.spawned).toHaveLength(0);
  });

  it('sends into an existing session instead of spawning', async () => {
    const h = harness(workspace());
    // An existing session may already own a task; the dispatch is then a
    // follow-up to recorded work, which is exactly what should be allowed.
    h.sessions.set('sess_existing', {
      id: 'sess_existing',
      role: 'worker',
      isProcessing: false,
      taskId: 'T-1',
    } as never);
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

  it('refuses an existing session that has no task', async () => {
    const h = harness(workspace());
    h.sessions.set('sess_orphan', { id: 'sess_orphan', role: 'worker', isProcessing: false } as never);
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'session', sessionId: 'sess_orphan' },
        scope: '继续',
        instruction: '随便干点什么',
        parallel: false,
      }),
    ).rejects.toThrow(/任务/);
  });

  it('refuses past the depth cap', async () => {
    const h = harness(workspace(), { spawnDepth: 2 });
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'new' },
        scope: 'x',
        instruction: 'y',
        attachTaskId: 'T-1',
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
        attachTaskId: `T-${i}`,
        parallel: true,
      });
    }
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'new' },
        scope: '第四个',
        instruction: '第四个任务',
        attachTaskId: 'T-4',
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
 * No per-turn cap, therefore no backoff gate.
 *
 * A cap existed (and a backoff that throttled the backlog after repeated hits).
 * Both are gone: the cap turned "the supervisor took a while" into a task, which
 * needed a second mechanism to clean up after itself. What must stay true is the
 * reason the backoff lived in `drainToSupervisor` rather than at its call sites —
 * *every* way of waking the supervisor has to hand over the backlog, and does it
 * right away.
 */
describe('the backlog is handed over on every wake path', () => {
  it('delivers on a fresh event', async () => {
    const h = harness(workspace());
    await h.runtime.routeUnclaimed({ id: 'e1', source: 'qq', type: 'message.received', title: 'hi' });
    expect(h.sent.filter((s) => s.sessionId === 'sess_sup')).toHaveLength(1);
    h.runtime.dispose();
  });

  it('delivers when a turn ends', async () => {
    const h = harness(workspace());
    await h.runtime.routeUnclaimed({ id: 'e1', source: 'qq', type: 'message.received', title: 'hi' });
    const before = h.sent.length;
    await h.runtime.onSupervisorIdle();
    // Nothing new queued, so nothing new sent — but the path must not throw or
    // strand state.
    expect(h.sent.length).toBe(before);
    h.runtime.dispose();
  });

  it('never holds an event back waiting for a window to elapse', async () => {
    const h = harness(workspace());
    await h.runtime.routeUnclaimed({ id: 'e1', source: 'qq', type: 'message.received', title: 'one' });
    await h.runtime.routeUnclaimed({ id: 'e2', source: 'qq', type: 'message.received', title: 'two' });
    // Both wake-ups delivered immediately; a backoff would have swallowed the
    // second one until a timer fired.
    expect(h.sent.filter((s) => s.sessionId === 'sess_sup').length).toBeGreaterThanOrEqual(2);
    h.runtime.dispose();
  });
});

/**
 * A task that already has a live session is already dispatched.
 *
 * The board showed two sessions for one task and no way to say who owned it,
 * because every dispatch to a `task` target spawned another worker regardless of
 * whether one was running. The instruction belongs to the existing session.
 */
describe('dispatching into a task respects the session already running it', () => {
  it('sends into the live session instead of spawning a second worker', async () => {
    const tasks = new Map([
      ['T-1', { id: 'T-1', currentSessionId: 'sess_live' }],
    ]);
    const h = harness(workspace(), { tasks });
    h.sessions.set('sess_live', {
      id: 'sess_live',
      role: 'worker',
      spawnDepth: 1,
      isProcessing: true,
      taskId: 'T-1',
    });

    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: 'T-1 的实现',
      instruction: '继续第 2 步',
      attachTaskId: 'T-1',
      parallel: false,
    });

    expect(h.spawned).toHaveLength(0);
    expect(h.sent.map((s) => s.sessionId)).toContain('sess_live');
    h.runtime.dispose();
  });

  it('starts a fresh run when the recorded session is gone', async () => {
    const tasks = new Map([
      ['T-2', { id: 'T-2', currentSessionId: 'sess_dead' }],
    ]);
    const h = harness(workspace(), { tasks });
    // sess_dead is deliberately absent from the live table.

    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-2' },
      scope: 'T-2 的实现',
      instruction: '开始',
      attachTaskId: 'T-2',
      parallel: false,
    });

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.taskId).toBe('T-2');
    h.runtime.dispose();
  });
});
