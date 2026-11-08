import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskService } from './task-service.ts';

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-task-svc-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function service(root: string, opts: { alive?: string[]; now?: () => number } = {}) {
  const wakes: Array<{ sessionId: string; text: string }> = [];
  const alive = new Set(opts.alive ?? []);
  const svc = new TaskService({
    workspaceRoot: root,
    sessionExists: (id) => alive.has(id),
    wakeSupervisor: (sessionId, text) => wakes.push({ sessionId, text }),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { svc, wakes };
}

const create = (svc: TaskService) =>
  svc.create({
    name: '多 Agent 上线',
    instruction: '把文档里的都做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
  });

describe('task creation', () => {
  it('creates a backlog task with a human id', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    expect(task.id).toBe('T-1');
    expect(task.status).toBe('backlog');
  });

  it('dedupes on the originating tool call', () => {
    const { svc } = service(workspace());
    const first = create(svc);
    const again = create(svc);
    expect(again.id).toBe(first.id);
    expect(svc.list()).toHaveLength(1);
  });
});

describe('status transitions', () => {
  it('starts and pauses a task', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    expect(svc.setStatus(task.id, 'running').status).toBe('running');
    expect(svc.setStatus(task.id, 'paused', { pauseReason: 'waiting' }).pauseReason).toBe('waiting');
  });

  it('refuses an illegal transition', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.setStatus(task.id, 'completed');
    expect(() => svc.setStatus(task.id, 'running')).toThrow();
  });
});

describe('handoff gate', () => {
  it('fails a handoff with no artifacts and keeps the task running', async () => {
    const { svc, wakes } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.attachSession(task.id, 'sess_worker');

    const result = await svc.reportHandoff(task.id, { summary: '做完了' }, 'sess_worker');
    expect(result.passed).toBe(false);
    expect(result.task.status).toBe('running');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(wakes[0]?.text).toContain('交接未通过');
  });

  it('passes when artifacts exist and verification ran', async () => {
    const ws = workspace();
    const artifact = join(ws, 'out.txt');
    writeFileSync(artifact, 'ok', 'utf-8');

    const { svc } = service(ws);
    const task = create(svc);
    svc.setStatus(task.id, 'running');

    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '完成',
        artifacts: [{ path: artifact }],
        verify: { ran: ['bun test'], passed: true },
      },
      'sess_worker',
    );
    expect(result.passed).toBe(true);
    expect(result.task.status).toBe('completed');
  });

  it('pauses on a needs_decision handoff', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    const result = await svc.reportHandoff(task.id, { outcome: 'needs_decision', summary: '要你定' }, 'sess_w');
    expect(result.task.status).toBe('paused');
    expect(result.task.pauseReason).toBe('needs_decision');
  });

  it('trips the fuse after three rejected handoffs', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    for (let i = 0; i < 3; i += 1) {
      await svc.reportHandoff(task.id, { summary: `第 ${i} 次` }, 'sess_w');
    }
    const final = svc.get(task.id);
    expect(final?.status).toBe('paused');
    expect(final?.pauseReason).toBe('failures');
  });
});

describe('budget guard', () => {
  it('pauses when the session cap is exceeded', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    for (let i = 0; i < 9; i += 1) svc.attachSession(task.id, `sess_${i}`);
    const paused = svc.setStatus(task.id, 'running');
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toBe('budget');
  });
});

describe('restart recovery', () => {
  it('pauses a running task whose session disappeared', () => {
    const ws = workspace();
    const { svc } = service(ws);
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.attachSession(task.id, 'sess_gone');

    const recovered = svc.recoverAfterRestart();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('paused');
    expect(recovered[0].pauseReason).toBe('process_lost');
  });

  it('leaves a task alone while its session is alive', () => {
    const ws = workspace();
    const { svc } = service(ws, { alive: ['sess_alive'] });
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.attachSession(task.id, 'sess_alive');
    svc.heartbeat(task.id);

    expect(svc.recoverAfterRestart()).toHaveLength(0);
  });
});

describe('revision tracking', () => {
  it('keeps the old handoff and gives a new commit a fresh round', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');

    // First review fails against commit aaa.
    await svc.reportHandoff(
      task.id,
      { summary: '发现两个问题', revision: 'aaa' },
      'sess_w',
    );
    let current = svc.get(task.id)!;
    expect(current.handoffs[0]?.revision).toBe('aaa');
    expect(current.verify.lastVerifiedRevision).toBe('aaa');
    expect(current.verifyRounds).toBe(1);

    // Human fixes and pushes bbb: the second round must not be blocked by the
    // rounds spent on aaa, and the first record must still be there.
    await svc.reportHandoff(
      task.id,
      { summary: 'bbb 已修复', revision: 'bbb' },
      'sess_w',
    );
    current = svc.get(task.id)!;
    expect(current.handoffs.map((h) => h.revision)).toEqual(['aaa', 'bbb']);
    expect(current.verify.lastVerifiedRevision).toBe('bbb');
    expect(current.verifyRounds).toBe(1);
  });

  it('keeps counting rounds within the same revision', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');

    await svc.reportHandoff(task.id, { summary: '第一次', revision: 'aaa' }, 'sess_w');
    await svc.reportHandoff(task.id, { summary: '第二次', revision: 'aaa' }, 'sess_w');

    expect(svc.get(task.id)!.verifyRounds).toBe(2);
  });
});

describe('task metadata', () => {
  it('keeps baseline and scope through create + reload', () => {
    const { svc } = service(workspace());
    const task = svc.create({
      name: '复核 PR',
      instruction: '复核这个 PR',
      supervisorSessionId: 'sup',
      toolCallId: 'call-meta',
      spec: {
        baseline: 'main 分支',
        scope: '只复核 src/api 下的改动',
      },
    });

    const reloaded = svc.get(task.id)!;
    expect(reloaded.spec?.baseline).toBe('main 分支');
    expect(reloaded.spec?.scope).toBe('只复核 src/api 下的改动');
  });
});

/**
 * `dispatch` has always required a `scope` — "one sentence describing what this
 * session is responsible for, so later dispatches can be matched to it". It never
 * reached the task: it fed a dedupe key and the default session title, then was
 * dropped. So a created task could not say what it was for, and nothing could
 * answer "which session is right for this" from data.
 */
describe('task scope', () => {
  it('records the responsibility', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setScope(task.id, '负责督导与任务板');
    expect(svc.get(task.id)?.spec?.scope).toBe('负责督导与任务板');
  })

  it('keeps the rest of the spec intact', () => {
    // updateSpec replaces the whole contract, so writing one sentence through it
    // would silently drop cwd/tools/acceptance.
    const { svc } = service(workspace());
    const task = create(svc);
    svc.updateSpec(task.id, { cwd: 'packages/shared', tools: ['read'], scope: 'old' })
    svc.setScope(task.id, 'new scope')
    const spec = svc.get(task.id)?.spec
    expect(spec?.scope).toBe('new scope')
    expect(spec?.cwd).toBe('packages/shared')
    expect(spec?.tools).toEqual(['read'])
  })

  it('ignores a blank scope instead of erasing the existing one', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setScope(task.id, 'kept')
    svc.setScope(task.id, '   ')
    expect(svc.get(task.id)?.spec?.scope).toBe('kept')
  })
})

describe('artifact paths resolve against the workspace', () => {
  /**
   * The first real run failed seven times on a file that existed.
   *
   * `probe` called `existsSync(path)` with the worker's relative path, which
   * resolved against the host process's cwd — not the workspace. The acceptance
   * commands resolved against the workspace root, so `test -s docs/a.md` passed
   * and the gate still said "missing deliverable: docs/a.md". The task was paused
   * for failures that were never real.
   */
  it('accepts a relative deliverable that exists in the workspace', async () => {
    const root = workspace();
    const { svc } = service(root);
    const task = create(svc);
    svc.startRun(task.id, 'sess_w');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), 'hello');

    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: 'wrote it',
        artifacts: [{ path: 'docs/a.md' }],
        verify: { ran: ['test -s docs/a.md'], passed: true },
      },
      'sess_w',
    );

    expect(result.reasons).not.toContain('missing artifact: docs/a.md');
    expect(result.reasons).not.toContain('missing deliverable: docs/a.md');
  });

  it('still rejects a deliverable that is genuinely absent', async () => {
    const root = workspace();
    const { svc } = service(root);
    const task = svc.create({
      name: 'missing',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_2',
      spec: {
        deliverables: [{ kind: 'file', path: 'docs/nope.md', required: true }],
      } as never,
    });
    svc.startRun(task.id, 'sess_w');

    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: 'claim',
        artifacts: [{ path: 'docs/nope.md' }],
        verify: { ran: ['test -s docs/nope.md'], passed: true },
      },
      'sess_w',
    );

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('missing deliverable: docs/nope.md');
  });
});
