import { describe, expect, it } from 'bun:test'
import { shouldRefreshUsageStats } from '../usage-refresh'

describe('shouldRefreshUsageStats', () => {
  it('refreshes after explicit skill and source tool starts', () => {
    expect(shouldRefreshUsageStats({
      type: 'tool_start', sessionId: 's', toolName: 'Skill', toolUseId: 'skill-1', toolInput: {},
    })).toBe(true)
    expect(shouldRefreshUsageStats({
      type: 'tool_start', sessionId: 's', toolName: 'mcp__linear__list', toolUseId: 'source-1', toolInput: {},
    })).toBe(true)
  })

  it('refreshes after a successful native Read result', () => {
    expect(shouldRefreshUsageStats({
      type: 'tool_result', sessionId: 's', toolUseId: 'read-1', toolName: 'Read', result: 'skill content', isError: false,
    })).toBe(true)
  })

  it('ignores failed Reads, Read starts, and unrelated tools', () => {
    expect(shouldRefreshUsageStats({
      type: 'tool_result', sessionId: 's', toolUseId: 'read-1', toolName: 'Read', result: 'Error: missing', isError: true,
    })).toBe(false)
    expect(shouldRefreshUsageStats({
      type: 'tool_start', sessionId: 's', toolName: 'Read', toolUseId: 'read-1', toolInput: { file_path: '/workspace/skills/demo/SKILL.md' },
    })).toBe(false)
    expect(shouldRefreshUsageStats({
      type: 'tool_start', sessionId: 's', toolName: 'Bash', toolUseId: 'bash-1', toolInput: {},
    })).toBe(false)
    expect(shouldRefreshUsageStats({
      type: 'tool_result', sessionId: 's', toolUseId: 'bash-1', toolName: 'Bash', result: 'ok', isError: false,
    })).toBe(false)
  })
})
