/**
 * Activation order by declared dependency, for host subsystems inside one scope.
 *
 * The comment this replaces was honest but fragile:
 *
 *   // Register before the loops start: the scheduler and event routing both
 *   // re-enter getTasks, and a second service would mean a second watchdog.
 *   this.taskServices.set(workspaceId, service)
 *
 * That invariant was held by code order and a comment. Move the `set` two lines
 * down and you get a second service and a second watchdog — which is not
 * hypothetical, it is how this file's earlier bug happened. Cordis makes
 * dependencies part of the runtime (`inject`); this is the smallest version that
 * fits a host that is not a plugin system: declare what each subsystem needs,
 * let the order be derived, and refuse to activate something whose dependency is
 * absent instead of running it against a half-built world.
 */

export interface Activatable {
  /** Stable id, used in messages and by dependents. */
  id: string
  /** Ids that must be active first. */
  requires?: readonly string[]
  /** What this subsystem does when it is missing — used in the error. */
  consequence?: string
  activate: () => void
}

export interface ActivationFailure {
  id: string
  reason: 'unknown-dependency' | 'cycle' | 'dependency-failed'
  detail: string
}

export interface ActivationResult {
  activated: string[]
  failed: ActivationFailure[]
}

/**
 * Activate in dependency order.
 *
 * Cycles are reported rather than broken arbitrarily: a cycle means the
 * declarations are wrong, and silently picking an order would hide that. A
 * failure does not abort its dependents' siblings, but it does prevent anything
 * that required it from running — a watchdog over a service that never started
 * is worse than no watchdog.
 */
export function activateInOrder(subsystems: readonly Activatable[]): ActivationResult {
  const byId = new Map(subsystems.map((entry) => [entry.id, entry]))
  const activated: string[] = []
  const failed: ActivationFailure[] = []
  const failedIds = new Set<string>()
  const done = new Set<string>()
  const visiting = new Set<string>()

  const visit = (id: string, path: string[]): void => {
    if (done.has(id) || failedIds.has(id)) return
    const entry = byId.get(id)
    if (!entry) {
      failed.push({ id, reason: 'unknown-dependency', detail: `依赖 ${id} 不存在（来自 ${path.at(-1) ?? '?'}）` })
      failedIds.add(id)
      return
    }
    if (visiting.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(' → ')
      failed.push({ id, reason: 'cycle', detail: `依赖成环：${cycle}` })
      failedIds.add(id)
      return
    }

    visiting.add(id)
    for (const dependency of entry.requires ?? []) {
      visit(dependency, [...path, id])
      if (failedIds.has(dependency)) {
        visiting.delete(id)
        failed.push({
          id,
          reason: 'dependency-failed',
          detail: `依赖 ${dependency} 未启动，${entry.consequence ?? '该子系统不会运行'}`,
        })
        failedIds.add(id)
        return
      }
    }
    visiting.delete(id)

    try {
      entry.activate()
      activated.push(id)
      done.add(id)
    } catch (error) {
      failed.push({
        id,
        reason: 'dependency-failed',
        detail: `启动失败：${error instanceof Error ? error.message : String(error)}`,
      })
      failedIds.add(id)
    }
  }

  for (const entry of subsystems) visit(entry.id, [])
  return { activated, failed }
}
