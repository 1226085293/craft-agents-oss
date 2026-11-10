import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkDependencies,
  eventTriggerMatches,
  formatTaskBrief,
  isHeartbeatMissing,
  isRunLocked,
  normalizeSpec,
  normalizeTrigger,
  type Task,
  type TaskSpec,
} from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-contract-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function service(opts: {
  alive?: string[];
  acceptance?: (command: string, cwd?: string) => Promise<{ exitCode: number | null; output?: string }>;
  now?: () => number;
} = {}) {
  const alive = new Set(opts.alive ?? []);
  const wakes: Array<{ sessionId: string; text: string }> = [];
  const svc = new TaskService({
    workspaceRoot: root,
    sessionExists: (id) => alive.has(id),
    wakeSupervisor: (sessionId, text) => wakes.push({ sessionId, text }),
    ...(opts.acceptance ? { runAcceptanceCommand: opts.acceptance } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { svc, wakes };
}

const create = (svc: TaskService, spec?: TaskSpec) =>
  svc.create({
    name: '契约任务',
    instruction: '把事做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    ...(spec ? { spec } : {}),
  });

describe('normalizers', () => {
  it('drops malformed spec fields instead of trusting the model', () => {
    const spec = normalizeSpec({
      cwd: '   ',
      sources: ['linear', 3 as unknown as string],
      deliverables: [{ kind: 'nope' }, { kind: 'file', path: 'out.md' }],
      acceptance: [{ check: '' }, { id: 'a1', check: '文件非空', command: 'test -s out.md' }],
    });
    expect(spec?.cwd).toBeUndefined();
    expect(spec?.sources).toEqual(['linear']);
    expect(spec?.deliverables).toEqual([{ kind: 'file', path: 'out.md' }]);
    expect(spec?.acceptance?.[0].id).toBe('a1');
  });

  it('falls back to a manual trigger on an unknown kind', () => {
    expect(normalizeTrigger({ kind: 'webhook' })).toEqual({ kind: 'manual' });
    expect(normalizeTrigger({ kind: 'cron', expr: '0 9 * * *' })).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
      enabled: true,
    });
  });
});

describe('acceptance gate', () => {
  it('runs the declared commands and fails the handoff when one exits non-zero', async () => {
    const { svc, wakes } = service({
      acceptance: async (command) => ({ exitCode: command.includes('bad') ? 1 : 0 }),
    });
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');

    const task = create(svc, {
      acceptance: [
        { id: 'a1', check: '文件非空', command: 'test -s out.md' },
        { id: 'a2', check: '内容正确', command: 'grep bad out.md' },
      ],
    });
    svc.setStatus(task.id, 'running');

    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '完成',
        artifacts: [{ path: artifact }],
        verify: { ran: ['bun test'], passed: true },
      },
      'sess_w',
    );

    expect(result.passed).toBe(false);
    // Names the item, what it checks and the command — not just `a2 (exit 1)`.
    const text = result.reasons.join(' ');
    expect(text).toContain('a2');
    expect(text).toContain('未通过');
    expect(result.task.status).not.toBe('completed');
    expect(wakes[0]?.text).toContain('交接未通过');
  });

  it('accepts when every acceptance command exits zero', async () => {
    const { svc } = service({ acceptance: async () => ({ exitCode: 0 }) });
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');

    const task = create(svc, { acceptance: [{ id: 'a1', check: '文件非空', command: 'test -s out.md' }] });
    svc.setStatus(task.id, 'running');
    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '完成',
        artifacts: [{ path: artifact }],
        verify: { ran: ['bun test'], passed: true },
      },
      'sess_w',
    );
    expect(result.passed).toBe(true);
    expect(result.task.status).toBe('completed');
  });

  it('rejects an empty artifact (exists is not the same as readable)', async () => {
    const { svc } = service();
    const empty = join(root, 'empty.md');
    writeFileSync(empty, '', 'utf-8');

    const task = create(svc);
    svc.setStatus(task.id, 'running');
    const result = await svc.reportHandoff(
      task.id,
      { outcome: 'delivered', summary: '完成', artifacts: [{ path: empty }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('empty artifact');
  });

  it('requires declared deliverables, not just any artifact', async () => {
    const { svc } = service();
    const other = join(root, 'other.md');
    writeFileSync(other, 'x', 'utf-8');

    const task = create(svc, { deliverables: [{ kind: 'file', path: join(root, ' promised.md ') }] });
    svc.setStatus(task.id, 'running');
    const result = await svc.reportHandoff(
      task.id,
      { outcome: 'delivered', summary: '完成', artifacts: [{ path: other }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('missing deliverable');
  });
});

describe('run lifecycle', () => {
  it('refuses a second run while the first session still holds the lock', () => {
    const { svc } = service({ alive: ['sess_a'] });
    const task = create(svc);
    const first = svc.startRun(task.id, 'sess_a');
    expect(first.ok).toBe(true);

    const second = svc.startRun(task.id, 'sess_b');
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toContain('已经由 sess_a 持有');
  });

  it('blocks a task whose dependency is not completed', () => {
    const { svc } = service();
    const dep = create(svc);
    const dependent = svc.create({
      name: '后续',
      instruction: '等前面做完',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_2',
      dependsOn: [dep.id],
    });

    const blocked = svc.startRun(dependent.id, 'sess_b');
    expect(blocked.ok).toBe(false);
    expect((blocked as { reason: string }).reason).toContain('尚未完成');

    svc.setStatus(dep.id, 'running');
    svc.setStatus(dep.id, 'completed');
    expect(svc.startRun(dependent.id, 'sess_b').ok).toBe(true);
  });

  it('banks active time and releases the lock when a run ends', () => {
    let now = 1_000;
    const { svc } = service({ alive: ['sess_a'], now: () => now });
    const task = create(svc);
    svc.startRun(task.id, 'sess_a');

    now = 61_000;
    const ended = svc.endRun(task.id, { ok: false, error: 'boom' });
    expect(ended.stats?.activeMs).toBe(60_000);
    expect(ended.stats?.lockSessionId).toBeUndefined();
    expect(ended.lifecycle.consecutiveFailures).toBe(1);

    // The lock is gone, so a retry is allowed again.
    expect(svc.startRun(task.id, 'sess_b').ok).toBe(true);
  });

  it('counts runs so maxRuns actually trips', () => {
    const { svc } = service();
    const task = create(svc);
    for (let i = 0; i < 12; i += 1) {
      svc.startRun(task.id, `sess_${i}`);
      svc.endRun(task.id, { ok: true });
    }
    const paused = svc.setStatus(task.id, 'running');
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toBe('budget');
  });

  it('ignores a heartbeat when no run is in flight, and stamps it when one is', () => {
    const { svc } = service({ alive: ['sess_a'] });
    const task = create(svc);
    expect(svc.heartbeatForSession('sess_a')).toBeNull();

    svc.startRun(task.id, 'sess_a');
    const beaten = svc.heartbeatForSession('sess_a');
    expect(beaten?.id).toBe(task.id);
    expect(typeof beaten?.stats?.lastHeartbeatAt).toBe('number');
  });
});

describe('trigger editing', () => {
  it('switches a task from manual to cron and then to event', () => {
    const { svc } = service();
    const task = create(svc);
    expect(task.trigger).toEqual({ kind: 'manual' });

    const cron = svc.updateTrigger(task.id, { kind: 'cron', expr: '0 9 * * 1', enabled: true });
    expect(cron.trigger).toMatchObject({ kind: 'cron', expr: '0 9 * * 1', enabled: true });

    const event = svc.updateTrigger(task.id, { kind: 'event', source: 'mail', types: ['received'], enabled: true });
    expect(event.trigger).toMatchObject({ kind: 'event', source: 'mail', types: ['received'] });

    const manual = svc.updateTrigger(task.id, { kind: 'manual' });
    expect(manual.trigger).toEqual({ kind: 'manual' });
  })

  it('does not let an unknown trigger kind survive', () => {
    const { svc } = service();
    const task = create(svc);
    const updated = svc.updateTrigger(task.id, normalizeTrigger({ kind: 'webhook', url: 'x' }));
    expect(updated.trigger).toEqual({ kind: 'manual' });
  })
});

describe('pure rules', () => {
  const base = (over: Partial<Task>): Task => ({
    id: 'T-1',
    name: 't',
    instruction: 'i',
    status: 'running',
    supervisorSessionId: 's',
    sessionIds: [],
    dependsOn: [],
    priority: 0,
    budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120, deadline: null },
    handoffs: [],
    verify: { enabled: false, maxIterations: 3 },
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    origin: { supervisorSessionId: 's', toolCallId: 'c' },
    heartbeatIntervalMin: 10,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  it('treats a running task with no heartbeat at all as stalled', () => {
    const task = base({ stats: { runs: 1, activeMs: 0, runStartedAt: 0 } });
    expect(isHeartbeatMissing(task, 10 * 60_000 * 2 + 1)).toBe(true);
    expect(isHeartbeatMissing(task, 60_000)).toBe(false);
  });

  it('matches event triggers by source, type and text', () => {
    const trigger = { kind: 'event' as const, source: 'mail', enabled: true, types: ['received'], textMatch: '发票|invoice' };
    expect(eventTriggerMatches(trigger, { source: 'mail', type: 'received', title: '新 Invoice' })).toBe(true);
    expect(eventTriggerMatches(trigger, { source: 'mail', type: 'sent', title: 'Invoice' })).toBe(false);
    expect(eventTriggerMatches(trigger, { source: 'git', type: 'received', title: 'Invoice' })).toBe(false);
  });

  it('reports the exact blocking dependency', () => {
    const verdict = checkDependencies(base({ dependsOn: ['T-0'] }), () => ({ id: 'T-0', status: 'paused', name: '前置' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]).toContain('前置');
  });

  it('does not treat a dead lock holder as a lock', () => {
    const task = base({ stats: { runs: 1, activeMs: 0, lockSessionId: 'gone' } });
    expect(isRunLocked(task, () => false)).toBe(false);
    expect(isRunLocked(task, () => true)).toBe(true);
  });
});

describe('worker brief', () => {
  it('carries the contract, acceptance list and prior handoff', () => {
    const task = {
      id: 'T-7',
      name: '发布',
      instruction: '发一版',
      status: 'running',
      supervisorSessionId: 's',
      sessionIds: [],
      dependsOn: [],
      priority: 0,
      budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120, deadline: null },
      handoffs: [
        {
          at: 1,
          fromSessionId: 'w1',
          outcome: 'handoff' as const,
          summary: '已经跑通构建',
          keyFindings: ['版本号在 package.json'],
          nextAction: '打 tag',
          artifacts: [{ path: 'dist/app.asar' }],
        },
      ],
      verify: { enabled: true, maxIterations: 3 },
      lifecycle: { errorCount: 0, consecutiveFailures: 0 },
      origin: { supervisorSessionId: 's', toolCallId: 'c' },
      heartbeatIntervalMin: 10,
      createdAt: 0,
      updatedAt: 0,
      spec: {
        cwd: 'apps/electron',
        sources: ['github'],
        deliverables: [{ kind: 'pr' as const, note: '合并到 main' }],
        acceptance: [{ id: 'a1', check: '测试通过', command: 'bun test' }],
      },
      trigger: { kind: 'manual' as const },
    } satisfies Task;

    const brief = formatTaskBrief(task, { reason: 'cron:0 9 * * *' });
    expect(brief).toContain('T-7');
    expect(brief).toContain('apps/electron');
    expect(brief).toContain('测试通过');
    expect(brief).toContain('已经跑通构建');
    expect(brief).toContain('打 tag');
    expect(brief).toContain('cron:0 9 * * *');
    expect(brief).toContain('report_result');
  });
});
