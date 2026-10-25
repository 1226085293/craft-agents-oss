import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

/**
 * Regression test for the 2026-10-18 cross-session leak
 * (261016-true-sparrow → 261018-vital-moor):
 *
 * The branch kept `branchFromSessionPath` in memory, so every Pi subprocess
 * respawn re-forked the parent's LIVE transcript — the branch then answered a
 * user message that had been sent in the parent AFTER the branch was created.
 * A fork is one-shot: once the subprocess reports ready with its own session
 * id, the fork params must be dropped so later spawns resume the branch's own
 * Pi session file.
 */

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function createConfig(overrides: Partial<NonNullable<BackendConfig['session']>> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: `ws-${runId}`,
      name: 'Test Workspace',
      rootPath: `/tmp/craft-agent-branch-test-${runId}`,
    } as any,
    session: {
      id: `session-${runId}`,
      workspaceRootPath: `/tmp/craft-agent-branch-test-${runId}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      ...overrides,
    } as any,
    isHeadless: true,
  }
}

describe('PiAgent one-shot branch fork', () => {
  it('drops branch fork params once the subprocess is ready', () => {
    const onSdkSessionIdUpdate = (id: string) => captured.push(id)
    const captured: string[] = []
    const config = createConfig({
      branchFromMessageId: 'msg-1',
      branchFromSessionPath: 'C:\\sessions\\parent',
      branchFromSdkTurnId: 'entry-anchor',
    })
    config.onSdkSessionIdUpdate = onSdkSessionIdUpdate

    const agent = new PiAgent(config)
    ;(agent as any).handleLine(
      JSON.stringify({ type: 'ready', sessionId: 'pi-child-1', callbackPort: 4321 })
    )

    expect(captured).toEqual(['pi-child-1'])
    expect(config.session?.branchFromSessionPath).toBeUndefined()
    expect(config.session?.branchFromSdkTurnId).toBeUndefined()
    // Provenance survives — the UI still shows "Branch of …".
    expect(config.session?.branchFromMessageId).toBe('msg-1')
    agent.destroy()
  })

  it('leaves a non-branch session untouched', () => {
    const config = createConfig()
    const agent = new PiAgent(config)

    ;(agent as any).handleLine(
      JSON.stringify({ type: 'ready', sessionId: 'pi-plain-1', callbackPort: 4321 })
    )

    expect(config.session?.branchFromSessionPath).toBeUndefined()
    expect((agent as any).piSessionId).toBe('pi-plain-1')
    agent.destroy()
  })
})
