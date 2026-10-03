import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
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

/**
 * 2026-10-08 wild-meadow incident regression suite: the main process's RPC
 * timer gave up at 300s while the subprocess finished the compaction 4m40s
 * later. The late `compact_result` was silently dropped (`if (!pending) return`)
 * leaving zero trace of the divergence between the main-process verdict and
 * the data layer. These tests pin the diagnosable drop log and the env-driven
 * RPC budget that makes the timing reproducible.
 */
describe('PiAgent compact_result late-reply handling', () => {
  it('logs a one-line forensics record when a late compact_result is dropped', () => {
    const agent = new PiAgent(createConfig())
    const lines: string[] = []
    ;(agent as any).debug = (msg: string) => lines.push(msg)

    ;(agent as any).handleCompactResult({
      type: 'compact_result',
      id: 'compact-1',
      success: true,
      requestedAt: Date.now() - 280_000,
      note: 'completed by the preceding compaction',
      result: { summary: 's', firstKeptEntryId: 'e', tokensBefore: 202776 },
    })

    expect(lines).toHaveLength(1)
    const line = lines[0]
    expect(line).toContain('[compact] Late compact_result dropped')
    expect(line).toContain('id=compact-1')
    expect(line).toContain('success=true')
    expect(line).toMatch(/lateMs=\d{5,}/) // ~280000ms
    expect(line).toContain('note=completed by the preceding compaction')
    expect(line).toContain('tokensBefore=202776')
    agent.destroy()
  })

  it('logs failed late replies without result fields', () => {
    const agent = new PiAgent(createConfig())
    const lines: string[] = []
    ;(agent as any).debug = (msg: string) => lines.push(msg)

    ;(agent as any).handleCompactResult({
      type: 'compact_result',
      id: 'compact-2',
      success: false,
      requestedAt: Date.now() - 1000,
      errorMessage: 'boom',
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Late compact_result dropped')
    expect(lines[0]).toContain('success=false')
    expect(lines[0]).not.toContain('tokensBefore=')
    agent.destroy()
  })

  it('resolves live pending replies as before (no drop log)', () => {
    const agent = new PiAgent(createConfig())
    const lines: string[] = []
    ;(agent as any).debug = (msg: string) => lines.push(msg)

    let resolved: unknown = null
    let rejected = false
    ;(agent as any).pendingCompactions.set('compact-3', {
      resolve: (r: unknown) => (resolved = r),
      reject: () => (rejected = true),
      sentAt: Date.now(),
    })

    ;(agent as any).handleCompactResult({
      type: 'compact_result',
      id: 'compact-3',
      success: true,
      requestedAt: Date.now(),
      result: { summary: 's', firstKeptEntryId: 'e', tokensBefore: 100 },
    })

    expect(resolved).toEqual({ summary: 's', firstKeptEntryId: 'e', tokensBefore: 100 })
    expect(rejected).toBe(false)
    expect((agent as any).pendingCompactions.has('compact-3')).toBe(false)
    expect(lines).toHaveLength(0)
    agent.destroy()
  })

  it('rejects live pending replies on success:false with the subprocess error text', () => {
    const agent = new PiAgent(createConfig())
    let resolved = false
    // Object container: a plain reassigned `let` gets control-flow-narrowed to
    // its initializer (null) by tsc, making `?.message` type `never`.
    const rejected: { value: Error | null } = { value: null }
    ;(agent as any).pendingCompactions.set('compact-4', {
      resolve: () => (resolved = true),
      reject: (e: Error) => (rejected.value = e),
      sentAt: Date.now(),
    })

    // The W<R honest "still running" verdict travels as success:false — it
    // must reject the live pending promise (surfacing the subprocess wording)
    // instead of being swallowed, or the user still sees only the RPC timeout.
    ;(agent as any).handleCompactResult({
      type: 'compact_result',
      id: 'compact-4',
      success: false,
      requestedAt: Date.now(),
      errorMessage: 'A context compaction was still in progress after waiting 30s — retry once it completes.',
    })

    expect(resolved).toBe(false)
    expect(rejected.value?.message).toContain('A context compaction was still in progress')
    expect((agent as any).pendingCompactions.has('compact-4')).toBe(false)
    agent.destroy()
  })

  it('reads CRAFT_PI_COMPACT_RPC_TIMEOUT_MS for the RPC budget (W < R invariant)', () => {
    const agent = new PiAgent(createConfig())
    const prev = process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS
    try {
      // Default is now the absolute cap (heartbeats handled separately).
      expect((agent as any).getCompactRpcTimeoutMs()).toBe(900_000)
      process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS = '12345'
      expect((agent as any).getCompactRpcTimeoutMs()).toBe(12_345)
      process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS = 'bogus'
      expect((agent as any).getCompactRpcTimeoutMs()).toBe(900_000)
    } finally {
      if (prev === undefined) delete process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS
      else process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS = prev
    }
    agent.destroy()
  })
})