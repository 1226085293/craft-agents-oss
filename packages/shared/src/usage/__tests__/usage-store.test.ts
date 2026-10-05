import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { pathToFileURL } from 'url'

import { resolveUsageTarget, resolveSkillReadUsageTarget } from '../usage-store.ts'

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

  it('counts the real target of layered call_tool dispatch', () => {
    // Tool-layering: the model calls mcp__session__call_tool; the real folded
    // source tool is inside input.name (or args.name).
    expect(resolveUsageTarget('mcp__session__call_tool', { name: 'mcp__codegraph__codegraph_explore' }))
      .toEqual({ kind: 'source', slug: 'codegraph' })
    expect(resolveUsageTarget('mcp__session__call_tool', { name: 'mcp__codegraph__codegraph_explore', args: { query: 'x' } }))
      .toEqual({ kind: 'source', slug: 'codegraph' })
    // API tools targeted via call_tool (in-process API proxy name)
    expect(resolveUsageTarget('mcp__session__call_tool', { name: 'mcp__stripe__api_stripe', args: { method: 'GET' } }))
      .toEqual({ kind: 'source', slug: 'stripe' })
    // Internal targets remain untracked
    expect(resolveUsageTarget('mcp__session__call_tool', { name: 'mcp__session__call_llm' })).toBeNull()
    expect(resolveUsageTarget('mcp__session__call_tool', {})).toBeNull()
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

describe('resolveSkillReadUsageTarget', () => {
  const context = {
    workspaceRootPath: '/workspace',
    workingDirectory: '/project',
    globalSkillsPath: '/home/user/.agents/skills',
  }

  it('resolves global, workspace, and project skill files', () => {
    expect(resolveSkillReadUsageTarget('Read', {
      file_path: '/home/user/.agents/skills/tts-voice-send/SKILL.md',
    }, false, context)).toEqual({ kind: 'skill', slug: 'tts-voice-send' })
    expect(resolveSkillReadUsageTarget('Read', {
      file_path: '/workspace/skills/brainstorming/references/testing-anti-patterns.md',
    }, false, context)).toEqual({ kind: 'skill', slug: 'brainstorming' })
    expect(resolveSkillReadUsageTarget('Read', {
      path: '/project/.agents/skills/ui-ux-pro-max/SKILL.md',
    }, false, context)).toEqual({ kind: 'skill', slug: 'ui-ux-pro-max' })
  })

  it('expands a tilde path into the default global skills root', () => {
    expect(resolveSkillReadUsageTarget('Read', {
      file_path: '~/.agents/skills/video-speech-translate/references.md',
    }, false, {
      workspaceRootPath: '/workspace',
    })).toEqual({ kind: 'skill', slug: 'video-speech-translate' })
    expect(homedir()).toBeTruthy()
  })

  it('matches Windows drive paths with either separator style and case', () => {
    expect(resolveSkillReadUsageTarget('Read', {
      file_path: 'C:\\Users\\Alice\\.agents\\skills\\brainstorming\\testing-anti-patterns.md',
    }, false, {
      workspaceRootPath: 'C:/Users/Alice/.craft-agent/workspaces/main',
      workingDirectory: 'C:/repo',
      globalSkillsPath: 'c:/users/alice/.agents/skills',
    })).toEqual({ kind: 'skill', slug: 'brainstorming' })

    expect(resolveSkillReadUsageTarget('Read', {
      file_path: 'C:/Users/Alice/.agents/skills/brainstorming/SKILL.md',
    }, false, {
      workspaceRootPath: 'C:\\Users\\Alice\\.craft-agent\\workspaces\\main',
      workingDirectory: 'C:\\repo',
      globalSkillsPath: 'C:\\Users\\Alice\\.agents\\skills',
    })).toEqual({ kind: 'skill', slug: 'brainstorming' })
  })

  it('matches UNC paths case-insensitively after slash normalization', () => {
    expect(resolveSkillReadUsageTarget('Read', {
      file_path: '\\\\SERVER\\Share\\.agents\\skills\\demo\\SKILL.md',
    }, false, {
      workspaceRootPath: '\\\\server\\share\\workspace',
      workingDirectory: '\\\\server\\share\\repo',
      globalSkillsPath: '\\\\server\\share\\.agents\\skills',
    })).toEqual({ kind: 'skill', slug: 'demo' })
  })

  it('resolves relative paths against the working directory or workspace root', () => {
    expect(resolveSkillReadUsageTarget('Read', {
      file_path: '.agents\\skills\\demo\\SKILL.md',
    }, false, context)).toEqual({ kind: 'skill', slug: 'demo' })
    expect(resolveSkillReadUsageTarget('Read', {
      file_path: 'skills\\workspace-skill\\notes.md',
    }, false, {
      workspaceRootPath: '/workspace',
      globalSkillsPath: '/home/user/.agents/skills',
    })).toEqual({ kind: 'skill', slug: 'workspace-skill' })
  })

  it('rejects unsuccessful reads, non-Read tools, ordinary paths, and root-prefix siblings', () => {
    expect(resolveSkillReadUsageTarget('Bash', {
      file_path: '/workspace/skills/demo/SKILL.md',
    }, false, context)).toBeNull()
    expect(resolveSkillReadUsageTarget('Read', {
      file_path: '/workspace/skills/demo/SKILL.md',
    }, true, context)).toBeNull()
    expect(resolveSkillReadUsageTarget('Read', { file_path: '/workspace/README.md' }, false, context)).toBeNull()
    expect(resolveSkillReadUsageTarget('Read', { file_path: '/workspace/skills' }, false, context)).toBeNull()
    expect(resolveSkillReadUsageTarget('Read', { file_path: '/workspace/skills/demo' }, false, context)).toBeNull()
    expect(resolveSkillReadUsageTarget('Read', {
      file_path: '/workspace/skills-extra/demo/SKILL.md',
    }, false, context)).toBeNull()
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
