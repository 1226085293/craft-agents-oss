import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

const MODEL_ID = 'claude-sonnet-5'

function createConfig(contextWindow: number): BackendConfig {
  return {
    provider: 'pi',
    model: MODEL_ID,
    runtime: { customModels: [{ id: MODEL_ID, contextWindow }] },
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

function contextWindowOf(agent: PiAgent): number | undefined {
  return (agent as any).adapter.contextWindow
}

describe('PiAgent configured context window', () => {
  it('uses an explicit configured window when constructing a built-in model', () => {
    const agent = new PiAgent(createConfig(256_000))
    try {
      expect(contextWindowOf(agent)).toBe(256_000)
    } finally {
      agent.destroy()
    }
  })

  it('updates the context window from refreshed model capabilities', async () => {
    const agent = new PiAgent(createConfig(256_000))
    try {
      await expect(agent.updateRuntimeConfig({
        model: MODEL_ID,
        runtime: { customModels: [{ id: MODEL_ID, contextWindow: 384_000 }] },
      })).resolves.toBe(true)
      expect(contextWindowOf(agent)).toBe(384_000)
    } finally {
      agent.destroy()
    }
  })
})
