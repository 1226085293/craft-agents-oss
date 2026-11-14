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
  /** (taskId, sessionId) pairs the runtime asked the task service to claim. */
  claimed: Array<{ taskId: string; sessionId: string }>;
  spawned: Array<{ scope: string; instruction: string; spawnDepth: number; agentId?: string; taskId?: string }>;
  written: string[];
  asked: Array<{ question: string }[]>;
  supervisor: SupervisorSessionInfo;
  /** Live session table, so cases can build a session with or without a task. */
  sessions: Map<string, SupervisorSessionInfo>;
}

/**
 * `dispatch` queues its side effect; the turn's end is when it happens.
 *
 * Every assertion that used to follow `dispatch` directly now follows `dispatch` + `drain`,
 * because that is the real order: the queue is what makes the supervisor's turn one decision.
 */
async function drain(h: Harness): Promise<void> {
  await h.runtime.onSupervisorIdle()
}

function harness(
  root: string,
  opts: {
    processeing?: boolean;
    spawnDepth?: number;
    /** Tasks the runtime can resolve, so a `task` target can be dispatched. */
    tasks?: Map<
      string,
      {
        id: string;
        /** Read again at drain time: a task can be cancelled between queueing and starting. */
        status?: string;
        currentSessionId?: string;
        /** Sessions the task has run in; the reuse pool. */
        sessionIds?: string[];
        assigneeAgentId?: string;
        /** The run lock, so a case can prove a held lock refuses the dispatch inline. */
        stats?: { lockSessionId?: string };
        /** Why it is paused; `awaiting_release` is the pause the person owns. */
        pauseReason?: string;
        lifecycle?: { lastPausedAt?: number };
        /** Read only to word a refusal: a repeating task's finished plan ends a round. */
        triggers?: Array<{ kind: 'manual' | 'cron' | 'event'; enabled?: boolean }>;
        spec?: { plan?: Array<{ id: string; status?: string; agent?: string; updatedAt?: number; executedBy?: string }> };
      }
    >;
    /** When set, `spawnWorker` refuses with this reason (serial-mode run lock held). */
    spawnRefusal?: string;
  } = {},
): Harness {
  const sent: Harness['sent'] = [];
  const claimed: Harness['claimed'] = [];
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
      if (opts.spawnRefusal) return { refused: true, reason: opts.spawnRefusal };
      const id = `sess_worker_${spawned.length}`;
      sessions.set(id, { id, role: 'worker', spawnDepth: params.spawnDepth, isProcessing: false });
      return { sessionId: id };
    },
    sendToSession: async (sessionId, text) => {
      sent.push({ sessionId, text });
    },
    claimRun: (taskId, sessionId) => {
      claimed.push({ taskId, sessionId });
    },
    writeToSupervisor: async (_sessionId, text) => {
      written.push(text);
    },
    askUser: async (_sessionId, questions) => {
      asked.push(questions);
    },
    getTask: (taskId) => opts.tasks?.get(taskId) ?? null,
  });

  return { runtime, sent, claimed, spawned, written, asked, supervisor, sessions };
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

  it('stops a rule whose agent does not exist instead of spawning the default', async () => {
    const ws = workspace();
    writeFileSync(
      getRoutesPath(ws),
      JSON.stringify([
        { name: '账单', when: { source: 'qqmail-idle', textMatch: '账单' }, to: { agentId: 'agent-typo' } },
      ]),
      'utf-8',
    );
    const h = harness(ws);
    // Without the guard this spawned a worker: `getAgentById` turns an unknown id
    // into the workspace default, so the event was handled by a persona the rule
    // never named, and nothing said so.
    expect(await h.runtime.routeUnclaimed(event())).toBe('queued');
    expect(h.spawned).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain('agent-typo');
    expect(h.sent[0].text).toContain('账单');
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
/**
 * A queued dispatch is not a promise to start.
 *
 * Live run: the person said 「停止！」, the supervisor queued one more dispatch at 02:23:09 and cancelled
 * the task at 02:23:16. The turn ended, the queue drained, and a worker was spawned anyway — it filed a
 * hand-off into a cancelled task and got back 「T-1 已被取消」. The record said one thing and a session
 * did another under its name.
 */
describe('a queued dispatch re-checks the task', () => {
  it('does not spawn when the task was cancelled after queueing', async () => {
    const task = { id: 'T-1', status: 'running' };
    const tasks = new Map([['T-1', task]]);
    const h = harness(workspace(), { tasks });

    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '再发一次问候',
      instruction: '生成第六轮问候',
      attachTaskId: 'T-1',
      parallel: false,
    });

    // The person says stop while the supervisor's turn is still open — exactly the window this guards.
    task.status = 'canceled';
    await drain(h);

    expect(h.spawned).toHaveLength(0);
    expect(h.sent.some((entry) => entry.text.includes('没有执行'))).toBe(true);
  });

  it('still spawns while the task accepts work', async () => {
    const tasks = new Map([['T-1', { id: 'T-1', status: 'backlog' }]]);
    const h = harness(workspace(), { tasks });

    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '改前端',
      instruction: '把按钮改成蓝色',
      attachTaskId: 'T-1',
      parallel: false,
    });
    await drain(h);

    expect(h.spawned).toHaveLength(1);
  });
});

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
    await drain(h)
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
    await drain(h)
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
    await drain(h)
    // A running task keeps its session (and therefore its profile); re-spawning
    // would silently switch executors mid-task.
    expect(h.spawned).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
  });

  it('reports a refused spawn to the supervisor as a refusal, not a failure', async () => {
    const tasks = new Map([['T-4', { id: 'T-4' }]]);
    const h = harness(workspace(), {
      tasks,
      spawnRefusal: '运行已经由 261112-wide-bay 持有，不能重复启动',
    });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-4' },
      scope: '改前端',
      instruction: '把按钮改成蓝色',
      attachTaskId: 'T-4',
      parallel: false,
    });
    await drain(h)
    // Serial mode: the dispatch was refused at claim time, no session existed, and the
    // supervisor hears the reason so it can re-arrange instead of retrying blindly.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain('派发被拒绝');
    expect(h.sent[0].text).toContain('运行已经由 261112-wide-bay 持有');
  });
});

describe('serial mode: one live run per task', () => {
  it("spawns under the step's owner when the plan names one", async () => {
    const tasks = new Map([
      [
        'T-5',
        {
          id: 'T-5',
          assigneeAgentId: 'agent-be',
          spec: { plan: [{ id: '2.1', status: 'todo', agent: 'agent-ui' }] },
        },
      ],
    ]);
    const h = harness(workspace(), { tasks });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-5' },
      stepId: '2.1',
      scope: '改 UI',
      instruction: '把按钮改圆',
      attachTaskId: 'T-5',
      parallel: false,
    });
    await drain(h)
    // The plan's owner wins over the task-level assignee: it is the record of who does what.
    expect(h.spawned[0]?.agentId).toBe('agent-ui');
  });

  it('refuses a step whose owner differs from the live session', async () => {
    const tasks = new Map([
      [
        'T-6',
        {
          id: 'T-6',
          currentSessionId: 'sess_worker_1',
          // A run in flight is the lock; the session object alone means nothing (see the
          // hand-off case below, where existence wrongly refused the next step).
          stats: { lockSessionId: 'sess_worker_1' },
          spec: { plan: [{ id: '2.1', status: 'todo', agent: 'agent-ui' }] },
        },
      ],
    ]);
    const h = harness(workspace(), { tasks });
    h.sessions.set('sess_worker_1', {
      id: 'sess_worker_1',
      role: 'worker',
      spawnDepth: 1,
      isProcessing: false,
      taskId: 'T-6',
      agentId: 'agent-be',
    });
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-6' },
        stepId: '2.1',
        scope: '改 UI',
        instruction: '把按钮改圆',
        parallel: false,
      }),
    ).rejects.toThrow(/串行/);
    // Refused synchronously: nothing was queued, spawned, or sent.
    await drain(h)
    expect(h.spawned).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('allows a same-owner follow-up into the live session', async () => {
    const tasks = new Map([
      [
        'T-7',
        {
          id: 'T-7',
          currentSessionId: 'sess_worker_1',
          spec: { plan: [{ id: '2.1', status: 'todo', agent: 'agent-ui' }] },
        },
      ],
    ]);
    const h = harness(workspace(), { tasks });
    h.sessions.set('sess_worker_1', {
      id: 'sess_worker_1',
      role: 'worker',
      spawnDepth: 1,
      isProcessing: false,
      taskId: 'T-7',
      agentId: 'agent-ui',
    });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-7' },
      stepId: '2.1',
      scope: '改 UI',
      instruction: '再加个 hover',
      parallel: false,
    });
    await drain(h)
    // The live session runs the step already: a follow-up is a continuation, not a takeover.
    expect(h.spawned).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
  });

  it('refuses a second dispatch for the same task inside one turn, in the result', async () => {
    // Live on T-1: one task queued four spawns across three turns. One ran; three were refused
    // only when the queue drained — after the supervisor had already told the person 「已派发」
    // four times. A conflict the record already knows belongs in the answer to the call.
    const tasks = new Map([['T-9', { id: 'T-9' }]]);
    const h = harness(workspace(), { tasks });
    const first = await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-9' },
      stepId: undefined,
      scope: '改前端',
      instruction: '先把数据文档写了',
      parallel: false,
    });
    expect(first.queued).toBe(true);
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-9' },
        scope: '改前端',
        instruction: '顺便把界面文档也写了',
        parallel: false,
      }),
    ).rejects.toThrow(/排入派发队列/);
    await drain(h);
    // One decision, one spawn: the refused call queued nothing.
    expect(h.spawned).toHaveLength(1);
  });

  it('refuses a dispatch while the run lock is held, instead of queueing a doomed spawn', async () => {
    const tasks = new Map([
      ['T-10', { id: 'T-10', currentSessionId: 'sess-gone', stats: { lockSessionId: 'sess_live' } }],
    ]);
    const h = harness(workspace(), { tasks });
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-10' },
        scope: '改前端',
        instruction: '再派一个',
        parallel: false,
      }),
    ).rejects.toThrow(/运行锁/);
    await drain(h);
    expect(h.spawned).toHaveLength(0);
  });

  it('refuses parallel dispatch on a task target', async () => {
    const tasks = new Map([['T-8', { id: 'T-8' }]]);
    const h = harness(workspace(), { tasks });
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-8' },
        scope: '改 UI',
        instruction: '并行把两节都做了',
        parallel: true,
      }),
    ).rejects.toThrow(/串行/);
    await drain(h)
    expect(h.spawned).toHaveLength(0);
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
    // Queued: there is no session yet, and the receipt says so rather than inventing one.
    expect(result.queued).toBe(true);
    expect(result.position).toBe(1);
    expect(h.spawned).toHaveLength(0);

    await drain(h)
    // The turn ended, so the worker exists — one dispatch, one spawn, at the right depth.
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.spawnDepth).toBe(1);
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
    await drain(h)
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
    // Three in one turn; the fourth is refused while the turn is still open.
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
    await drain(h)

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
    await drain(h)

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.taskId).toBe('T-2');
    h.runtime.dispose();
  });
});

describe('scope is a boundary', () => {
  const liveTask = (overrides: Record<string, unknown> = {}) => {
    const task = {
      id: 'T-1',
      currentSessionId: 'sess_worker_1',
      assigneeAgentId: 'builtin-default',
      spec: {
        scope: '执行 1.1 步骤，做完即停',
        plan: [
          { id: '1', status: 'doing' },
          { id: '1.1', status: 'done' },
          { id: '1.2', status: 'todo' },
          { id: '2', status: 'todo' },
        ],
      },
      handoffs: [{ outcome: 'handoff' }],
      ...overrides,
    };
    return new Map([['T-1', task as never]]);
  };

  it('no longer refuses a dispatch because a prose scope looks narrower', async () => {
    /**
     * The gate that used to fire here was the third implementation of 「is this authorised?」.
     *
     * It compared open step ids against `authorizedUpTo` / `authorizedSteps`, and the three
     * implementations disagreed: the user answered 「完成1.2后暂停」, the supervisor recorded it
     * correctly, and the dispatch of 1.2 was refused anyway because `spec.scope` still read
     * 「步骤 1.2」 and the plan still had step 2 open. The supervisor then paused the task and
     * reported success — the work never happened.
     *
     * Both of the things it read are gone: an id list the worker can mint, and prose nobody can
     * check. What decides now is the recorded directive plus the task's state, and what is
     * enforced here is only that a paused task does not take new work.
     */
    const h = harness(workspace(), { tasks: liveTask() });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '继续 T-1 剩余步骤',
      instruction: '把 1.2 和 2 也做完',
      parallel: false,
    });
    await drain(h)
    // Either path is fine — the point is that the work happens, where the old gate refused it.
    expect(h.sent.length + h.spawned.length).toBe(1);
  });

  it('allows it when a person approved going further', async () => {
    const h = harness(workspace(), { tasks: liveTask() });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '继续 T-1 剩余步骤',
      instruction: '把 1.2 和 2 也做完',
      parallel: false,
      userApproved: true,
    });
    await drain(h)
    expect(h.sent.length + h.spawned.length).toBe(1);
  });

  it('leaves a first run alone', async () => {
    // No accepted hand-off yet: the worker is still on the scoped work.
    const h = harness(workspace(), { tasks: liveTask({ handoffs: [] }) });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '继续',
      instruction: '接着做',
      parallel: false,
    });
    await drain(h)
    expect(h.sent.length + h.spawned.length).toBe(1);
  })

  it('leaves a task without a scope alone', async () => {
    const h = harness(workspace(), {
      tasks: liveTask({ spec: { plan: [{ id: '1', status: 'todo' }] } }),
    });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '继续',
      instruction: '接着做',
      parallel: false,
    });
    await drain(h)
    expect(h.sent.length + h.spawned.length).toBe(1);
  })
})

describe('a paused task does not take new work', () => {
  const tasks = (overrides: Record<string, unknown> = {}) =>
    new Map([
      [
        'T-1',
        {
          id: 'T-1',
          status: 'paused',
          currentSessionId: 'sess_worker_1',
          assigneeAgentId: 'builtin-default',
          spec: { scope: '只做 1.1', plan: [{ id: '1', status: 'todo' }] },
          handoffs: [],
          ...overrides,
        } as never,
      ],
    ])

  /**
   * The user said 「完成 1.2 后暂停」. The task paused for a decision, and two minutes
   * later the supervisor spawned a fresh session for 1.2 anyway — through
   * `target: { kind: 'new' }` with an `attachTaskId`, which never reached the scope
   * check because that lived in the `task` branch.
   */
  it('refuses a brand-new session attached to a paused task', async () => {
    const h = harness(workspace(), { tasks: tasks() });
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'new' },
        scope: '继续 1.2',
        instruction: '读回确认',
        attachTaskId: 'T-1',
        parallel: false,
      }),
    ).rejects.toThrow(/暂停/);
    expect(h.spawned).toHaveLength(0);
  })

  it('refuses a follow-up into the paused task session', async () => {
    const h = harness(workspace(), { tasks: tasks() });
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-1' },
        scope: '继续',
        instruction: '接着做',
        parallel: false,
      }),
    ).rejects.toThrow(/暂停/);
  })

  it('still lets a task target dispatch when the task is running', async () => {
    const h = harness(workspace(), { tasks: tasks({ status: 'running', handoffs: [] }) });
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '继续',
      instruction: '接着做',
      parallel: false,
    });
    await drain(h)
    expect(h.sent.length + h.spawned.length).toBe(1);
  })

  it('spawns for a different owner once the previous worker handed off', async () => {
    // Live on T-1 at 05:11: 1.1's worker (builtin-default, 261113-zesty-glass) handed off, the task
    // sat paused/awaiting_dispatch with no lock — and dispatching 2.1 (agent-ui) was refused with
    // 「T-1 正在由 builtin-default 执行」 because the old session merely still existed. Every retry
    // hit the same wall, so the task could never move again.
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        currentSessionId: 'sess_old',
        stats: { lockSessionId: undefined },
        spec: {
          scope: '三条大纲',
          plan: [
            { id: '1.1', status: 'done', agent: 'builtin-default' },
            { id: '2.1', status: 'todo', agent: 'agent-ui' },
          ],
          directive: { text: '继续 2.1', at: 400 },
        },
        handoffs: [{ outcome: 'handoff', at: 300 }],
      }),
    })
    // The old worker is still in the session table, idle — existence is not liveness.
    h.sessions.set('sess_old', {
      id: 'sess_old',
      role: 'worker',
      spawnDepth: 1,
      isProcessing: false,
      agentId: 'builtin-default',
    } as never)

    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      stepId: '2.1',
      scope: '界面小节',
      instruction: '产出 docs/ui.md',
      parallel: false,
    })
    await drain(h)
    // A new session for the owner the plan names — not a message into the default agent's session.
    expect(h.sent.filter((s) => s.sessionId === 'sess_old')).toHaveLength(0)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.agentId).toBe('agent-ui')
  })

  it('refuses a report that belongs to another section', async () => {
    // 2.1 is the section being handed over; the only accepted report names 1.1. Time-wise it is
    // newer than everything, so a timestamp-only gate would wave it through — the section would
    // start with a report about work it does not inherit.
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        sessionIds: ['sess_default', 'sess_ui'],
        currentSessionId: 'sess_ui',
        stats: { lockSessionId: undefined },
        spec: {
          plan: [
            { id: '1.1', status: 'done', agent: 'builtin-default', updatedAt: 100, executedBy: 'sess_default' },
            { id: '2.1', status: 'done', agent: 'agent-ui', updatedAt: 200, executedBy: 'sess_ui' },
            { id: '3.1', status: 'todo', agent: 'builtin-default' },
          ],
          directive: { text: '继续 3.1', at: 1000 },
        },
        handoffs: [{ outcome: 'handoff', at: 999, passed: true, stepId: '1.1' }],
      }),
    })
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-1' },
        stepId: '3.1',
        scope: '收尾',
        instruction: '核对两份文档',
        parallel: false,
      }),
    ).rejects.toThrow(/交接报告/)
    await drain(h)
    expect(h.spawned).toHaveLength(0)
  })

  it('accepts the hand-off that names the section being handed over', async () => {
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        sessionIds: ['sess_default', 'sess_ui'],
        currentSessionId: 'sess_ui',
        stats: { lockSessionId: undefined },
        spec: {
          plan: [
            { id: '1.1', status: 'done', agent: 'builtin-default', updatedAt: 100, executedBy: 'sess_default' },
            { id: '2.1', status: 'done', agent: 'agent-ui', updatedAt: 200, executedBy: 'sess_ui' },
            { id: '3.1', status: 'todo', agent: 'builtin-default' },
          ],
          directive: { text: '继续 3.1', at: 400 },
        },
        handoffs: [
          { outcome: 'handoff', at: 250, passed: true, stepId: '1.1' },
          { outcome: 'handoff', at: 350, passed: true, stepId: '2.1' },
        ],
      }),
    })
    h.sessions.set('sess_default', {
      id: 'sess_default', role: 'worker', spawnDepth: 1, isProcessing: false,
      agentId: 'builtin-default', taskId: 'T-1',
      taskScope: { taskId: 'T-1', outlineId: '1', stepIds: ['1.1'] },
    } as never)
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      stepId: '3.1',
      scope: '收尾',
      instruction: '核对两份文档',
      parallel: false,
    })
    await drain(h)
    // 2.1's report is the one that covers the section being handed over → the reuse is allowed.
    expect(h.spawned).toHaveLength(0)
    expect(h.sent.filter((s) => s.sessionId === 'sess_default')).toHaveLength(1)
  })

  it('accepts an unlabelled report rather than deadlocking on a missing stepId', async () => {
    // A worker that forgot `stepId` still produced a real hand-off. Refusing forever would leave
    // the task stuck on a wording mistake; a report labelled for ANOTHER section is still refused.
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        sessionIds: ['sess_default'],
        currentSessionId: 'sess_default',
        stats: { lockSessionId: undefined },
        spec: {
          plan: [
            { id: '1.1', status: 'done', agent: 'builtin-default', updatedAt: 100, executedBy: 'sess_default' },
            { id: '1.2', status: 'todo', agent: 'builtin-default' },
          ],
          directive: { text: '继续 1.2', at: 200 },
        },
        handoffs: [{ outcome: 'handoff', at: 150, passed: true }],
      }),
    })
    // Same session continues, but it has an executedBy on the *previous* step only; the gate reads
    // the unlabelled report as covering it.
    h.sessions.set('sess_default', {
      id: 'sess_default', role: 'worker', spawnDepth: 1, isProcessing: false,
      agentId: 'builtin-default', taskId: 'T-1',
      taskScope: { taskId: 'T-1', outlineId: '1', stepIds: ['1.1'] },
    } as never)
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      stepId: '1.2',
      scope: '补数据',
      instruction: '继续写 docs/data.md',
      parallel: false,
    })
    await drain(h)
    expect(h.spawned).toHaveLength(0)
    expect(h.sent.filter((s) => s.sessionId === 'sess_default')).toHaveLength(1)
  })

  it('refuses a fresh session when the previous section was never reported', async () => {
    // The rule as stated by the person: before a section runs, compare the session that ran the
    // PREVIOUS section with the one that will run this one. Here 2.1 ran in sess_ui, 3.1 has never
    // run, and there is no accepted report — so handing 3.1 to another session starts it cold.
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        sessionIds: ['sess_default', 'sess_ui'],
        currentSessionId: 'sess_ui',
        stats: { lockSessionId: undefined },
        spec: {
          plan: [
            { id: '1.1', status: 'done', agent: 'builtin-default', updatedAt: 100, executedBy: 'sess_default' },
            { id: '2.1', status: 'done', agent: 'agent-ui', updatedAt: 200, executedBy: 'sess_ui' },
            { id: '3.1', status: 'todo', agent: 'builtin-default' },
          ],
          directive: { text: '继续 3.1', at: 300 },
        },
        handoffs: [],
      }),
    })
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-1' },
        stepId: '3.1',
        scope: '收尾',
        instruction: '核对两份文档',
        parallel: false,
      }),
    ).rejects.toThrow(/交接报告/)
    await drain(h)
    expect(h.spawned).toHaveLength(0)
  })

  it('reuses an idle session of the same agent for a later section', async () => {
    // T-1 (live, 05:36): 1.1 and 3.1 both belonged to the default agent and still ran in two
    // sessions, because reuse only ever looked at `currentSessionId` — a pointer that had moved
    // to the agent-ui session in between. The pool is every session the task ran in.
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        sessionIds: ['sess_default', 'sess_ui'],
        currentSessionId: 'sess_ui',
        stats: { lockSessionId: undefined },
        spec: {
          plan: [
            { id: '1.1', status: 'done', agent: 'builtin-default', updatedAt: 100, executedBy: 'sess_default' },
            { id: '2.1', status: 'done', agent: 'agent-ui', updatedAt: 200, executedBy: 'sess_ui' },
            { id: '3.1', status: 'todo', agent: 'builtin-default' },
          ],
          directive: { text: '继续 3.1', at: 300 },
        },
        handoffs: [{ outcome: 'handoff', at: 250, passed: true }],
      }),
    })
    h.sessions.set('sess_default', {
      id: 'sess_default', role: 'worker', spawnDepth: 1, isProcessing: false,
      agentId: 'builtin-default', taskId: 'T-1',
      taskScope: { taskId: 'T-1', outlineId: '1', stepIds: ['1.1'] },
    } as never)
    h.sessions.set('sess_ui', {
      id: 'sess_ui', role: 'worker', spawnDepth: 1, isProcessing: false,
      agentId: 'agent-ui', taskId: 'T-1',
      taskScope: { taskId: 'T-1', outlineId: '2', stepIds: ['2.1'] },
    } as never)

    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      stepId: '3.1',
      scope: '收尾',
      instruction: '核对两份文档',
      parallel: false,
    })
    await drain(h)
    // Reused the default agent's idle session instead of opening a third one for the task.
    expect(h.spawned).toHaveLength(0)
    expect(h.sent.filter((s) => s.sessionId === 'sess_default')).toHaveLength(1)
  })

  it('refuses a different session for the same agent until a report exists', async () => {
    // Same profile, different session: the new session holds none of the previous transcript, so
    // it owes the same hand-off a profile change does.
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        sessionIds: ['sess_old_default'],
        currentSessionId: 'sess_old_default',
        stats: { lockSessionId: undefined },
        spec: {
          plan: [{ id: '1.2', status: 'todo', agent: 'builtin-default', executedBy: 'sess_gone' }],
          directive: { text: '继续 1.2', at: 300 },
        },
        handoffs: [],
      }),
    })
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-1' },
        stepId: '1.2',
        scope: '补数据',
        instruction: '继续写 docs/data.md',
        parallel: false,
      }),
    ).rejects.toThrow(/交接报告/)
    await drain(h)
    expect(h.spawned).toHaveLength(0)
  })

  it('refuses a step whose predecessor in the plan is unfinished', async () => {
    // Q1: outline 1 = 1.1 (builtin-default) + 1.2 (agent-ui). Dispatching 1.2 while 1.1 is still
    // open would start a second owner on a section nobody finished; the plan order is the rule.
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        stats: { lockSessionId: undefined },
        spec: {
          plan: [
            { id: '1.1', status: 'doing', agent: 'builtin-default' },
            { id: '1.2', status: 'todo', agent: 'agent-ui' },
          ],
          directive: { text: '按计划推进', at: 400 },
        },
        handoffs: [{ outcome: 'handoff', at: 300, passed: true }],
      }),
    })
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-1' },
        stepId: '1.2',
        scope: '界面',
        instruction: '写 docs/ui.md',
        parallel: false,
      }),
    ).rejects.toThrow(/1\.1.*还没完成|还没完成/)
    await drain(h)
    expect(h.spawned).toHaveLength(0)
  })

  it('refuses an owner change when the previous section was never reported', async () => {
    // A section marked done with no accepted hand-off behind it has nothing to hand over: the next
    // owner would start cold while the record claims the work changed hands.
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        stats: { lockSessionId: undefined },
        spec: {
          plan: [
            { id: '1.2', status: 'done', agent: 'builtin-default', updatedAt: 500 },
            { id: '2.1', status: 'todo', agent: 'agent-ui' },
          ],
          directive: { text: '继续 2.1', at: 600 },
        },
        // A rejected attempt is not a report (`passed: false`).
        handoffs: [{ outcome: 'handoff', at: 550, passed: false }],
      }),
    })
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-1' },
        stepId: '2.1',
        scope: '界面',
        instruction: '写 docs/ui.md',
        parallel: false,
      }),
    ).rejects.toThrow(/交接报告/)
    await drain(h)
    expect(h.spawned).toHaveLength(0)
  })

  it('lets the same owner continue without demanding a report', async () => {
    // Consecutive steps of one profile are a continuation, not a hand-off: the run lock orders them.
    const h = harness(workspace(), {
      tasks: tasks({
        status: 'paused',
        stats: { lockSessionId: undefined },
        spec: {
          plan: [
            { id: '1.1', status: 'done', agent: 'builtin-default', updatedAt: 500 },
            { id: '1.2', status: 'todo', agent: 'builtin-default' },
          ],
          directive: { text: '继续 1.2', at: 600 },
        },
        handoffs: [],
      }),
    })
    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      stepId: '1.2',
      scope: '数据补充',
      instruction: '继续写 docs/data.md',
      parallel: false,
    })
    await drain(h)
    expect(h.spawned).toHaveLength(1)
  })
  /**
   * The order the design intends: answer → directive → dispatch → work.
   *
   * The old gate said 「paused 的任务不能派活，先恢复它」, and 「恢复」 meant
   * `task_update({status:'running'})`, which starts a run. So the supervisor resumed the task to
   * satisfy the gate, the worker woke up before any dispatch arrived and did the next step on its
   * own, and the dispatch it had queued was refused as a duplicate. Live proof: resume at
   * 11:39:37, 1.2 done by 11:40:01, dispatch refused at 11:40:28.
   *
   * Authorization is a date, not a state: a directive written after the slice that stopped the task.
   */
  describe('a paused task takes work only when the authorisation is current', () => {
    it('accepts a dispatch once the directive is newer than the last hand-off', async () => {
      const h = harness(workspace(), {
        tasks: tasks({
          handoffs: [{ outcome: 'handoff', at: 100 }],
          spec: {
            scope: '只做 1.1',
            plan: [{ id: '2', status: 'todo' }],
            directive: { text: '做完 1.2 再停', at: 200 },
          },
        }),
      })
      const result = await h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-1' },
        stepId: '2',
        scope: '收尾',
        instruction: '执行步骤 2',
        parallel: false,
      })
      // Authorisation is current, so the dispatch is accepted — and queued, not started.
      expect(result.queued).toBe(true)
      await drain(h)
      expect(h.spawned.length).toBeGreaterThan(0)
    })

    it('keeps the authorisation across a slice hand-over', async () => {
      // Live on T-1 (2026-11-13): directive at 06:17:05 covering 1.1/2.1/3.1, hand-off at
      // 06:18:04, and dispatch of 2.1 refused at 06:18:08 with 「没有覆盖这次继续的授权」. The
      // person had already said 「全部做完」; the gate read the hand-over as a withdrawal.
      const h = harness(workspace(), {
        tasks: tasks({
          pauseReason: 'awaiting_dispatch',
          lifecycle: { lastPausedAt: 200 },
          handoffs: [{ outcome: 'handoff', at: 200, passed: true, stepId: '1.1' }],
          spec: {
            scope: '三条大纲',
            plan: [
              { id: '1.1', status: 'done', agent: 'builtin-default', updatedAt: 150 },
              { id: '2.1', status: 'todo', agent: 'agent-ui' },
            ],
            directive: { text: '按原话完成 1.1、2.1、3.1，全部完成即结束', at: 100 },
          },
        }),
      })
      const result = await h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-1' },
        stepId: '2.1',
        scope: '界面',
        instruction: '写 docs/ui.md',
        parallel: false,
      })
      expect(result.queued).toBe(true)
    })

    it("refuses when the person's boundary was reached and the directive predates it", async () => {
      // 「做完 1.1 就停」 is a stop the person owns: `awaiting_release`, not a plain hand-off.
      // (A plain `handoff` means 「this slice is done, the plan continues」 and must NOT end the
      // authorisation — that distinction is what the previous version of this case got wrong.)
      const h = harness(workspace(), {
        tasks: tasks({
          pauseReason: 'awaiting_release',
          lifecycle: { lastPausedAt: 300 },
          handoffs: [{ outcome: 'handoff', at: 300 }],
          spec: {
            scope: '只做 1.1',
            plan: [{ id: '2', status: 'todo' }],
            directive: { text: '只做 1.1', at: 100 },
          },
        }),
      })
      await expect(
        h.runtime.dispatch({
          fromSessionId: 'sess_sup',
          target: { kind: 'task', taskId: 'T-1' },
          stepId: '2',
          scope: '收尾',
          instruction: '执行步骤 2',
          parallel: false,
        }),
      ).rejects.toThrow(/没有覆盖这次继续的授权/)
      expect(h.spawned).toHaveLength(0)
    })
  })

})

/**
 * The race the queue exists to remove.
 *
 * Observed live: the supervisor dispatched 1.2, the worker finished it before the supervisor's
 * turn ended, the supervisor reported 「已完成 1.2 并暂停」 from a state it had already caused,
 * and the queued hand-off then made it report the same completion a second time.
 *
 * With the dispatch deferred, the worker cannot start before the turn ends — so the turn cannot
 * describe work that has not begun.
 */
describe('a dispatch does not start work inside the turn that asked for it', () => {
  it('leaves the worker untouched until the turn ends', async () => {
    const h = harness(workspace(), {
      tasks: new Map([['T-1', { id: 'T-1', assigneeAgentId: 'builtin-default' } as never]]),
    })

    const result = await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'new' },
      scope: '读回确认',
      instruction: '执行 1.2',
      attachTaskId: 'T-1',
      parallel: false,
    })

    // Queued, and nothing has started: no session, no worker, nobody to hand off mid-turn.
    expect(result.queued).toBe(true)
    expect(h.spawned).toHaveLength(0)
    expect(h.sent).toHaveLength(0)

    await drain(h)
    expect(h.spawned).toHaveLength(1)
  })

  it('reports a queue position, so the receipt can be honest about ordering', async () => {
    const h = harness(workspace(), {
      tasks: new Map([
        ['T-1', { id: 'T-1', assigneeAgentId: 'builtin-default' } as never],
        ['T-2', { id: 'T-2', assigneeAgentId: 'builtin-default' } as never],
      ]),
    })
    const first = await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'new' },
      scope: '甲',
      instruction: '第一件事',
      attachTaskId: 'T-1',
      parallel: false,
    })
    // A second task, not a second spawn for the first one: one task runs one step at a time,
    // so two spawns for T-1 would be a refusal (see the serial-mode cases above).
    const second = await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'new' },
      scope: '乙',
      instruction: '第二件事',
      attachTaskId: 'T-2',
      parallel: false,
    })
    expect(first.position).toBe(1)
    expect(second.position).toBe(2)
    await drain(h)
    // Order is the order they were asked for, not the order the scheduler felt like.
    expect(h.spawned.map((s) => s.scope)).toEqual(['甲', '乙'])
  })
})

/**
 * Two conversations, one runtime.
 *
 * The runtime is per workspace because routes, the event backlog and the per-rule ceilings are
 * workspace facts. A turn is not: it belongs to one conversation. Observed consequence of
 * sharing it — whichever supervisor finished first drained the other's queue, so the user lane
 * ending a turn started work the task lane had asked for, and the failure notice went to the
 * wrong supervisor.
 */
describe('each supervisor lane owns its own turn', () => {
  it('does not drain the other lane queue when one lane goes idle', async () => {
    const h = harness(workspace(), {
      tasks: new Map([['T-1', { id: 'T-1', assigneeAgentId: 'builtin-default' } as never]]),
    })
    h.sessions.set('sess_task_lane', { id: 'sess_task_lane', role: 'supervisor', isProcessing: true } as never)
    h.sessions.set('sess_user_lane', { id: 'sess_user_lane', role: 'supervisor', isProcessing: true } as never)

    await h.runtime.dispatch({
      fromSessionId: 'sess_task_lane',
      target: { kind: 'new' },
      scope: '读回确认',
      instruction: '执行 1.2',
      attachTaskId: 'T-1',
      parallel: false,
    })
    expect(h.spawned).toHaveLength(0)

    // The *other* lane's turn ends first. Nothing it did should start the task lane's work.
    await h.runtime.onSupervisorIdle('sess_user_lane')
    expect(h.spawned).toHaveLength(0)

    // Its own turn ending is what starts it.
    await h.runtime.onSupervisorIdle('sess_task_lane')
    expect(h.spawned).toHaveLength(1)
  })

  it('counts fan-out per lane, so one lane cannot exhaust the other', async () => {
    const h = harness(workspace(), {
      tasks: new Map([
        ['T-1', { id: 'T-1', assigneeAgentId: 'builtin-default' } as never],
        ['T-2', { id: 'T-2', assigneeAgentId: 'builtin-default' } as never],
        ['T-3', { id: 'T-3', assigneeAgentId: 'builtin-default' } as never],
        ['T-4', { id: 'T-4', assigneeAgentId: 'builtin-default' } as never],
        ['T-5', { id: 'T-5', assigneeAgentId: 'builtin-default' } as never],
      ]),
    })
    h.sessions.set('sess_task_lane', { id: 'sess_task_lane', role: 'supervisor', isProcessing: true } as never)
    h.sessions.set('sess_user_lane', { id: 'sess_user_lane', role: 'supervisor', isProcessing: true } as never)

    // Three from the task lane, one task each — the ceiling is per turn, not per task.
    for (let i = 0; i < 3; i += 1) {
      await h.runtime.dispatch({
        fromSessionId: 'sess_task_lane',
        target: { kind: 'new' },
        scope: `任务 ${i}`,
        instruction: `做 ${i}`,
        attachTaskId: `T-${i + 1}`,
        parallel: true,
      })
    }
    // A fourth from that lane is refused…
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_task_lane',
        target: { kind: 'new' },
        scope: '第四个',
        instruction: '再来一个',
        attachTaskId: 'T-4',
        parallel: true,
      }),
    ).rejects.toThrow()
    // … while the other lane still has its full allowance.
    await h.runtime.dispatch({
      fromSessionId: 'sess_user_lane',
      target: { kind: 'new' },
      scope: '建任务',
      instruction: '建一条任务',
      attachTaskId: 'T-5',
      parallel: true,
    })
    expect(h.runtime.dispatchesThisTurn('sess_user_lane')).toBe(1)
  })

  it('resets the cap when a turn begins, and keeps the ping-pong guard across it', async () => {
    const h = harness(workspace(), {
      tasks: new Map([
        ['T-1', { id: 'T-1', assigneeAgentId: 'builtin-default' } as never],
        ['T-2', { id: 'T-2', assigneeAgentId: 'builtin-default' } as never],
        ['T-3', { id: 'T-3', assigneeAgentId: 'builtin-default' } as never],
      ]),
    })
    const one = {
      fromSessionId: 'sess_sup',
      target: { kind: 'new' as const },
      scope: '同一件事',
      instruction: '把输入框改成两行',
      attachTaskId: 'T-1',
      parallel: false,
    }
    // Two dispatches, two tasks: the counting is what this case is about, and one task cannot
    // carry two spawns (serial mode refuses the second in the result).
    await h.runtime.dispatch(one)
    await h.runtime.dispatch({ ...one, attachTaskId: 'T-2' })
    // No `onSupervisorIdle` here on purpose: this is the case `beginTurn` exists for — a turn
    // that ended without going through the idle path (a reload, a crashed turn, a resumed
    // session). Counting must not carry over, or the cap becomes a lifetime quota.
    expect(h.runtime.dispatchesThisTurn('sess_sup')).toBe(2)

    h.runtime.beginTurn('sess_sup')
    expect(h.runtime.dispatchesThisTurn('sess_sup')).toBe(0)

    // The guard is a different matter: repetition is still remembered, and this is the third
    // time in a row, so it is refused rather than counted into the new turn.
    await expect(h.runtime.dispatch({ ...one, attachTaskId: 'T-3' })).rejects.toThrow(/again|重复|3/)
  })
})

/**
 * A dispatch into a live session is still the start of a run.
 *
 * Observed on T-1: the task was `paused`, the supervisor dispatched step 1.2 into the session that
 * already owned it, the worker did 2.1 and 2.2 — and the task stayed `paused`, because this path
 * was the one dispatch shape that claimed nothing. The worker's `delivered` hand-off was then
 * refused as `paused → completed`, and since neither lane may set `running` by hand, the task could
 * never finish. The spawn path never had this gap: 5947 / 7710 / 8397 all claim.
 */
describe('a dispatch into an existing session claims the run', () => {
  const sessionTask = () =>
    new Map([
      ['T-1', { id: 'T-1', currentSessionId: 'sess_worker_live', assigneeAgentId: 'builtin-default' } as never],
    ]);

  function withLiveSession(h: Harness, taskId = 'T-1') {
    h.sessions.set('sess_worker_live', {
      id: 'sess_worker_live',
      role: 'worker',
      isProcessing: false,
      taskId,
    } as never);
  }

  it('claims the task when the instruction goes out', async () => {
    const h = harness(workspace(), { tasks: sessionTask() });
    withLiveSession(h)

    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '读回确认',
      instruction: '执行 1.2',
      stepId: '1.2',
      parallel: false,
    })
    // Queued, not sent: nothing is claimed while the supervisor is still reasoning.
    expect(h.claimed).toEqual([])

    await drain(h)
    expect(h.sent).toHaveLength(1)
    expect(h.claimed).toEqual([{ taskId: 'T-1', sessionId: 'sess_worker_live' }])
  })

  it('claims before sending, so a failed send cannot leave the task behind', async () => {
    const h = harness(workspace(), { tasks: sessionTask() });
    withLiveSession(h)
    const order: string[] = []
    const originalSend = h.runtime['deps'].sendToSession
    h.runtime['deps'].sendToSession = async (sessionId, text) => {
      order.push(`send:${sessionId}`)
      await originalSend(sessionId, text)
    }
    h.runtime['deps'].claimRun = (taskId, sessionId) => {
      order.push(`claim:${taskId}`)
      h.claimed.push({ taskId, sessionId })
    }

    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-1' },
      scope: '读回确认',
      instruction: '执行 1.2',
      stepId: '1.2',
      parallel: false,
    })
    await drain(h)

    expect(order).toEqual(['claim:T-1', 'send:sess_worker_live'])
  })

  it('claims nothing when the dispatch carries no task', async () => {
    const h = harness(workspace())
    h.sessions.set('sess_plain', { id: 'sess_plain', role: 'worker', isProcessing: false } as never)

    // A session with no task cannot be dispatched to at all — that rule is older and separate.
    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'session', sessionId: 'sess_plain' },
        scope: '杂活',
        instruction: '做点什么',
        parallel: false,
      }),
    ).rejects.toThrow(/没有挂任务/)
    await drain(h)
    expect(h.claimed).toEqual([])
  })
})

/**
 * A finished task takes no more work.
 *
 * Every other door already refuses one: `startGate` checks `TERMINAL_STATUSES`, `applyTransition`
 * has no `completed → running`, and `updateTask({status:'running'})` throws. Dispatch did not, so
 * an instruction went out for a task that could never record it — the worker was briefed, the
 * claim was refused, and the board said 「已完成」 while a session worked under its name.
 */
describe('a finished task accepts no dispatch', () => {
  const finished = (status: 'completed' | 'canceled') =>
    new Map([[`T-9`, { id: 'T-9', status, assigneeAgentId: 'builtin-default' } as never]])

  for (const status of ['completed', 'canceled'] as const) {
    it(`refuses a ${status} task by name, whichever target shape is used`, async () => {
      const h = harness(workspace(), { tasks: finished(status) })

      // task target
      await expect(
        h.runtime.dispatch({
          fromSessionId: 'sess_sup',
          target: { kind: 'task', taskId: 'T-9' },
          scope: '返工',
          instruction: '再做一次',
          parallel: false,
        }),
      ).rejects.toThrow(new RegExp(`T-9 已经${status === 'completed' ? '完成' : '取消'}`))

      // new-session target carrying the same task id — the door that bypassed the paused rule once
      await expect(
        h.runtime.dispatch({
          fromSessionId: 'sess_sup',
          target: { kind: 'new' },
          scope: '返工',
          instruction: '再做一次',
          attachTaskId: 'T-9',
          parallel: false,
        }),
      ).rejects.toThrow(/不能再派活/)

      await drain(h)
      expect(h.spawned).toEqual([])
      expect(h.claimed).toEqual([])
    })
  }


  it('words a refusal differently for a task that repeats', async () => {
    // Live: 「每分钟你好循环」 finished its plan, the round was not seen as finished, and the refusal
    // told the supervisor to open a new section — so each minute added `2`/`2.1`, then `3`/`3.1`.
    // The advice is the bug: for a repeating task a finished plan means the round is over.
    const tasks = new Map([
      [
        'T-7',
        {
          id: 'T-7',
          assigneeAgentId: 'builtin-default',
          triggers: [{ kind: 'cron', enabled: true }],
          spec: { plan: [{ id: '1.1', title: '发一句', status: 'done' }] },
        } as never,
      ],
    ])
    const h = harness(workspace(), { tasks })

    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-7' },
        stepId: '1.1',
        scope: '本轮',
        instruction: '再来一轮',
        parallel: false,
      } as never),
    ).rejects.toThrow(/不要为了「第 N 轮」新开一节/)
  })

  it('does not let user approval resurrect a finished task', async () => {
    const h = harness(workspace(), { tasks: finished('completed') })

    await expect(
      h.runtime.dispatch({
        fromSessionId: 'sess_sup',
        target: { kind: 'task', taskId: 'T-9' },
        scope: '返工',
        instruction: '用户说继续',
        parallel: false,
        // The escape hatch for the paused rule must not double as a way past completion.
        userApproved: true,
      } as never),
    ).rejects.toThrow(/已经完成了/)

    await drain(h)
    expect(h.claimed).toEqual([])
  })

  it('still accepts a paused task whose authorisation is newer than the last hand-off', async () => {
    const h = harness(workspace(), {
      tasks: new Map([
        [
          'T-5',
          {
            id: 'T-5',
            status: 'paused',
            assigneeAgentId: 'builtin-default',
            spec: { directive: { text: '做完剩下的', at: 2000 } },
            handoffs: [{ outcome: 'handoff', at: 1000 }],
            // A live session makes this a send-to-existing-session dispatch, which is the shape
            // that carries `claimRun` — the one this file's first suite is about.
            currentSessionId: 'sess_live5',
          } as never,
        ],
      ]),
    })
    h.sessions.set('sess_live5', { id: 'sess_live5', role: 'worker', isProcessing: false, taskId: 'T-5' } as never)

    await h.runtime.dispatch({
      fromSessionId: 'sess_sup',
      target: { kind: 'task', taskId: 'T-5' },
      scope: '收尾',
      instruction: '继续做完',
      parallel: false,
    })
    await drain(h)
    // The terminal check must not swallow the legitimate 「authorised continue」 case.
    expect(h.sent).toHaveLength(1)
    expect(h.claimed).toEqual([{ taskId: 'T-5', sessionId: 'sess_live5' }])
  })
})
