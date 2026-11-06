/**
 * Plugin-contributed tools, assembled once per session.
 *
 * The Cordis lesson this borrows from is "a tool plugin only registers, and the
 * tool disappears with it". The lesson it deliberately does not borrow is
 * *when* that happens. Registering tools live would rewrite the system prompt
 * mid-conversation: the tool table is part of the prompt, so a plugin toggle
 * would invalidate the cache and leave the model describing tools it no longer
 * has.
 *
 * So the timeline is:
 *
 *   session creation → assemble (this file) → frozen for the session
 *   plugin toggled   → affects the *next* session
 *
 * That keeps two things true at once: a plugin can contribute tools, and a
 * running conversation's prompt never moves under it.
 */

export interface ToolContribution {
  /** Plugin that owns the tool. Also the routing key for execution. */
  plugin: string
  /** Tool name as the model sees it. */
  name: string
  description: string
  /** JSON Schema for arguments. */
  input: {
    type?: 'object'
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
}

export interface DeclarationSource {
  id: string
  enabled: boolean
  /** Present but false means the plugin exists and is switched off. */
  installed?: boolean
  actions?: Array<{
    name: string
    description: string
    input: ToolContribution['input']
    asTool?: boolean
  }>
}

/**
 * Which tools a session may use, given the plugins in the workspace.
 *
 * Ordering is `plugin id, then tool name` — not manifest order. The tool table
 * is part of the prompt, so two sessions in the same workspace must get the same
 * order or their prompts differ for no reason and the cache misses.
 */
export function assemblePluginTools(
  sources: readonly DeclarationSource[],
  options: { allow?: readonly string[]; deny?: readonly string[] } = {},
): ToolContribution[] {
  const out: ToolContribution[] = []
  const seen = new Map<string, string>()

  for (const source of [...sources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    // A plugin that is not installed, or switched off, contributes nothing. The
    // user's intent, not the plugin's file contents, decides this.
    if (source.installed === false || !source.enabled) continue

    for (const action of [...(source.actions ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (action.asTool !== true) continue
      if (options.allow && !options.allow.includes(action.name)) continue
      if (options.deny?.includes(action.name)) continue

      // Two plugins declaring the same tool name would make the model's call
      // ambiguous and execution arbitrary. First (by id) wins, and the collision
      // is recorded so it can be reported rather than silently resolved.
      const owner = seen.get(action.name)
      if (owner) continue
      seen.set(action.name, source.id)

      out.push({
        plugin: source.id,
        name: action.name,
        description: action.description,
        input: action.input,
      })
    }
  }

  return out
}

/** Names claimed by more than one plugin — surfaced as a manifest warning. */
export function findToolNameCollisions(sources: readonly DeclarationSource[]): Array<{
  name: string
  plugins: string[]
}> {
  const owners = new Map<string, string[]>()
  for (const source of sources) {
    if (source.installed === false || !source.enabled) continue
    for (const action of source.actions ?? []) {
      if (action.asTool !== true) continue
      const list = owners.get(action.name) ?? []
      list.push(source.id)
      owners.set(action.name, list)
    }
  }
  return [...owners.entries()]
    .filter(([, plugins]) => plugins.length > 1)
    .map(([name, plugins]) => ({ name, plugins: plugins.sort() }))
}
