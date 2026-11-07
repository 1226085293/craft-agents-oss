/**
 * Agent ids are storage keys; the task page needs the name the user sees.
 *
 * A plan step stores `agent: "builtin-default"`. Printing that raw id on the detail page
 * showed a database key where a role belongs — the settings page calls the same profile
 * "默认", so the task page has to call it that too, or the user is left wondering whether
 * they are the same thing.
 *
 * The roster is passed in rather than fetched here: this file stays pure so the plan
 * renderer has no loading state of its own, and an empty roster degrades to the id instead
 * of hiding the fact that a step has an owner at all.
 */

export interface AgentLabelSource {
  id: string
  name: string
}

/**
 * The display name for `id`, or the id itself when it is not in the roster.
 *
 * Returning the id is deliberate. A step whose owner was deleted should still say who it
 * was — blanking it would erase the only record of the assignment.
 */
export function agentLabel(
  id: string | undefined,
  agents: readonly AgentLabelSource[] | undefined,
): string | undefined {
  if (!id) return undefined
  const hit = agents?.find((agent) => agent.id === id)
  return hit?.name?.trim() || id
}

/** Build the id → name map once per render pass instead of scanning per step. */
export function agentLabelMap(
  agents: readonly AgentLabelSource[] | undefined,
): (id: string | undefined) => string | undefined {
  const byId = new Map<string, string>()
  for (const agent of agents ?? []) {
    const name = agent.name?.trim()
    if (name) byId.set(agent.id, name)
  }
  return (id) => (id ? byId.get(id) ?? id : undefined)
}
