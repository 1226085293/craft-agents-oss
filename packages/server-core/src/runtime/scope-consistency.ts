/**
 * "Install, then uninstall, and prove the system came back."
 *
 * Cordis tests plugins this way, and the reason is worth taking: asserting that
 * something starts is easy and proves little. Asserting that nothing is left
 * behind is what catches the bugs this codebase actually produced — a watchdog
 * still ticking, a scheduler whose stop function was recorded and never called,
 * a second service created because a map was written late.
 *
 * This helper captures the observable state of a scope owner before and after,
 * so a test can say `expectNothingLeaked(before, after)` instead of hand-listing
 * the things that might be left over — the list is what goes stale.
 */

import { expect } from 'bun:test'
import type { WorkspaceScope } from './workspace-scope.ts'

export interface ScopeSnapshot {
  activeWorkspaces: string[]
  pendingDisposers: Record<string, number>
}

/** Owner surface this reads; `WorkspaceScopes` satisfies it. */
export interface ScopeOwner {
  activeIds(): string[]
  get(workspaceId: string): WorkspaceScope | undefined
}

export function snapshotScopes(scopes: ScopeOwner): ScopeSnapshot {
  const activeWorkspaces = scopes.activeIds().sort()
  const pendingDisposers: Record<string, number> = {}
  for (const id of activeWorkspaces) {
    pendingDisposers[id] = scopes.get(id)?.pendingCount ?? 0
  }
  return { activeWorkspaces, pendingDisposers }
}

/**
 * Assert the system returned to its starting state.
 *
 * Deliberately reports the difference rather than a bare false: "workspace b
 * still has 2 disposers" is actionable, "expected true to be false" is not.
 */
export function expectNothingLeaked(before: ScopeSnapshot, after: ScopeSnapshot): void {
  expect(after.activeWorkspaces).toEqual(before.activeWorkspaces)
  expect(after.pendingDisposers).toEqual(before.pendingDisposers)
}

/**
 * Assert one workspace was fully released: it holds no disposers and is gone
 * from the active set. The stronger form of the check above, for the case a test
 * is specifically about teardown.
 */
export function expectWorkspaceReleased(scopes: ScopeOwner, workspaceId: string): void {
  expect(scopes.activeIds()).not.toContain(workspaceId)
  expect(scopes.get(workspaceId)).toBeUndefined()
}
