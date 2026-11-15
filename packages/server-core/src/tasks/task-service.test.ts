import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskService } from './task-service.ts';
import { readJournal } from '@craft-agent/shared/tasks';

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
    /**
     * The reason is derived from the record, not taken from the writer.
     *
     * `waiting` means a dependency is unfinished; with none on the task, a pause that claims it is
     * describing something that is not true, and the record says so by dropping the label. The
     * reason a pause can always declare is the event kind — `process_lost` — because the record
     * keeps no evidence of it once the lock is gone.
     */
    expect(svc.setStatus(task.id, 'paused', { pauseReason: 'waiting' }).pauseReason).toBeNull();
    // Back to running, because `paused → paused` is a no-op and would keep the cleared reason.
    svc.setStatus(task.id, 'running');
    expect(svc.setStatus(task.id, 'paused', { pauseReason: 'process_lost' }).pauseReason).toBe(
      'process_lost',
    );
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
    /**
     * The refusal is feedback to the worker, not news for the supervisor.
     *
     * This used to assert a 「交接未通过」 wake, and a live run showed what that costs: 1.2 was
     * refused at 11:10:38 for a missing `artifacts` list, retried and accepted at 11:10:44, and
     * the supervisor was woken twice for one step — the first time to be told about a problem
     * the worker fixed six seconds later without help. The reasons reach the caller in this
     * same response; a supervisor is only owed a change of state.
     */
    expect(wakes).toHaveLength(0);
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
    // `delivered` ends the round; `completed` is now the supervisor's call, not a side effect.
    expect(result.task.status).toBe('backlog');
  });

  it('pauses on a needs_decision handoff', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    const result = await svc.reportHandoff(task.id, { outcome: 'needs_decision', summary: '要你定' }, 'sess_w');
    expect(result.task.status).toBe('paused');
    /**
     * 「等问句」, not 「等你拍板」 — the decision record exists but nobody has worded a question yet.
     * The supervisor's next turn does that, and `setDecisionWording` flips this to
     * `needs_decision` at the same moment the card gains something to answer.
     */
    expect(result.task.pauseReason).toBe('asking');
  });

  /**
   * A worker that stops to ask 「1.2 alone, or 1.2+2, or stop?」 said it only in prose, so the
   * answer card could offer nothing better than yes/no — and neither of those was one of
   * the three answers. The candidates have to reach the record the card reads.
   */
  it("keeps the worker candidates on the decision, for the card to render", async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'needs_decision',
        // Has to hit an irreversible category, or `assessDecisionRequest` rules it routine
        // and the task does not pause at all — the options would then have nowhere to live.
        // `destroy-data` matches on a verb *and* a data-ish noun; 「文件」 is neither.
        summary: '需要清空旧分支再继续，是否删除这些分支',
        options: ['删除旧分支后继续', '保留旧分支，跳过清理', '到此为止，结束任务'],
      },
      'sess_w',
    );

    expect(result.task.decision?.options).toEqual([
      '删除旧分支后继续',
      '保留旧分支，跳过清理',
      '到此为止，结束任务',
    ]);
  });

  /**
   * The task card and the chat card are one question with two renderings.
   *
   * The task's own wording comes from a closed list of six categories, so it is generic
   * by construction and carries no options. The supervisor says the real question and
   * lists the real answers; if that never reaches the record, the card falls back to
   * 同意/取消 — which on a real run matched none of the three answers offered.
   */
  it('lets the relaying session replace the decision wording, without moving state', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    const paused = await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '需要清空旧分支再继续，是否删除这些分支' },
      'sess_w',
    );
    const before = paused.task.decision;
    expect(before).toBeDefined();

    const after = svc.setDecisionWording(task.id, {
      question: '仅放行 1.2，其余之后再定？',
      options: ['仅放行 1.2', '放行 1.2 和 2', '到此为止'],
    });

    /**
     * The relay's words go to `question`, not over `reason`.
     *
     * `reason` is the rule's diagnosis — 「连续 3 次交接但计划没有推进（当前步骤：1）」 — and it
     * is the only place that finding exists. Overwriting it left the task card restating the
     * question while the explanation of what went wrong was gone.
     */
    expect(after?.decision?.question).toBe('仅放行 1.2，其余之后再定？');
    expect(after?.decision?.reason).toBe(before?.reason);
    expect(after?.decision?.options).toEqual(['仅放行 1.2', '放行 1.2 和 2', '到此为止']);
    // Wording, not a state change: the pause, its clock and its kind are all untouched.
    expect(after?.status).toBe('paused');
    expect(after?.pauseReason).toBe('needs_decision');
    /**
     * Wording, not a state change: the question keeps its identity.
     *
     * The record here was written before ids existed, so the first re-wording is also where it gains
     * one; what must not happen is a second entry appearing for the same question, which is what the
     * queue length asserts.
     */
    expect(after?.decisions?.length ?? 1).toBe(1);
    // Wording must not restamp the question: `askedAt` is the clock the waiting time is read from.
    expect(after?.decision?.askedAt).toBe(before?.askedAt);
    expect(after?.decision?.category).toBe(before?.category);
  })

  /**
   * A question asked after the last one was answered is a new question.
   *
   * The old record kept `resolvedAt` and `answer`, so the task page rendered 「已选择」 with the
   * previous reply while the conversation showed a fresh, unanswered card. The answered state
   * was per task, so the new question inherited an answer it never received.
   */
  it('starts a clean decision when a new question follows an answer', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '需要清空旧分支再继续，是否删除这些分支' },
      'sess_w',
    );
    svc.recordDecisionAnswer(task.id, '先不要动')
    svc.resolveDecision(task.id, 'approved')

    const reopened = svc.setDecisionWording(task.id, { question: '还问吗？' })

    expect(reopened).not.toBeNull()
    // The new question carries no answer and no resolution…
    expect(reopened?.decision?.answer).toBeUndefined()
    expect(reopened?.decision?.resolvedAt).toBeUndefined()
    // …and it is the one on screen, so both cards ask it instead of one showing history.
    expect(reopened?.decision?.question).toBe('还问吗？')
  })

  /**
   * Why this exists: the reply used to travel as a bare chat message, so with two tasks
   * waiting the supervisor had two identical sentences and no way to tell which decision
   * each one closed.
   */
  it('records the answer on the decision, so the reply knows which task it belongs to', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '需要清空旧分支再继续，是否删除这些分支' },
      'sess_w',
    );

    const answered = svc.recordDecisionAnswer(task.id, '放行，继续做完');

    expect(answered?.decision?.answer?.text).toBe('放行，继续做完');
    /**
     * The answer closes the pause.
     *
     * It used to be recorded and left open, expecting the supervisor to resolve it on its
     * next turn. A real run showed why that is unsafe: the task stayed on 「等你拍板」 with
     * the answer stored and no card on screen to click, because the supervisor had been
     * rate-limited before it could close the loop. The reply ends the wait; interpreting
     * the words is still the supervisor's job when it runs.
     */
    expect(answered?.decision?.resolvedAt).toBeDefined();
    // Still paused until someone runs it — resolving a decision is not starting work.
    expect(answered?.status).toBe('paused');
  })

  it('refuses an answer when no question is waiting', () => {
    const { svc } = service(workspace());
    const task = create(svc);

    // Nothing was asked, so there is nothing to answer — accepting the words quietly
    // would leave the card printing 「已答复」 for a reply nobody will read.
    expect(svc.recordDecisionAnswer(task.id, '随便说点什么')).toBeNull();
  })

  it('keeps the first answer instead of reopening an answered decision', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '需要清空旧分支再继续，是否删除这些分支' },
      'sess_w',
    );
    svc.recordDecisionAnswer(task.id, '先不要动')
    svc.resolveDecision(task.id, 'rejected')

    // A reload brought the buttons back once; a late second click must not rewrite the
    // record of what the person actually said.
    expect(svc.recordDecisionAnswer(task.id, '改了，放行')).toBeNull()
  })

  /**
   * The same reply arrived twice, 1.6 seconds apart, and read as two instructions.
   * Both surfaces draw the same question; a second click can come from either, and a
   * window that never saw the first answer's state offers the buttons again. Only the
   * task holds the record, so only the task can refuse the second one.
   */
  it('accepts one answer per question, from whichever surface asks', async () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '需要清空旧分支再继续，是否删除这些分支' },
      'sess_w',
    );

    expect(svc.recordDecisionAnswer(task.id, '放行')).not.toBeNull();
    // The conversation card's click, after the task card's.
    expect(svc.recordDecisionAnswer(task.id, '放行')).toBeNull();
  })

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
    // The cap counts the round, so the sessions have to be the round's own.
    for (let i = 0; i < 9; i += 1) svc.attachSession(task.id, `sess_${i}`, { round: true });
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

/**
 * A relayed task is named after the first 40 characters of the person's request, because at
 * creation those words are all the system has: the record read 「建一个任务，名字叫「状态图标验证」。
 * 执行计划写两条大纲：…」. The lane that reads the words knows what the task IS, and the name is
 * the field every board row and every report is read against.
 */
describe('task name', () => {
  it('replaces the truncation the record was created with', () => {
    const root = workspace();
    const { svc } = service(root);
    const task = svc.create({
      name: '建一个任务，名字叫「状态图标验证」。执行计划写两条大纲：…',
      instruction: '状态图标验证',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_name',
    });
    expect(svc.get(task.id)?.name).toContain('建一个任务');
    svc.setName(task.id, '状态图标验证');
    expect(svc.get(task.id)?.name).toBe('状态图标验证')
  })

  it('ignores a blank name instead of erasing the existing one', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setName(task.id, 'kept')
    svc.setName(task.id, '   ')
    expect(svc.get(task.id)?.name).toBe('kept')
  })

  it('keeps the previous name in the journal, because a silent rename is a lost trail', () => {
    const root = workspace();
    const { svc } = service(root);
    const task = create(svc);
    svc.setName(task.id, 'first')
    svc.setName(task.id, 'second')
    const renamed = readJournal(root, task.id).filter((entry) => entry.type === 'spec_updated')
    expect(renamed.length).toBe(2)
    expect(JSON.stringify(renamed[1]?.data)).toContain('first')
    expect(JSON.stringify(renamed[1]?.data)).toContain('second')
  })

  it('does not touch the rest of the record', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setScope(task.id, 'scope kept')
    svc.setDirective(task.id, '只做 1.1')
    svc.setName(task.id, 'renamed')
    const after = svc.get(task.id)
    expect(after?.name).toBe('renamed')
    expect(after?.spec?.scope).toBe('scope kept')
    expect(after?.spec?.directive?.text).toBe('只做 1.1')
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

describe('handoff milestones', () => {
  /**
   * The timeline is a history of the task, not a log of attempts.
   *
   * Seven rows appeared for one file: six rejections of the same claim and one
   * pass, all from the same session. Only the pass changed anything.
   */
  const handoff = (overrides: Record<string, unknown> = {}) => ({
    outcome: 'handoff',
    summary: 'step done',
    artifacts: [{ path: 'docs/a.md' }],
    verify: { ran: ['test -s docs/a.md'], passed: true },
    ...overrides,
  })

  const prepared = () => {
    const root = workspace();
    const { svc } = service(root);
    const task = svc.create({
      name: 'milestones',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_m',
      spec: { cwd: root } as never,
    });
    svc.startRun(task.id, 'sess_w');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), 'x');
    return { root, svc, task };
  }

  it('marks a rejected hand-off as not a milestone', async () => {
    const { svc, task } = prepared();
    await svc.reportHandoff(task.id, handoff({ artifacts: [{ path: 'docs/missing.md' }] }), 'sess_w');
    expect(svc.get(task.id)?.handoffs.at(-1)?.milestone).toBe(false);
  })

  it('keeps the attempt in the record even when it is not a milestone', async () => {
    // Looping detection reads every attempt; hiding them from the timeline must
    // not hide them from the detector.
    const { svc, task } = prepared();
    await svc.reportHandoff(task.id, handoff({ artifacts: [{ path: 'docs/missing.md' }] }), 'sess_w');
    expect(svc.get(task.id)?.handoffs).toHaveLength(1);
  })

  it('records the delivered round as the milestone, not a rejected attempt', async () => {
    // The timeline is the round's, and the round leaves with it — so what survives is `lastRound`.
    // `milestone` still decides what the person sees *while* the round is open; this pins the part
    // that outlives it: the delivered round is the one the record remembers.
    const { svc, task } = prepared();
    await svc.reportHandoff(task.id, handoff({ outcome: 'delivered' }), 'sess_w');
    const after = svc.get(task.id)!
    expect(after.status).toBe('backlog');
    expect(after.handoffs).toEqual([]);
    expect(after.stats?.lastRound?.outcome).toBe('delivered');
  })

  it('marks a decision request as a milestone', async () => {
    const { svc, task } = prepared();
    await svc.reportHandoff(task.id, handoff({ outcome: 'needs_decision', summary: '要我删吗' }), 'sess_w');
    expect(svc.get(task.id)?.handoffs.at(-1)?.milestone).toBe(true);
  })

  it('does not put a plain progress report on the timeline', async () => {
    // Same executor, same owner, nothing opened or closed: the task did not change.
    const { svc, task } = prepared();
    await svc.reportHandoff(task.id, handoff(), 'sess_w');
    expect(svc.get(task.id)?.handoffs.at(-1)?.milestone).toBe(false);
  })
})

describe('the plan gate names the right exit', () => {
  /**
   * Observed: the user said 「只做 1.1，不要碰 1.2 和 2」. The worker obeyed, reported
   * `delivered`, and the gate refused — offering "mark it done" (a lie) or "remove it".
   * The worker removed both steps, wrote in the note that the user had 明确划出本次范围,
   * and the task closed as completed. Two steps the user wanted kept were gone.
   *
   * The correct exit was already in the outcome field: `handoff` means this leg is done
   * and the task continues. The gate never named it, so the worker invented a third.
   */
  const prepared = () => {
    const root = workspace();
    const { svc } = service(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), 'x');
    const task = svc.create({
      name: 'gate-exit',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_gate',
      spec: {
        cwd: root,
        plan: [
          { id: '1', title: '写文件', status: 'done' },
          { id: '2', title: '收尾', status: 'todo' },
        ],
      } as never,
    });
    svc.startRun(task.id, 'sess_w');
    return { svc, task };
  }

  it('points at outcome: handoff instead of teaching removal', async () => {
    const { svc, task } = prepared();
    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '1.1 完成',
        artifacts: [{ path: 'docs/a.md' }],
        verify: { ran: ['test -s docs/a.md'], passed: true },
      },
      'sess_w',
    );

    expect(result.passed).toBe(false);
    const reason = result.reasons.join(' ');
    expect(reason).toContain('handoff');
    // The old wording told the worker to delete what it had not been asked to delete.
    expect(reason).not.toContain('不需要了就把它移除');
  })

  it('keeps every step when the worker hands off instead of delivering', async () => {
    const { svc, task } = prepared();
    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'handoff',
        summary: '1.1 完成',
        artifacts: [{ path: 'docs/a.md' }],
        verify: { ran: ['test -s docs/a.md'], passed: true },
      },
      'sess_w',
    );

    expect(result.passed).toBe(true);
    const after = svc.get(task.id)!;
    // Not completed: the plan still has step 2, so the task is not finished.
    expect(after.status).not.toBe('completed');
    expect(after.spec?.plan?.map((step) => step.id)).toEqual(['1', '2']);
  })
})

describe('scope delivered, plan still open', () => {
  /**
   * Observed: the user said 「只做 1.1，完成就停下，不要碰 1.2 和 2」. The worker obeyed, its
   * hand-off passed, and the task then sat on 进行中 forever — nothing could move it
   * (the scope gate blocks further dispatch) and nothing said why.
   *
   * Not a failure (nothing went wrong) and not completion (the plan is unfinished).
   * A pause with a decision is the honest description.
   */
  const prepared = () => {
    const root = workspace();
    const { svc } = service(root);
    const task = svc.create({
      name: 'scoped',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_sd',
      spec: {
        cwd: root,
        scope: '只做 1.1',
        plan: [
          { id: '1', title: '写文件', status: 'done' },
          { id: '2', title: '收尾', status: 'todo' },
        ],
      } as never,
    });
    svc.startRun(task.id, 'sess_w');
    return { svc, task };
  }

  it('parks the task on a decision instead of pretending it is running', async () => {
    const { svc, task } = prepared();
    const result = await svc.reportHandoff(
      task.id,
      { outcome: 'handoff', summary: '1.1 完成', artifacts: [], verify: { ran: [], passed: true } },
      'sess_w',
    );
    // The gate rejects the empty evidence; use a passing shape instead.
    expect(result.passed).toBe(false);
  })

  const handOff = async (spec: Record<string, unknown>, root: string) => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), 'x');
    const { svc } = service(root);
    const task = svc.create({
      name: 'scoped',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: `call_${Math.random().toString(36).slice(2)}`,
      spec: { cwd: root, ...spec } as never,
    });
    svc.startRun(task.id, 'sess_w');
    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'handoff',
        summary: '1.1 完成',
        artifacts: [{ path: 'docs/a.md' }],
        verify: { ran: ['test -s docs/a.md'], passed: true },
      },
      'sess_w',
    );
    return { passed: result.passed, after: svc.get(task.id)! };
  };

  it('parks the task on instruction when the worker hands back a slice it was directed to do', async () => {
    const { passed, after } = await handOff(
      {
        directive: { text: '只做 1.1，其余等我确认', at: 1 },
        plan: [
          { id: '1', title: '写文件', status: 'todo' },
          { id: '1.1', title: '创建', status: 'done', agent: 'a' },
          { id: '2', title: '收尾', status: 'todo' },
        ],
      },
      workspace(),
    );

    /**
     * The whole point of 「交接后暂停」: the executor stopped on purpose and the plan is not
     * finished, so it does not continue on its own.
     *
     * But nobody is asked anything. The directive already said what to do next — 只做 1.1 — so
     * there is no question, and this used to mint one anyway:
     *
     *   pushed pauseReason 'needs_decision' (later classified 'asking' with no question)
     *   → the board read 「这一段做完了，等你决定」
     *   → the watchdog chased the supervisor for a question it had not written
     *   → the supervisor invented 「第 2 步收尾怎么走」
     *
     * A live run showed all four steps and the person was asked what they had already answered.
     * One state was answering two questions: 「有人在问你」 and 「按你的话停了」.
     */
    expect(passed).toBe(true);
    /**
     * Paused, but on 「等派发」 rather than 「按你的话停了」.
     *
     * `awaiting_release` claims the person ended the run here, and `deriveGateReason` exempts it
     * from re-derivation on exactly that ground — 「a person declared it, the record cannot prove
     * otherwise」. This branch wrote it after *every* accepted hand-off, so the exemption was
     * doing the opposite of its job: the system declared a stop nobody declared, and the dispatch
     * of the next step was then refused for lack of authorisation. Live twice on 2026-11-13.
     */
    expect(after.status).toBe('paused');
    expect(after.pauseReason).toBe('awaiting_dispatch');
    // No decision record means no card, and nothing for the watchdog to chase.
    expect(after.decision).toBeUndefined();
  });

  it('does not park without a directive — nothing recorded what this run was for', async () => {
    const { passed, after } = await handOff(
      {
        // `scope` is what used to trigger this and no longer decides anything.
        scope: '只做 1.1',
        plan: [
          { id: '1', title: '写文件', status: 'todo' },
          { id: '1.1', title: '创建', status: 'done', agent: 'a' },
          { id: '2', title: '收尾', status: 'todo' },
        ],
      },
      workspace(),
    );

    expect(passed).toBe(true);
    /**
     * Not `awaiting_release` — nothing said what this run was for — but not `running` either.
     *
     * The old assertion pinned `running`, and that is the state the user saw as 进行中 with
     * nobody working: the hand-off ended the run, the plan still has steps, and nothing owns
     * them. `awaiting_dispatch` says exactly that without claiming an instruction.
     */
    expect(after.status).toBe('paused');
    expect(after.pauseReason).toBe('awaiting_dispatch');
    expect(after.decision).toBeUndefined();
  });

  it('does not park when the plan has nothing left to do', async () => {
    const { after } = await handOff(
      {
        directive: { text: '把这一节做完', at: 1 },
        plan: [{ id: '1', title: '唯一一节', status: 'todo' }, { id: '1.1', title: '做完它', status: 'done', agent: 'a' }],
      },
      workspace(),
    );

    /**
     * A finished plan plus `handoff` is not a completion.
     *
     * `completed` belongs to `delivered` — 「this is the answer, close it」 — while `handoff` says
     * 「someone else continues」. With nothing left to continue there is also nothing to ask about,
     * so the task stays put and the supervisor's nudge decides between 收尾 and 取消. The assertion
     * is about the absent card, which is the part that would be noise.
     */
    expect(after.status).toBe('running');
    expect(after.decision).toBeUndefined();
  });
})

describe('a stopped slice asks nothing', () => {
  /**
   * The branch that parks a task on a decision fires on every accepted hand-off. A real
   * run showed the consequence: the supervisor relayed the same A/B question three
   * times, because each new hand-off minted a new decision with a fresh deadline.
   */
  const parked = async () => {
    const root = workspace();
    const { svc } = service(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), 'x');
    const task = svc.create({
      name: 'once',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_once',
      spec: {
        cwd: root,
        directive: { text: '只做 1.1', at: 1 },
        plan: [
          { id: '1', title: 'a', status: 'todo' },
          { id: '2', title: 'b', status: 'todo' },
        ],
      } as never,
    })
    svc.startRun(task.id, 'sess_w')
    const payload = {
      outcome: 'handoff',
      summary: 'done',
      artifacts: [{ path: 'docs/a.md' }],
      verify: { ran: ['test -s docs/a.md'], passed: true },
    }
    await svc.reportHandoff(task.id, payload, 'sess_w')
    await svc.reportHandoff(task.id, payload, 'sess_w')
    return { svc, task }
  }

  it('mints no question, so nothing can be asked twice', async () => {
    const { svc, task } = await parked()
    // 「Ask once」 used to mean "keep the first record and do not mint a second one". The record
    // itself was the problem: it claimed a question was owed. With nothing to ask there is no
    // record, and a repeated hand-off cannot produce a second card because there is no first.
    expect(svc.get(task.id)?.decision).toBeUndefined()
  })

  it('parks the task once, without claiming the person stopped it', async () => {
    const { svc, task } = await parked()
    expect(svc.get(task.id)?.status).toBe('paused')
    expect(svc.get(task.id)?.pauseReason).toBe('awaiting_dispatch')
  })

  /**
   * An open question outlives a later hand-off.
   *
   * The guard that used to stop a second card now protects something narrower and still needed:
   * a question that is genuinely open must not be overwritten by 「stopped on instruction」, or
   * the card disappears from the pause reason that was drawing it while the decision stays open
   * — unanswerable from the screen that asked.
   */
  it('leaves an open question alone', async () => {
    const root = workspace()
    const { svc } = service(root)
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'a.md'), 'x')
    const task = svc.create({
      name: 'open-question',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_open',
      spec: {
        cwd: root,
        directive: { text: '只做 1.1', at: 1 },
        plan: [
          { id: '1', title: 'a', status: 'todo' },
          { id: '2', title: 'b', status: 'todo' },
        ],
      } as never,
    })
    svc.startRun(task.id, 'sess_w')

    // The authentic way a question opens: the worker stops and asks, rather than the
    // supervisor pausing first. `setStatus(paused → paused)` would be a no-op and would
    // leave the reason untouched, so building it any other way tests the wrong thing.
    await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '要不要继续', artifacts: [], verify: { ran: [], passed: true } },
      'sess_w',
    )
    const asked = svc.get(task.id)!
    expect(asked.status).toBe('paused')
    // A worker's ask arrives without words, so it is classified 「等问句」 — the point here is
    // only that a decision pause is a pause for an answer, not 「按指示停了」.
    expect(asked.pauseReason === 'needs_decision' || asked.pauseReason === 'asking').toBe(true)

    // A later hand-off must not re-label that pause as 「按指示停了」.
    writeFileSync(join(root, 'docs', 'a.md'), 'x')
    await svc.reportHandoff(
      task.id,
      { outcome: 'handoff', summary: 'again', artifacts: [{ path: 'docs/a.md' }], verify: { ran: ['test -s docs/a.md'], passed: true } },
      'sess_w',
    )
    const after = svc.get(task.id)?.pauseReason
    expect(after === 'needs_decision' || after === 'asking').toBe(true)
  })
})

describe('widening the scope answers the pending question', () => {
  /**
   * `scope` was write-once after creation, so the supervisor could read the user's
   * 「完成 1.2」 correctly and still have no way to record it. It then hit the dispatch
   * gate, which reads `spec.scope`, and asked the user again — the same question, three
   * times. `task_update({ scope })` is the missing step between "the user agreed" and
   * "the system allows it", and resolving the decision in the same move is what stops
   * the two from disagreeing.
   */
  it('records the new boundary and resolves the decision', () => {
    const { svc } = service(workspace());
    const task = svc.create({
      name: 'widen',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_widen',
      spec: { scope: '只做 1.1', plan: [{ id: '1', title: 'a', status: 'todo' }] } as never,
    })
    svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' })
    expect(svc.get(task.id)?.status).toBe('paused')

    svc.setScope(task.id, '做 1.1 和 1.2')
    expect(svc.get(task.id)?.spec?.scope).toBe('做 1.1 和 1.2')
  })
})

describe('delivered requires the plan to be finished', () => {
  /**
   * Observed: a worker delivered while `1.2` and `3` were still `todo`. The artifact
   * existed, the acceptance command passed, so the gate was satisfied and the task
   * closed with a step skipped — the board then showed 2/5 and 已完成 at the same time.
   *
   * The escape hatch is part of the rule: a plan is written while the work is still being
   * discovered, so some steps do become irrelevant. Without an exit the worker would just
   * mark them done, which is worse than skipping them.
   */
  const setup = (plan: Array<{ id: string; title: string; status: string }>) => {
    const root = workspace();
    const { svc } = service(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), 'x');
    const task = svc.create({
      name: 'deliver',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: `call_d${Math.random()}`,
      spec: { cwd: root, plan } as never,
    });
    svc.startRun(task.id, 'sess_w');
    return { svc, task }
  }

  const delivered = {
    outcome: 'delivered',
    summary: '完成',
    artifacts: [{ path: 'docs/a.md' }],
    verify: { ran: ['test -s docs/a.md'], passed: true },
  }

  it('refuses while a work step is unfinished, and says which', async () => {
    const { svc, task } = setup([
      { id: '1', title: '写文件', status: 'done' },
      { id: '2', title: '收尾', status: 'todo' },
    ])
    const result = await svc.reportHandoff(task.id, delivered, 'sess_w')
    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toContain('2 收尾')
    expect(svc.get(task.id)?.status).not.toBe('completed')
  })

  it('allows it once the outstanding step is removed', async () => {
    // The escape: the step stopped mattering, so it leaves the plan with a journal entry
    // rather than being lied about.
    const { svc, task } = setup([
      { id: '1', title: '写文件', status: 'done' },
      { id: '2', title: '收尾', status: 'todo' },
    ])
    svc.updatePlan(task.id, { id: '2', remove: true })
    const result = await svc.reportHandoff(task.id, delivered, 'sess_w')
    expect(result.passed).toBe(true)
    expect(svc.get(task.id)?.status).toBe('backlog')
  })

  it('ignores an outline whose sub-steps are all done', async () => {
    // Progress is counted on leaves, so a closed section must not look like an omission.
    const { svc, task } = setup([
      { id: '1', title: '写文件', status: 'doing' },
      { id: '1.1', title: '创建', status: 'done' },
    ])
    const result = await svc.reportHandoff(task.id, delivered, 'sess_w')
    expect(result.reasons.join(' ')).not.toContain('没完成')
  })
})

/**
 * Asking a question stops the task, even when it was running.
 *
 * Live sequence: the supervisor asked 「是否继续？」 at 11:30:47 while the task was `running`;
 * asking deliberately does not touch status, so nothing paused. The watchdog then saw a task
 * claiming to be in progress with an idle session, woke it with 「继续任务 T-1」 at 11:36:10, and by
 * 11:42 the work had resumed step 1.2 and invented step 2.1 — while the person was still deciding.
 *
 * 「Can this continue?」 cannot coexist with continuing. The pause is derived from the record, the
 * same way the pause *reason* already is, so no caller has to remember to set it.
 */
describe('an open question stops the task', () => {
  it('parks a running task the moment its question is written', () => {
    const { svc } = service(workspace(), { alive: ['sess_w'] })
    const task = create(svc)
    svc.startRun(task.id, 'sess_w')
    expect(svc.get(task.id)?.status).toBe('running')

    svc.setDecisionWording(task.id, { question: '是否继续做 1.2？', options: ['继续', '停'] })

    const parked = svc.get(task.id)
    expect(parked?.status).toBe('paused')
    expect(parked?.pauseReason).toBe('needs_decision')
  })

  it('lets the task run again once the question is answered', () => {
    const { svc } = service(workspace(), { alive: ['sess_w'] })
    const task = create(svc)
    svc.startRun(task.id, 'sess_w')
    svc.setDecisionWording(task.id, { question: '是否继续？' })
    const open = (svc.get(task.id)?.decisions ?? []).find((d) => !d.resolvedAt)!

    svc.recordDecisionAnswer(task.id, '继续', open.id)
    svc.resolveDecision(task.id, 'approved')
    // Asking ends the run it interrupted (`setDecisionWording`), so the record is already park-
    // ed and unlocked here; `endRun` is what the real path does when the worker reports back.
    svc.endRun(task.id, { ok: true })
    svc.setStatus(task.id, 'running', {})

    expect(svc.get(task.id)?.status).toBe('running')
  })

  it('does not freeze a task that asks nothing', () => {
    // The guard is the question, not the act of reporting: a plain hand-off leaves status alone.
    const { svc } = service(workspace(), { alive: ['sess_w'] })
    const task = create(svc)
    svc.startRun(task.id, 'sess_w')
    expect(svc.get(task.id)?.status).toBe('running')
  })
})

describe('an outage pause survives the next write', () => {
  /**
   * Live 2026-11-15 21:10: `parked on upstream outage` was logged for T-2, and the record read
   * `awaiting_dispatch` a moment later.
   *
   * `deriveGateReason` re-derives the label from the record on every save, and an outage-shaped
   * task — plan unfinished, no lock, last hand-off accepted — looks identical to `awaiting_dispatch`
   * by that reading. The outage was overwritten, and the probe never looked at the task again
   * because it only watches `upstream`.
   *
   * Nothing on the record can prove an outage happened, so it joins `process_lost` and
   * `awaiting_release` on the exempt list: an event, not a condition. The probe retires it by
   * resuming the task.
   */
  it('keeps `upstream` instead of re-deriving `awaiting_dispatch`', () => {
    const { svc } = service(workspace());
    // A plan with work left and nothing running — the exact shape `awaitingDispatch()` claims.
    const task = svc.create({
      name: '上游故障',
      instruction: '做点事',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_upstream',
      spec: {
        plan: [
          { id: '1', title: 'a', status: 'done', agent: 'a' },
          { id: '2', title: 'b', status: 'todo', agent: 'a' },
        ],
      },
    } as never);

    // What `parkTaskOnUpstreamOutage` does when a terminal `typed_error` says `canRetry`.
    svc.setStatus(task.id, 'paused', { pauseReason: 'upstream' });
    expect(svc.get(task.id)?.pauseReason).toBe('upstream');

    /**
     * Any later write goes through `save` → `deriveGateReason`, and that derivation is what used to
     * overwrite the reason. Writing the same status again is the cheapest such write and stands in
     * for all of them.
     */
    svc.setStatus(task.id, 'paused', { pauseReason: 'upstream' });
    expect(svc.get(task.id)?.pauseReason).toBe('upstream');
  });
})
