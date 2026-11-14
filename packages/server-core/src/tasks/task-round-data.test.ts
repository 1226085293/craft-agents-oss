/**
 * The previous round's data, readable by the next round.
 *
 * The person's example: a recurring task that collects items without duplicates. Round one finds 10,
 * round two finds 5 of which 3 were already known, so round three must start from 12. That is only
 * possible if the delivery carries the data — a prose summary cannot be compared against, and an
 * unread copy in the journal is the same as not keeping it.
 *
 * So: `report_result.roundResult` is stored as `stats.lastRound.result.data`, `task_get` returns the
 * record verbatim (a worker reads it the same way it reads anything else), and the next round's brief
 * prints it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatLastRoundBlock, formatTaskBrief, type Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-round-data-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({ workspaceRoot: root, sessionExists: () => false, wakeSupervisor: () => undefined });

const recurring = (svc: TaskService): Task =>
  svc.create({
    name: '去重收集',
    instruction: '每分钟收集一批不重复的数据',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_collect',
    trigger: { kind: 'cron', expr: '* * * * *', enabled: true },
    spec: { plan: [{ id: '1.1', title: '收集一批', status: 'todo', agent: 'builtin-default' }] },
  });

const round = async (
  svc: TaskService,
  id: string,
  from: string,
  data: unknown,
  summary: string,
) => {
  const artifact = join(root, `${from}.json`);
  writeFileSync(artifact, JSON.stringify(data), 'utf-8');
  svc.startRun(id, from);
  svc.updatePlan(id, { id: '1.1', status: 'done' });
  await svc.reportHandoff(
    id,
    {
      outcome: 'delivered',
      summary,
      stepId: '1.1',
      artifacts: [{ path: artifact }],
      verify: { ran: ['cat data.json'], passed: true },
      roundResult: data,
    },
    from,
  );
};

describe('a round hands its data to the next round', () => {
  it('keeps 10, then 12 after a round that found 5 with 3 already known', async () => {
    const svc = service();
    const task = recurring(svc);

    // Round 1: ten items, all new.
    const first = { total: 10, ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    await round(svc, task.id, 'w1', first, '新增 10 条，累计 10 条');

    const after1 = svc.get(task.id)!;
    expect(after1.stats?.lastRound?.round).toBe(1);
    // This is what `task_get` returns to a worker: the record, with the payload on it.
    expect(after1.stats?.lastRound?.result?.data).toEqual(first);

    // Round 2: five found, three already known → two new, twelve total.
    const second = { total: 12, ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] };
    await round(svc, task.id, 'w2', second, '新增 2 条（3 条重复），累计 12 条');

    const after2 = svc.get(task.id)!;
    expect(after2.stats?.lastRound?.round).toBe(2);
    expect(after2.stats?.lastRound?.result?.data).toEqual(second);
    expect((after2.stats?.lastRound?.result?.data as { total: number }).total).toBe(12);
    // The plan is cleared for round 3 — not reset in place — and the previous delivery is what it
    // starts from.
    expect(after2.status).toBe('backlog');
    expect(after2.spec?.plan).toEqual([]);
  })


  it('refuses an oversized payload instead of bloating the record', () => {
    // The record is a task record, not a data store. A round that wants to carry a megabyte of items
    // writes a file and reports the path; the gate says so rather than letting one round grow the board.
    const svc = service();
    const task = recurring(svc)

    return (async () => {
      await round(svc, task.id, 'w1', { blob: 'x'.repeat(20 * 1024) }, '大载荷')
      const data = svc.get(task.id)!.stats?.lastRound?.result?.data as { truncated?: boolean; reason?: string }
      expect(data?.truncated).toBe(true)
      expect(data?.reason ?? '').toContain('artifacts')
    })()
  })


  it('keeps only the round in progress, and the payload only on lastRound', () => {
    // `handoffs` used to grow one entry per round, carrying the payload on each: after three rounds the
    // record held three rounds of attempts (~22 KB measured over five) while only the latest is read.
    // The timeline is the round in progress — every attempt is still in the journal, and `lastRound` is
    // what the next round continues from.
    const svc = service()
    const task = recurring(svc)

    return (async () => {
      for (let i = 1; i <= 3; i += 1) {
        await round(svc, task.id, `w${i}`, { total: i, ids: Array.from({ length: 50 }, (_, k) => k) }, `第 ${i} 轮`)
      }
      const after = svc.get(task.id)!
      // The timeline left with the round; the payload it delivered is what the next round reads.
      expect(after.handoffs).toEqual([])
      expect((after.stats?.lastRound?.result?.data as { total: number }).total).toBe(3)
    })()
  })

  it('drops the finished round when the next one files its first report', async () => {
    // The live symptom: 「交接时间线」 carried every round of a per-minute task, so twelve rounds of
    // attempts read as one round's work. The journal keeps each attempt; this array is the round.
    const svc = service()
    const task = recurring(svc)
    await round(svc, task.id, 'w1', { total: 1 }, '第一轮')
    // Closed rounds leave nothing behind: `handoffs` is the round in progress, and the round is over.
    expect(svc.get(task.id)!.handoffs).toEqual([])
    expect(svc.get(task.id)!.stats?.lastRound?.round).toBe(1)

    await round(svc, task.id, 'w2', { total: 2 }, '第二轮')
    expect(svc.get(task.id)!.handoffs).toEqual([])
    expect(svc.get(task.id)!.stats?.lastRound?.round).toBe(2)
  })

  it('keeps every attempt inside the same round', async () => {
    // The looping detector reads attempts, not deliveries — a refused report that vanishes from the
    // array would let a worker file the same claim forever without being noticed.
    const svc = service()
    const task = recurring(svc)
    const artifact = join(root, 'same-round.json')
    writeFileSync(artifact, '{}', 'utf-8')
    svc.startRun(task.id, 'w1')

    for (const summary of ['第一次尝试', '第二次尝试', '第三次尝试']) {
      await svc.reportHandoff(
        task.id,
        {
          outcome: 'handoff',
          summary,
          stepId: '1.1',
          artifacts: [{ path: artifact }],
        },
        'w1',
      )
    }

    const handoffs = svc.get(task.id)!.handoffs
    expect(handoffs.length).toBe(3)
    expect(new Set(handoffs.map((h) => h.round))).toEqual(new Set([1]))
  })

  it('states the previous round once, not twice', async () => {
    // `formatHandoffContext` and `lastRound` describe the same delivery; printing both made the brief
    // claim two previous rounds and spend context repeating itself.
    const svc = service()
    const task = recurring(svc)
    await round(svc, task.id, 'w1', { total: 1 }, '第一轮')

    const brief = formatTaskBrief(svc.get(task.id)!, { reason: 'cron:* * * * *' })
    expect((brief.match(/Previous round/g) ?? []).length).toBe(1)
    expect(brief).not.toContain('Hand-off context')
  })

  it('prints the payload in the next round brief, not just the prose', async () => {
    const svc = service();
    const task = recurring(svc);
    await round(svc, task.id, 'w1', { total: 12, ids: [1, 2, 3] }, '累计 12 条');

    const brief = formatTaskBrief(svc.get(task.id)!, { reason: 'cron:* * * * *' });

    expect(brief).toContain('## Previous round (#1)')
    expect(brief).toContain('Result data:')
    expect(brief).toContain('"total": 12')
  })

  it('leaves the block out when the round reported no data', () => {
    // A task whose delivery is a file, not a payload, must not grow an empty block.
    const block = formatLastRoundBlock({
      stats: { lastRound: { round: 1, finishedAt: 1, outcome: 'delivered', summary: 'done' } },
    } as never)
    expect(block).toContain('## Previous round (#1)')
    expect(block).not.toContain('Result data:')
  })
})
