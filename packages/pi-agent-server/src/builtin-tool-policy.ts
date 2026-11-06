/**
 * Which SDK built-in tools a session role may have.
 *
 * The session-tool table (mcp__session__*) is already pruned per role, but the
 * Pi SDK's own coding tools — bash, edit, write, read, grep, find, ls — plus
 * `web_search` / `web_fetch` are assembled separately. Nothing filtered them, so
 * a supervisor session was handed a shell: it grepped the entire workspace
 * looking for an event id, blew the 30s foreground budget into a background
 * handoff, and failed.
 *
 * A later attempt kept `read/grep/find/ls` on the theory that "a supervisor
 * reads to understand what it was asked about". That theory lost, and it lost
 * for an instructive reason: the supervisor prompt says in as many words that
 * the role has no file tools. Granting them did not just add capability — it
 * falsified the prompt. Observed on 2026-11-06 (session 261106-aware-storm), the
 * model's own reasoning names the contradiction out loud:
 *
 *   "As the supervisor, I don't have shell/file tools — wait, actually looking
 *    at my available tools, I DO have read, grep, find, ls, web_search,
 *    web_fetch, plus MCP…"
 *
 * Once a prompt is caught lying about one thing, its other prohibitions stop
 * binding. That turn spent all 293 seconds of its cap reading files and issuing
 * zero `task_create` / `dispatch` calls — it investigated the work instead of
 * handing it out, which is the exact failure this policy exists to prevent.
 *
 * So: a supervisor gets **no** built-in tools at all. Everything it needs to
 * understand a request arrives inside the request — the event body (via
 * `get_event`), session metadata, and the workspace root in its prompt. If a
 * question genuinely needs files read, that is a task for a worker.
 */

/**
 * Built-ins a supervisor keeps: none.
 *
 * Deliberately empty rather than "read-only inspection". Any inspection tool is
 * an invitation to substitute reading for delegating, and the role has no
 * legitimate call that requires one. Keep this empty; if a future supervisor
 * genuinely needs to read something, pass it through the prompt or the event
 * body instead of widening this list.
 */
export const SUPERVISOR_BUILTIN_TOOLS: readonly string[] = [];

/**
 * Built-ins a worker (or any non-supervisor session) gets.
 *
 * `web_search` / `web_fetch` live here rather than being appended
 * unconditionally at assembly time, so that "which built-in does this role
 * have" has exactly one answer in one place. They are still not SDK built-ins —
 * they are our own tool definitions — but they are gated by the same list, and
 * the assembly code filters them through `builtinToolNamesForRole` like the rest.
 */
export const FULL_BUILTIN_TOOLS: readonly string[] = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'web_search',
  'web_fetch',
];

/**
 * Names a role may see, after applying the session's task scope.
 *
 * The scope narrows, never widens: a worker task that asks for `bash` on a
 * supervisor session still gets nothing, because the role list is applied first.
 * This is the same rule the session-tool table follows, so "what can this
 * worker do" has one answer whichever table you read.
 */
export function builtinToolNamesForRole(
  role: string | undefined,
  scope?: { allow?: readonly string[]; deny?: readonly string[] },
): readonly string[] {
  const allowed = role === 'supervisor' ? SUPERVISOR_BUILTIN_TOOLS : FULL_BUILTIN_TOOLS;
  return allowed.filter((name) => {
    if (scope?.allow && !scope.allow.includes(name)) return false;
    if (scope?.deny?.includes(name)) return false;
    return true;
  });
}

/** Whether a specific built-in is permitted for a role. */
export function isBuiltinToolAllowed(role: string | undefined, name: string): boolean {
  return builtinToolNamesForRole(role).includes(name);
}
