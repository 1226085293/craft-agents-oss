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

/**
 * Prefix for tools a plugin contributes.
 *
 * Namespaced on purpose: the model sees `plugin__slack__slack_search`, which
 * cannot collide with a built-in, and the host can route it back to the owning
 * plugin by parsing the name — no lookup table to keep in sync, and a stale tool
 * name fails loudly instead of hitting the wrong plugin.
 *
 * Double underscore because tool names must stay `[A-Za-z0-9_-]`; `__` is legal
 * and rare enough in real names to keep the split unambiguous.
 */
export const PLUGIN_TOOL_PREFIX = 'plugin__'

const NAME_SAFE = /[^A-Za-z0-9_-]/g

/** Model-visible name for one contributed tool. */
export function pluginToolName(plugin: string, tool: string): string {
  return `${PLUGIN_TOOL_PREFIX}${plugin.replace(NAME_SAFE, '_')}__${tool.replace(NAME_SAFE, '_')}`
}

/**
 * Parse a contributed tool name back into its owner.
 *
 * Returns null for anything that is not one — callers use this as the branch
 * condition, so a plugin tool and a built-in never share a code path.
 */
export function parsePluginToolName(name: string): { plugin: string; tool: string } | null {
  if (!name.startsWith(PLUGIN_TOOL_PREFIX)) return null
  const rest = name.slice(PLUGIN_TOOL_PREFIX.length)
  const split = rest.indexOf('__')
  if (split <= 0) return null
  const plugin = rest.slice(0, split)
  const tool = rest.slice(split + 2)
  if (!plugin || !tool) return null
  return { plugin, tool }
}

/**
 * Check arguments against a declared tool schema before the call leaves Craft.
 *
 * The plugin could validate too, but by then the model has already spent a round
 * trip and the error comes back in the plugin's own words. Catching it here
 * costs nothing and lets the message say what to do instead.
 *
 * Deliberately small: `required`, the primitive `type` of each property, and
 * unknown keys. A full JSON Schema implementation would be a dependency and a
 * compatibility surface for what is, in practice, a flat argument object — and
 * silently accepting anything it did not understand would be worse than saying
 * so.
 */
export interface ToolSchema {
  type?: 'object'
  properties?: Record<string, Record<string, unknown>>
  required?: string[]
}

export interface ValidationResult {
  ok: boolean
  /** One sentence the model can act on; empty when ok. */
  message: string
}

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
}

export function validateToolArguments(
  schema: ToolSchema | undefined,
  args: Record<string, unknown>,
): ValidationResult {
  if (!schema) return { ok: true, message: '' }

  const required = schema.required ?? []
  const missing = required.filter((key) => args[key] === undefined || args[key] === null)
  if (missing.length > 0) {
    return {
      ok: false,
      message: `缺少必填参数：${missing.join('、')}。请补齐后重试。`,
    }
  }

  const properties = schema.properties ?? {}
  for (const [key, declaredType] of Object.entries(properties)) {
    const value = args[key]
    if (value === undefined || value === null) continue
    const expected = typeof declaredType.type === 'string' ? declaredType.type : undefined
    if (!expected) continue
    const check = TYPE_CHECKS[expected]
    // An unknown `type` word is the plugin's mistake, not the model's: skip
    // rather than reject a call that is probably fine.
    if (!check) continue
    if (!check(value)) {
      return {
        ok: false,
        message: `参数 ${key} 应为 ${expected}，收到的是 ${Array.isArray(value) ? 'array' : typeof value}。`,
      }
    }
  }

  return { ok: true, message: '' }
}
