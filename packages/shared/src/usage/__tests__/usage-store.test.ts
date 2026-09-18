import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

import { resolveUsageTarget } from '../usage-store.ts'

describe('resolveUsageTarget', () => {
  it('resolves MCP source tools to their slug', () => {
    expect(resolveUsageTarget('mcp__linear__createIssue', {})).toEqual({ kind: 'source', slug: 'linear' })
    expect(resolveUsageTarget('mcp__dingtalk-ai-table__pat_batch_plan', {})).toEqual({ kind: 'source', slug: 'dingtalk-ai-table' })
  })

  it('resolves API bridge tools to the embedded source slug', () => {
    // Legacy standalone api-bridge server: mcp__api-bridge__api_{slug}
    expect(resolveUsageTarget('mcp__api-bridge__api_stripe', {})).toEqual({ kind: 'source', slug: 'stripe' })
  })

  it('resolves in-process API source tools to their slug', () => {
    // In-process API server (mcp-pool.ts connectInProcess): mcp__{slug}__api_{slug}
    expect(resolveUsageTarget('mcp__stripe__api_stripe', {})).toEqual({ kind: 'source', slug: 'stripe' })
  })

  it('ignores internal session MCP tools', () => {
    expect(resolveUsageTarget('mcp__session__call_llm', { model: 'x' })).toBeNull()
    expect(resolveUsageTarget('mcp__session__SubmitPlan', {})).toBeNull()
  })

  it('resolves the Skill tool to its slug', () => {
    expect(resolveUsageTarget('Skill', { skill: 'tts-voice-send' })).toEqual({ kind: 'skill', slug: 'tts-voice-send' })
    expect(resolveUsageTarget('Skill', { skill: 'my-workspace:video-speech-translate' })).toEqual({ kind: 'skill', slug: 'video-speech-translate' })
  })

  it('ignores the Skill tool without a skill param', () => {
    expect(resolveUsageTarget('Skill', {})).toBeNull()
    expect(resolveUsageTarget('Skill', undefined)).toBeNull()
  })

  it('ignores native tools', () => {
    expect(resolveUsageTarget('Read', { path: '/x' })).toBeNull()
    expect(resolveUsageTarget('Bash', { command: 'ls' })).toBeNull()
  })

  it('ignores malformed MCP tool names', () => {
    expect(resolveUsageTarget('mcp__linear', {})).toBeNull()
    expect(resolveUsageTarget('mcp__', {})).toBeNull()
  })
})

// ============================================================================
// Storage integration — run in subprocess so CONFIG_DIR (captured at module
// load) points at an isolated tmpdir, matching preferences-ui-language.test.ts.
// ============================================================================

const USAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'usage-store.ts')).href

describe('usage store (subprocess isolation)', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'usage-store-'))

  function run(script: string): { stdout: string; stderr: string; exitCode: number } {
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode ?? -1,
    }
  }

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  it('appends and aggregates source + skill usage', () => {
    const script = `
      import { appendUsage, getUsageStats } from ${JSON.stringify(USAGE_MODULE)};
      appendUsage({ kind: 'source', slug: 'linear', toolName: 'mcp__linear__createIssue', workspaceId: 'w', sessionId: 's' });
      appendUsage({ kind: 'source', slug: 'linear', toolName: 'mcp__linear__list', workspaceId: 'w', sessionId: 's' });
      appendUsage({ kind: 'skill', slug: 'tts', toolName: 'Skill', workspaceId: 'w', sessionId: 's' });
      const stats = getUsageStats({ workspaceId: 'w' });
      console.log(JSON.stringify(stats));
    `
    const { stdout, stderr, exitCode } = run(script)
    expect(exitCode).toBe(0)
    const stats = JSON.parse(stdout.trim())
    expect(stats.sources.linear.useCount).toBe(2)
    expect(stats.sources.linear.lastUsedAt).toBeTypeOf('number')
    expect(stats.skills.tts.useCount).toBe(1)
  })

  it('writes a JSONL file under the config dir', () => {
    const script = `
      import { appendUsage } from ${JSON.stringify(USAGE_MODULE)};
      appendUsage({ kind: 'source', slug: 'gh', toolName: 'mcp__gh__x', workspaceId: 'w', sessionId: 's' });
    `
    const { exitCode } = run(script)
    expect(exitCode).toBe(0)
    const file = join(configDir, 'usage', 'usage.jsonl')
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf-8').split('\n').filter(l => l.trim())
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const record = JSON.parse(lines[lines.length - 1] ?? '{}')
    expect(record.kind).toBe('source')
    expect(record.slug).toBe('gh')
    expect(record.timestamp).toBeTypeOf('number')
  })

  it('scopes aggregation by workspace when requested', () => {
    const script = `
      import { appendUsage, getUsageStats } from ${JSON.stringify(USAGE_MODULE)};
      appendUsage({ kind: 'source', slug: 'a', toolName: 'mcp__a__x', workspaceId: 'w1', sessionId: 's' });
      appendUsage({ kind: 'source', slug: 'b', toolName: 'mcp__b__x', workspaceId: 'w2', sessionId: 's' });
      console.log(JSON.stringify(getUsageStats({ workspaceId: 'w1' })));
    `
    const { stdout, exitCode } = run(script)
    expect(exitCode).toBe(0)
    const stats = JSON.parse(stdout.trim())
    expect(stats.sources.a).toBeDefined()
    expect(stats.sources.b).toBeUndefined()
  })
})
