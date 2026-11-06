import { describe, it, expect } from 'bun:test'
import {
  assemblePluginTools,
  findToolNameCollisions,
  parsePluginToolName,
  pluginToolName,
} from './plugin-tools.ts'

/**
 * The tool table is part of the prompt, so these cases are about stability as
 * much as content: the same workspace must always produce the same order.
 */

const input = { type: 'object' as const, properties: { q: { type: 'string' } } }

const slack = {
  id: 'slack',
  enabled: true,
  actions: [
    { name: 'slack_search', description: 'Search messages', input, asTool: true },
    { name: 'send_message', description: 'Post a message', input },
  ],
}

const github = {
  id: 'github',
  enabled: true,
  actions: [
    { name: 'gh_pr_list', description: 'List pull requests', input, asTool: true },
  ],
}

describe('assemblePluginTools', () => {
  it('includes only actions marked as tools', () => {
    const tools = assemblePluginTools([slack])
    expect(tools.map((t) => t.name)).toEqual(['slack_search'])
    // `send_message` stays a host capability: it is not offered to the model as
    // a tool just because the plugin can perform it.
    expect(tools.map((t) => t.name)).not.toContain('send_message')
  })

  it('orders by plugin id then tool name, not by declaration order', () => {
    const scrambled = { id: 'aaa', enabled: true, actions: [
      { name: 'zzz', description: 'z', input, asTool: true },
      { name: 'aaa', description: 'a', input, asTool: true },
    ] }
    const tools = assemblePluginTools([slack, scrambled, github])
    expect(tools.map((t) => `${t.plugin}:${t.name}`)).toEqual([
      'aaa:aaa',
      'aaa:zzz',
      'github:gh_pr_list',
      'slack:slack_search',
    ])
  })

  it('is idempotent for the same inputs', () => {
    const first = assemblePluginTools([slack, github]).map((t) => t.name)
    const second = assemblePluginTools([github, slack]).map((t) => t.name)
    expect(first).toEqual(second)
  })

  it('contributes nothing from a plugin the user switched off', () => {
    expect(assemblePluginTools([{ ...slack, enabled: false }])).toEqual([])
  })

  it('contributes nothing from a plugin that is not installed', () => {
    expect(assemblePluginTools([{ ...slack, installed: false }])).toEqual([])
  })

  it('honours the session scope', () => {
    const tools = assemblePluginTools([slack, github], { allow: ['gh_pr_list'] })
    expect(tools.map((t) => t.name)).toEqual(['gh_pr_list'])

    const denied = assemblePluginTools([slack, github], { deny: ['gh_pr_list'] })
    expect(denied.map((t) => t.name)).toEqual(['slack_search'])
  })

  it('resolves a name claimed twice deterministically and reports it', () => {
    const rival = {
      id: 'zzz',
      enabled: true,
      actions: [{ name: 'slack_search', description: 'Also search', input, asTool: true }],
    }
    const tools = assemblePluginTools([rival, slack])
    expect(tools.filter((t) => t.name === 'slack_search')).toHaveLength(1)
    // Lower plugin id wins, so the result does not depend on load order.
    expect(tools.find((t) => t.name === 'slack_search')!.plugin).toBe('slack')

    expect(findToolNameCollisions([rival, slack])).toEqual([
      { name: 'slack_search', plugins: ['slack', 'zzz'] },
    ])
  })
})

describe('plugin tool names', () => {
  it('round-trips through the model-visible name', () => {
    const name = pluginToolName('slack', 'slack_search')
    expect(name).toBe('plugin__slack__slack_search')
    expect(parsePluginToolName(name)).toEqual({ plugin: 'slack', tool: 'slack_search' })
  });

  it('keeps a tool name containing double underscores intact', () => {
    // Splitting on the FIRST separator is what makes this work.
    const name = pluginToolName('gh', 'pr__list')
    expect(parsePluginToolName(name)).toEqual({ plugin: 'gh', tool: 'pr__list' })
  });

  it('replaces characters a tool name may not contain', () => {
    expect(pluginToolName('my.plugin', 'do:thing')).toBe('plugin__my_plugin__do_thing')
  });

  it('returns null for anything that is not a plugin tool', () => {
    expect(parsePluginToolName('bash')).toBeNull()
    expect(parsePluginToolName('mcp__session__call_llm')).toBeNull()
    expect(parsePluginToolName('plugin__')).toBeNull()
    expect(parsePluginToolName('plugin____x')).toBeNull()
  })

  it('cannot collide with a built-in name', () => {
    // Built-ins never start with the prefix, and the prefix cannot appear
    // inside one, so routing by name has exactly one answer.
    expect(pluginToolName('bash', 'run')).not.toBe('bash')
    expect(parsePluginToolName('plugin__slack__slack_search')?.plugin).toBe('slack')
  })
})
