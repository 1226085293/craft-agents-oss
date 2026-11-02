/**
 * adoptGatewayServedModel — the session side of a gateway model switch.
 *
 * When the gateway fails over (or otherwise re-routes) a conversation to a
 * different public model, the session must adopt it: `agent.setModel`
 * re-derives the subprocess compaction reserve from the new window, the
 * token-usage context window follows, and `session_model_changed` moves the
 * composer label. Same-model switches (upstream alias moved) are no-ops.
 */

import { describe, expect, it, jest } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import * as llmStorage from '@craft-agent/shared/config/storage'
import { SessionManager, createManagedSession } from './SessionManager.ts'

interface ModelStub {
  isProcessing(): boolean
  getModel(): string
  setModel(model: string): void
}

function createAgentStub() {
  const calls: string[] = []
  return {
    calls,
    isProcessing: () => false,
    getModel: () => calls[calls.length - 1] ?? 'deepseek-v4.1-flash',
    setModel: (model: string) => { calls.push(model) },
  } satisfies ModelStub & { calls: string[] }
}

function injectSession(
  sm: SessionManager,
  id: string,
  workspaceRoot: string,
  agent: ModelStub | null,
  model?: string,
) {
  const workspace = { id: 'ws_test', name: 'Test Workspace', rootPath: workspaceRoot, createdAt: Date.now() }
  const managed = createManagedSession(
    { id, name: id, llmConnection: 'slug-A', ...(model ? { model } : {}) },
    workspace as never,
    { messagesLoaded: true },
  ) as unknown as { agent: ModelStub | null; model?: string; strategy?: string }
  managed.agent = agent
  managed.model = model
  managed.strategy = 'auto'
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return managed
}

describe('adoptGatewayServedModel', () => {
  it('adopts the served model and notifies the agent', async () => {
    const connSpy = jest.spyOn(llmStorage, 'getLlmConnection').mockImplementation((slug) => ({
      slug: slug || 'default',
      name: 'test',
      providerType: 'pi_compat',
      authType: 'api_key',
      defaultModel: 'hy4-preview',
      models: [],
      createdAt: 0,
    }))
    try {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'sm-adopt-'))
      const sm = new SessionManager()
      const sendEvents: Array<{ type: string; sessionId?: string; model?: string }> = []
      ;(sm as unknown as { sendEvent: (event: never, workspaceId: string) => void }).sendEvent = ((event: { type: string; sessionId?: string; model?: string }, _ws: string) => {
        sendEvents.push(event)
      }) as never
      const agent = createAgentStub()
      injectSession(sm, 'gw-a', tmpRoot, agent)

      ;(sm as unknown as { adoptGatewayServedModel: (id: string, model: string) => void })
        .adoptGatewayServedModel('gw-a', 'hy4-preview')
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(agent.calls).toEqual(['hy4-preview'])
      expect(sendEvents.some((e) => e.type === 'session_model_changed' && e.sessionId === 'gw-a' && e.model === 'hy4-preview')).toBe(true)
    } finally {
      connSpy.mockRestore()
    }
  })

  it('is a no-op when the session is already on the served model', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sm-adopt-'))
    const sm = new SessionManager()
    const agent = createAgentStub()
    injectSession(sm, 'gw-a', tmpRoot, agent, 'hy4-preview')

    ;(sm as unknown as { adoptGatewayServedModel: (id: string, model: string) => void })
      .adoptGatewayServedModel('gw-a', 'hy4-preview')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(agent.calls).toEqual([])
  })

  it('ignores sessions it does not own', () => {
    const sm = new SessionManager()
    expect(() => {
      ;(sm as unknown as { adoptGatewayServedModel: (id: string, model: string) => void })
        .adoptGatewayServedModel('missing', 'hy4-preview')
    }).not.toThrow()
  })
})
