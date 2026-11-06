/**
 * A workspace's run scope.
 *
 * The host keeps per-workspace machinery — event services, task services,
 * supervisor runtimes, watchdog loops, schedulers, page-refresh timers. These
 * used to be seven separate `Map<workspaceId, …>` plus seven `xxxStops` maps,
 * and every teardown path had to remember all of them. Three real bugs came from
 * that shape: a second service created because a map was written late, a
 * watchdog surviving its service, a scheduler whose stop function was recorded
 * but never called.
 *
 * The rule borrowed from Cordis: a side effect must have an owner. Here the
 * owner is the workspace. `effect()` runs something and stores its undo; when
 * the workspace goes away, `dispose()` runs every undo in reverse.
 *
 * This is deliberately not a general plugin runtime: it has no dependency
 * injection, no service graph, no hot reload. Only ownership.
 */

export type Disposer = () => void

export class WorkspaceScope {
  private disposers: Disposer[] = []
  private closed = false

  constructor(readonly workspaceId: string) {}

  get disposed(): boolean {
    return this.closed
  }

  /**
   * How many undos are still registered.
   *
   * Exposed for the consistency check: "dispose, then nothing remains" is the
   * property worth asserting, and it needs a number to assert on rather than an
   * inspection of private state.
   */
  get pendingCount(): number {
    return this.disposers.length
  }

  /**
   * Run `start` and register what it returns as a disposer.
   *
   * A throw from `start` is the caller's to handle: a subsystem that fails to
   * come up should be reported where it is created, not swallowed here. What
   * this guarantees is narrower and more useful — anything that *did* start
   * will be stopped.
   */
  effect(start: () => Disposer | void): void {
    if (this.closed) {
      // Starting work in a scope that already ended is the bug this class
      // exists to prevent. Fail loudly instead of leaking a live timer into a
      // workspace nobody is watching.
      throw new Error(`workspace scope ${this.workspaceId} is already disposed`)
    }
    const stop = start()
    if (typeof stop === 'function') this.disposers.push(stop)
  }

  /** Wrap a value with its cleanup, so callers cannot forget one. */
  own<T>(value: T, stop: Disposer): T {
    this.effect(() => stop)
    return value
  }

  /**
   * Dispose everything, newest first.
   *
   * Reverse order matters: a scheduler started after its service must stop
   * before it, otherwise it ticks against something already gone. Individual
   * failures are collected rather than thrown, because one broken disposer must
   * not strand the rest — that is exactly the "残留" this is meant to end.
   */
  dispose(onError?: (error: unknown, index: number) => void): void {
    if (this.closed) return
    this.closed = true
    const pending = this.disposers.splice(0).reverse()
    pending.forEach((stop, index) => {
      try {
        stop()
      } catch (error) {
        onError?.(error, index)
      }
    })
  }
}

/** One scope per workspace, created on demand. */
export class WorkspaceScopes {
  private scopes = new Map<string, WorkspaceScope>()

  open(workspaceId: string): WorkspaceScope {
    const existing = this.scopes.get(workspaceId)
    if (existing && !existing.disposed) return existing
    const scope = new WorkspaceScope(workspaceId)
    this.scopes.set(workspaceId, scope)
    return scope
  }

  get(workspaceId: string): WorkspaceScope | undefined {
    const scope = this.scopes.get(workspaceId)
    return scope && !scope.disposed ? scope : undefined
  }

  dispose(workspaceId: string, onError?: (error: unknown, index: number) => void): void {
    const scope = this.scopes.get(workspaceId)
    this.scopes.delete(workspaceId)
    scope?.dispose(onError)
  }

  disposeAll(onError?: (error: unknown, index: number) => void): void {
    for (const id of [...this.scopes.keys()]) this.dispose(id, onError)
  }

  /** Ids of live scopes — diagnostics and tests only. */
  activeIds(): string[] {
    return [...this.scopes.values()].filter((scope) => !scope.disposed).map((scope) => scope.workspaceId)
  }
}
