/**
 * Which SDK built-in tools a session role may have.
 *
 * The session-tool table (mcp__session__*) is already pruned per role, but the
 * Pi SDK's own coding tools — bash, edit, write, read, grep, find, ls — are
 * assembled separately. Nothing filtered them, so a supervisor session was
 * handed a shell: it grepped the entire workspace looking for an event id,
 * blew the 30s foreground budget into a background handoff, and failed.
 *
 * A supervisor coordinates. It reads to understand what it was asked about, and
 * it must not be able to run commands or change files.
 */

/** Built-ins a supervisor keeps: read-only inspection only. */
export const SUPERVISOR_BUILTIN_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];

/** Built-ins a worker (or any non-supervisor session) gets. */
export const FULL_BUILTIN_TOOLS: readonly string[] = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
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
