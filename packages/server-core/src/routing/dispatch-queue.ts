/**
 * Dispatch queue — the concurrency ceiling for rule-driven workers.
 *
 * A rule says `parallel: 3`. The fourth event of that kind must wait, not fan
 * out: the point of the ceiling is that a human can still follow what the system
 * is doing. The queue is deliberately in-memory and per-process — a cap is a
 * property of the running host, not of the task record.
 *
 * Slots are keyed by whatever identifies "the same kind of work" (a rule name),
 * and are held by the session id each job produced. Nothing here starts a
 * session; it only decides whether now is a good moment to ask.
 */

export interface DispatchJob {
  /** Starts the job and returns the session it created. */
  run: () => Promise<string | null>;
}

export type SubmitResult = 'started' | 'queued';

export class DispatchQueue {
  /** key → session ids currently occupying a slot. */
  private readonly active = new Map<string, Set<string>>();
  /** key → jobs waiting for a slot, oldest first. */
  private readonly waiting = new Map<string, DispatchJob[]>();

  constructor(private readonly capFor: (key: string) => number) {}

  activeCount(key: string): number {
    return this.active.get(key)?.size ?? 0;
  }

  pendingCount(key: string): number {
    return this.waiting.get(key)?.length ?? 0;
  }

  /** True when `key` has no room right now. */
  isAtCap(key: string): boolean {
    const cap = this.capFor(key);
    // Only an explicit Infinity means unlimited: a NaN (bad config) must degrade
    // to the safest value, which is one worker at a time.
    if (cap === Number.POSITIVE_INFINITY) return false;
    const effective = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 1;
    return this.activeCount(key) >= effective;
  }

  /**
   * Run now if there is room, otherwise park the job.
   *
   * A parked job is *not* retried by a timer: `release()` drains the queue, so
   * the order stays first-in-first-out and nothing is started by a background
   * tick the user cannot see.
   */
  async submit(key: string, job: DispatchJob): Promise<SubmitResult> {
    if (this.isAtCap(key)) {
      const list = this.waiting.get(key) ?? [];
      list.push(job);
      this.waiting.set(key, list);
      return 'queued';
    }
    await this.runNow(key, job);
    return 'started';
  }

  private async runNow(key: string, job: DispatchJob): Promise<void> {
    let sessionId: string | null = null;
    try {
      sessionId = await job.run();
    } catch {
      // A job that throws never held a slot, so there is nothing to release.
      return;
    }
    if (!sessionId) return;
    const set = this.active.get(key) ?? new Set<string>();
    set.add(sessionId);
    this.active.set(key, set);
  }

  /**
   * Free the slot held by `sessionId` and start the next waiting job for that
   * key, if any. Unknown ids are ignored: a session may be released twice (turn
   * end + archive) without double-decrementing.
   */
  release(sessionId: string): void {
    let releasedKey: string | undefined;
    for (const [key, set] of this.active) {
      if (set.delete(sessionId)) {
        releasedKey = key;
        break;
      }
    }
    if (!releasedKey) return;
    void this.drain(releasedKey);
  }

  /** Release every slot whose session is no longer alive. */
  sweep(isAlive: (sessionId: string) => boolean): void {
    const keys = new Set<string>();
    for (const [key, set] of this.active) {
      for (const sessionId of [...set]) {
        if (!isAlive(sessionId)) {
          set.delete(sessionId);
          keys.add(key);
        }
      }
    }
    for (const key of keys) void this.drain(key);
  }

  private async drain(key: string): Promise<void> {
    while (!this.isAtCap(key)) {
      const list = this.waiting.get(key);
      if (!list?.length) {
        this.waiting.delete(key);
        return;
      }
      const job = list.shift()!;
      if (!list.length) this.waiting.delete(key);
      await this.runNow(key, job);
      // runNow may have produced no session (spawn failed): keep draining so one
      // failure does not wedge the queue.
    }
  }

  /** Diagnostics for the task/event UI. */
  snapshot(): Record<string, { active: number; waiting: number; cap: number }> {
    const keys = new Set([...this.active.keys(), ...this.waiting.keys()]);
    return Object.fromEntries(
      [...keys].map((key) => [
        key,
        { active: this.activeCount(key), waiting: this.pendingCount(key), cap: this.capFor(key) },
      ]),
    );
  }
}
