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

/** Grace on top of a tool's declared timeout: the tool result (and its
 *  tool_execution_end event) lands shortly after the timeout fires. */
export const STALL_EXEMPTION_GRACE_MS = 30_000

/** Built-in read/search tools carry no per-call timeout. Without a default
 *  they would get no exemption at all, so a legitimate Grep over a large tree
 *  is killed by the 90 s idle watchdog (2026-11-06 261106-aware-storm). */
export const READ_ONLY_TOOL_NAMES = new Set(['Grep', 'Find', 'Read', 'Ls', 'Glob'])
export const READ_ONLY_TOOL_SILENCE_BUDGET_MS = 120_000

/**
 * Resolve the silence deadline for one active tool.
 *
 * An explicit `args.timeout` (seconds, the Bash/agent-tool convention) wins.
 * Read-only built-ins without one get the generic 120 s budget; every other
 * no-timeout tool returns null (no exemption — the plain idle deadline still
 * kills genuinely hung tools).
 */
export function resolveToolSilenceDeadline(
  toolName: string,
  args: Record<string, unknown>,
  now: number,
): number | null {
  const rawTimeout = args.timeout
  const explicitMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : null
  const budgetMs =
    explicitMs ?? (READ_ONLY_TOOL_NAMES.has(toolName) ? READ_ONLY_TOOL_SILENCE_BUDGET_MS : null)
  return budgetMs == null ? null : now + budgetMs + STALL_EXEMPTION_GRACE_MS
}
