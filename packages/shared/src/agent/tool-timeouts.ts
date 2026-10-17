/**
 * Per-tool execution budgets for proxy tools (main-process side).
 *
 * 2026-10-18 (session 261016-deft-tide): `handleToolExecuteRequest` awaited
 * `routeToolCall` with NO timeout. A hung host-side tool (a browser CDP
 * screenshot that never returned) kept the subprocess's tool promise pending
 * forever → the SDK's `activeRun` never cleared → every later prompt died with
 * "Agent is already processing a prompt", and the retry ladder looped on
 * "Cannot retry: the current turn has no re-runnable model step".
 *
 * The budget is the FIRST line of defense: the main process returns an error
 * tool result within the budget, the model sees the failure, and the turn
 * continues — no 300s stall, no abort, no user-visible error card.
 *
 * Tunables (env):
 *   CRAFT_PI_TOOL_TIMEOUT_MS          default 120000  (generic proxy tools)
 *   CRAFT_PI_BROWSER_TOOL_TIMEOUT_MS  default  60000  (browser_tool)
 *   CRAFT_PI_BASH_TOOL_TIMEOUT_MS     default 600000  (Bash without args.timeout)
 *   CRAFT_PI_CALL_LLM_TIMEOUT_MS      default 300000  (call_llm)
 *
 * IMPORTANT — the SUBPROCESS fallback budgets are declared in
 * `packages/pi-agent-server/src/index.ts` (DEFAULT_PROXY_TOOL_TIMEOUT_MS /
 * BROWSER_TOOL_TIMEOUT_MS / BASH_TOOL_TIMEOUT_MS / CALL_LLM_TIMEOUT_MS).
 * Invariant: every subprocess fallback MUST stay >= its main-process budget
 * + 60s grace. The main process is authoritative; the subprocess value only
 * guarantees the SDK's tool promise settles if the host never replies. If you
 * change a budget here, update the matching fallback there (and vice versa).
 */

function parseMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const DEFAULT_TOOL_TIMEOUT_MS = parseMs(process.env.CRAFT_PI_TOOL_TIMEOUT_MS, 120_000);
const BROWSER_TOOL_TIMEOUT_MS = parseMs(process.env.CRAFT_PI_BROWSER_TOOL_TIMEOUT_MS, 60_000);
const BASH_TOOL_TIMEOUT_MS = parseMs(process.env.CRAFT_PI_BASH_TOOL_TIMEOUT_MS, 600_000);
const CALL_LLM_TIMEOUT_MS = parseMs(process.env.CRAFT_PI_CALL_LLM_TIMEOUT_MS, 300_000);

/**
 * Resolve the execution budget for one proxy tool call.
 *
 * An explicit `args.timeout` (seconds — the Bash/agent-tool convention) wins,
 * with a 60s grace for the host round-trip. `browser_tool` is short-budget on
 * purpose: its CDP calls are expected to return in milliseconds; a minute is
 * already pathological.
 */
export function resolveToolTimeoutMs(toolName: string, args: Record<string, unknown>): number {
  // Layered mode wraps the real call in `call_tool`: { name, args: { ... } }.
  // Honor a timeout declared by the INNER tool as well as the outer one.
  const nested = typeof args.args === 'object' && args.args !== null
    ? args.args as Record<string, unknown>
    : null;
  const rawTimeout = typeof args.timeout === 'number' ? args.timeout : nested?.timeout;
  const explicit = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.floor(rawTimeout * 1000) + 60_000
    : null;

  if (toolName === 'Bash') return explicit ?? BASH_TOOL_TIMEOUT_MS;
  if (toolName === 'call_llm') return explicit ?? CALL_LLM_TIMEOUT_MS;
  if (toolName === 'mcp__session__call_tool' || toolName === 'call_tool') {
    const inner = typeof args.name === 'string' ? args.name : '';
    if (inner === 'browser_tool') return explicit ?? BROWSER_TOOL_TIMEOUT_MS;
    return explicit ?? DEFAULT_TOOL_TIMEOUT_MS;
  }
  return explicit ?? DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * Race a tool execution against its budget. The underlying promise may keep
 * running after the timeout (arbitrary handlers cannot be cancelled), but its
 * late result is ignored and the turn is free to continue with an error
 * toolResult. Exported so the timeout path is unit-testable without a live
 * PiAgent.
 */
export async function withToolExecutionTimeout<T>(
  run: Promise<T>,
  timeoutMs: number,
  toolName: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `Tool "${toolName}" timed out after ${Math.round(timeoutMs / 1000)}s. `
            + 'The operation was aborted before it returned and may not have completed.',
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
