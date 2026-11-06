export interface StallDecision {
  now: number
  lastActivityAt: number
  timeoutMs: number
  /** True while the gateway is parked in waitForCooldown. */
  cooldownWaiting: boolean
  /** A running tool's own deadline, or null when no tool is active. */
  activeToolDeadline: number | null
  /** A proxy tool is executing; its own timeout is authoritative. */
  pendingToolInFlight: boolean
}

/**
 * Whether the subprocess stall watchdog should abort the turn.
 *
 * Silence is only a dead-turn signal when nothing else owns the wait:
 * a tool with a future deadline, a proxy tool, or an intentional gateway
 * cooldown pause all keep the turn alive regardless of elapsed silence.
 */
export function shouldAbortStalledTurn(input: StallDecision): boolean {
  const { now, lastActivityAt, timeoutMs, cooldownWaiting, activeToolDeadline, pendingToolInFlight } = input
  if (activeToolDeadline != null && now < activeToolDeadline) return false
  if (pendingToolInFlight) return false
  if (cooldownWaiting) return false
  return now - lastActivityAt > timeoutMs
}
