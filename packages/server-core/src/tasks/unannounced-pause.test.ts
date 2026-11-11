import { describe, expect, it } from 'bun:test';

import { applyTransition } from '@craft-agent/shared/tasks/state';
import { inspectTasks, UNANNOUNCED_PAUSE_GRACE_MS } from './task-watchdog.ts';
import type { Task } from '@craft-agent/shared/tasks';

/**
 * A pause nobody announced is a task that waits forever.
 *
 * The supervisor is the only voice the user hears, and the wake that tells them is a model turn —
 * which can die. Observed on a real run: T-1's hand-off landed and parked the task at
 * `awaiting_release`, the supervisor was woken 17 seconds later, the upstream stream went silent
 * for 60 seconds, the retry was exhausted, and the turn ended in an error. The task then sat
 * paused with a correct board and no sentence anywhere telling the person 「按你的指示停了，要放行吗」.
 *
 * Every other rule inspects `running` tasks, so the watchdog reported 「0 finding(s)」 for twelve
 * minutes while the task did nothing.
 */
describe('unannounced pause', () => {
  const NOW = 1_000_000;

  function pausedTask(over: Partial<Task> = {}): Task {
    return {
      id: 'T-1',
      name: 'T-1',
      instruction: 'do',
      status: 'paused',
      pauseReason: 'awaiting_release',
      supervisorSessionId: 'sess_sup',
      sessionIds: [],
      dependsOn: [],
      priority: 2,
      budget: {} as never,
      handoffs: [],
      verify: {} as never,
      lifecycle: { errorCount: 0, consecutiveFailures: 0, lastPausedAt: NOW - UNANNOUNCED_PAUSE_GRACE_MS - 1 },
      stats: { runs: 1, activeMs: 0 },
      updatedAt: NOW - UNANNOUNCED_PAUSE_GRACE_MS - 1,
      ...over,
    } as Task;
  }

  const deps = (tasks: Task[]) =>
    ({
      listTasks: () => tasks,
      sessionExists: () => true,
      sessionWorking: () => false,
      sessionWaiting: () => false,
      now: () => NOW,
      notify: () => {},
      pause: () => {},
    }) as never;

  it('fires when a pause was never announced and the grace has passed', () => {
    const findings = inspectTasks(deps([pausedTask()]));
    expect(findings.map((f) => f.kind)).toContain('unannounced_pause');
  });

  it('stays quiet while the wake that caused the pause may still be running', () => {
    // The pause is written first and the sentence second; interrupting that gap would double
    // every notification.
    const findings = inspectTasks(
      deps([
        pausedTask({
          lifecycle: { errorCount: 0, consecutiveFailures: 0, lastPausedAt: NOW - 1000 },
          updatedAt: NOW - 1000,
        }),
      ]),
    );
    expect(findings.map((f) => f.kind)).not.toContain('unannounced_pause');
  });

  it('stays quiet once it has been announced', () => {
    const findings = inspectTasks(
      deps([pausedTask({ stats: { runs: 1, activeMs: 0, announcedPauseAt: NOW - 1000 } })]),
    );
    expect(findings.map((f) => f.kind)).not.toContain('unannounced_pause');
  });

  it('does not treat every pause as unannounced', () => {
    // Only the pause that means 「等你放行」 is this rule's business; `failures` and `budget` have
    // their own reasons and their own sentences.
    for (const pauseReason of ['failures', 'budget', 'waiting'] as const) {
      const findings = inspectTasks(deps([pausedTask({ pauseReason })]));
      expect(findings.map((f) => f.kind)).not.toContain('unannounced_pause');
    }
  });

  it('announces a second pause, not just the first', () => {
    /**
     * The flag must die with the pause it describes.
     *
     * A task that paused, was explained, resumed and then paused again carries the old
     * `announcedPauseAt` unless something clears it — and a record that still says「已告知」about a
     * pause that has since ended suppresses the one announcement that matters. The transition is
     * what clears it, so the second pause arrives unannounced again.
     */
    const first: Task = pausedTask({ stats: { runs: 1, activeMs: 0, announcedPauseAt: NOW - 10_000 } });
    const running = applyTransition(first, 'running', { now: NOW - 5000 }).task;
    const second = applyTransition(running, 'paused', {
      now: NOW,
      pauseReason: 'awaiting_release',
    }).task;

    expect(second.stats?.announcedPauseAt).toBeUndefined();

    // The new pause starts inside the grace window by definition — nothing fires the moment a task
    // parks. Move the clock past it and the second pause is announced like the first was.
    const later = inspectTasks({
      listTasks: () => [second],
      sessionExists: () => true,
      sessionWorking: () => false,
      sessionWaiting: () => false,
      now: () => NOW + UNANNOUNCED_PAUSE_GRACE_MS + 1,
      notify: () => {},
      pause: () => {},
    } as never);
    expect(later.map((f) => f.kind)).toContain('unannounced_pause');
  });
});
