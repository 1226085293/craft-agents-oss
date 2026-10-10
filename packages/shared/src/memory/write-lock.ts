/**
 * Memory write lock — in-process promise-chain mutex.
 *
 * All "load → mutate → save" flows that share the workspace memory stores
 * (session extraction, cron consolidation, UI operations, lastInjectedAt
 * updates) route their save through this one queue so concurrent writers
 * cannot interleave and clobber each other's changes.
 *
 * The lock is in-process only: cross-process safety is provided by the
 * atomic write + snapshot rotation in store.ts (tmp file + rename).
 */

let tail: Promise<unknown> = Promise.resolve();
let pendingCount = 0;

/**
 * Run `fn` while holding the process-wide memory write lock.
 * Returns fn's result; the next caller starts only after this one settles
 * (resolved or rejected). A rejected fn never poisons the queue.
 */
export function withMemoryWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
  pendingCount += 1;
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  // Return the finally-wrapped promise so `await` guarantees the queue
  // counter has already been released when the caller resumes.
  return run.finally(() => {
    pendingCount -= 1;
  });
}