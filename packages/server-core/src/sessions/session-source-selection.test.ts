import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import type { SessionEvent } from '@craft-agent/shared/protocol'

/**
 * Mid-turn source selection must update the user-owned picker state immediately,
 * while leaving the current turn's MCP/API pool intact. The latest selection is
 * reconciled only after the current turn has completely stopped.
 */
describe('SessionManager session source selection', () => {
  let tmpRoot: string
  let sm: SessionManager
  const sourceSyncCalls: string[][] = []
  let activeSourceSlugs: string[] = []
  let events: SessionEvent[] = []

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-source-selection-'))
    sm = new SessionManager()
    sourceSyncCalls.length = 0
    activeSourceSlugs = []
    events = []
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function writeLocalSource(slug: string): void {
    const dir = join(tmpRoot, 'sources', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      id: slug,
      slug,
      name: slug,
      type: 'local',
      provider: 'local',
      enabled: true,
      tagline: `${slug} test folder`,
      local: { path: tmpRoot },
    }, null, 2))
    writeFileSync(join(dir, 'guide.md'), `# ${slug}\n`)
  }

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'source selection test', messagesLoaded: true, enabledSourceSlugs: ['alpha'] },
      workspace as never,
      { messagesLoaded: true },
    )
    managed.agent = {
      getActiveSourceSlugs: () => [...activeSourceSlugs],
      getSummarizeCallback: () => undefined,
      setAllSources: () => {},
      applyBridgeUpdates: async () => {},
      setSourceServers: async (_mcp: unknown, _api: unknown, intended: string[] = []) => {
        sourceSyncCalls.push([...intended])
        activeSourceSlugs = [...intended]
      },
    } as never
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    sm.setEventSink(((...args: unknown[]) => {
      const event = args.at(-1)
      if (event && typeof event === 'object' && 'type' in event) events.push(event as SessionEvent)
    }) as never)
    return managed
  }

  it('keeps in-flight source tools connected and flushes the latest picker choice after stop', async () => {
    writeLocalSource('alpha')
    writeLocalSource('beta')
    writeLocalSource('gamma')
    const alphaCredentialCache = join(tmpRoot, 'sources', 'alpha', '.credential-cache.json')
    writeFileSync(alphaCredentialCache, '{"token":"in-flight"}')

    const sessionId = 'source-snapshot'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.appliedSourceSlugs = ['alpha']
    activeSourceSlugs = ['alpha']

    await sm.setSessionSources(sessionId, ['beta'])
    await sm.setSessionSources(sessionId, ['gamma'])

    // The selection is reflected in persisted/UI-facing state immediately,
    // but toggling sources must not mutate this turn's agent or credentials.
    expect(managed.enabledSourceSlugs).toEqual(['gamma'])
    expect(events.filter(e => e.type === 'sources_changed').at(-1)).toMatchObject({
      type: 'sources_changed',
      enabledSourceSlugs: ['gamma'],
    })
    expect(sourceSyncCalls).toEqual([])
    expect(activeSourceSlugs).toEqual(['alpha'])
    expect(existsSync(alphaCredentialCache)).toBe(true)

    await (sm as unknown as { onProcessingStopped: (id: string, reason: 'complete') => Promise<void> })
      .onProcessingStopped(sessionId, 'complete')

    expect(sourceSyncCalls).toEqual([['gamma']])
    expect(activeSourceSlugs).toEqual(['gamma'])
    expect(existsSync(alphaCredentialCache)).toBe(false)
    expect(managed.isProcessing).toBe(false)
  })
})
