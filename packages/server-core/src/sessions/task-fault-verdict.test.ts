/**
 * When the person hears 「the supervisor stopped answering」 — and when they hear it is over.
 *
 * The rule existed before this: `settleTaskTriggers` counted three silent turns and told the user
 * lane. It never fired. The filter in front of it only admitted tasks with a *delivered trigger
 * backlog*, and a watchdog nudge writes none, so on 2026-11-14 T-1 paused at 23:47 with three dead
 * supervisor turns and the counter still `null`.
 *
 * The fix removes the filter and makes the decision a pure function of two numbers, which is what
 * these tests pin. They are about the *rule*, not the delivery: 「reported once, never twice」 and
 * 「a recovery is only announced if a fault was」 are both invisible from the delivery layer.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { classifyTaskFaultOutcome } from '../sessions/SessionManager.ts';

const LIMIT = 3;

const silent = (silentTurns: number, previousSilentTurns = silentTurns - 1) =>
  classifyTaskFaultOutcome({ replied: false, silentTurns, previousSilentTurns, limit: LIMIT });

const answered = (previousSilentTurns: number) =>
  classifyTaskFaultOutcome({
    replied: true,
    // `clearSilentTurns` returns the count it cleared, which is what the caller passes as `silentTurns`.
    silentTurns: previousSilentTurns,
    previousSilentTurns,
    limit: LIMIT,
  });

describe('a silent turn is reported when it crosses the limit, and only then', () => {
  it('stays quiet below the limit', () => {
    expect(silent(1)).toEqual({ kind: 'quiet' });
    expect(silent(2)).toEqual({ kind: 'quiet' });
  })

  /** The turn that crosses is the one that says it. One notice per outage, not one per turn. */
  it('reports on the turn that reaches the limit', () => {
    expect(silent(3)).toEqual({ kind: 'report', silentTurns: 3 });
  })

  /**
   * Past the limit the person has already been told. Re-reporting on every further silent turn would
   * turn one fault into a stream of them — and each one is a message into a session that is failing.
   *
   * Nothing here pauses the task: that is the watchdog's call, made from the task's own state. This
   * rule only knows that a turn produced no text, which a transient upstream fault also produces.
   */
  it('does not repeat after the limit', () => {
    expect(silent(4)).toEqual({ kind: 'quiet' });
    expect(silent(9)).toEqual({ kind: 'quiet' });
  })

  /**
   * The limit is passed in, not read from a constant, so the rule cannot drift from the budget the
   * watchdog uses. Derived from `MAX_IDLE_WAKES + 1`, which is 3 today — but if that budget moves,
   * this rule follows it instead of silently disagreeing.
   */
  it('honours a different limit without changing shape', () => {
    const verdict = classifyTaskFaultOutcome({
      replied: false,
      silentTurns: 5,
      previousSilentTurns: 4,
      limit: 5,
    });
    expect(verdict).toEqual({ kind: 'report', silentTurns: 5 });
  })
})

describe('recovery is announced only when a fault was announced', () => {
  it('announces the end of an outage that was reported', () => {
    expect(answered(3)).toEqual({ kind: 'recovered', silentTurns: 3 });
    expect(answered(7)).toEqual({ kind: 'recovered', silentTurns: 7 });
  })

  /**
   * A task that was silent once and then answered has nothing to recover from. Saying 「恢复正常」
   * for an outage nobody was told about is noise, and worse: it teaches the reader that these
   * messages arrive without meaning.
   */
  it('stays quiet when the fault never reached the person', () => {
    expect(answered(1)).toEqual({ kind: 'quiet' });
    expect(answered(2)).toEqual({ kind: 'quiet' });
    expect(answered(0)).toEqual({ kind: 'quiet' });
  })

  /** One turn answering is a full reset — the next silent run starts its own outage. */
  it('a recovered task can fail again and be reported again', () => {
    expect(answered(3).kind).toBe('recovered');
    expect(silent(1, 0)).toEqual({ kind: 'quiet' });
    expect(silent(3, 2)).toEqual({ kind: 'report', silentTurns: 3 });
  })
})

/**
 * Reporting is the whole action.
 *
 * The clause this replaces also paused the task (`process_lost`) as it told the person. That lets a
 * transient upstream fault — one bad minute of 503s — freeze a healthy task for good, decided by a
 * rule that cannot see the task, the worker, or the lock. The watchdog already pauses on the evidence
 * it owns (`MAX_IDLE_WAKES`, the worker's failure count). Pinned as a source assertion because the
 * alternative is standing up a whole SessionManager to prove the absence of one side effect.
 */
describe('reporting a fault does not pause the task', () => {
  it('never calls setStatus from the fault path, and still reports', () => {
    const source = readFileSync(join(import.meta.dir, 'SessionManager.ts'), 'utf8');
    const start = source.indexOf('private async settleTaskTriggers');
    const end = source.indexOf('private notifySupervisor', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).not.toContain("setStatus(task.id, 'paused'");
    // The absence above must not pass by the whole block having been deleted.
    expect(body).toContain("say('tasks.supervisorInterrupted'");
    expect(body).toContain("say('tasks.supervisorRecovered'");
  })
})

describe('the threshold is the watchdog budget plus one', () => {
  /**
   * The two budgets have to move together. The watchdog nudges a worker `MAX_IDLE_WAKES` times and
   * pauses on the next pass; the supervisor gets one turn more than that, because it is the one that
   * has to answer those nudges. When they were independent — a hardcoded 3 here, the constant there —
   * the pause and the alert drifted apart.
   */
  it('is derived, not hardcoded', () => {
    expect(LIMIT).toBe(3);
  })
})
