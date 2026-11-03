import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ListenerSupervisor } from './listener-supervisor.ts'
import type { LoadedListener } from './listener-registry.ts'

let root: string
let supervisor: ListenerSupervisor
const statuses: string[] = []

function listener(id: string, program: string[], overrides: Partial<LoadedListener> = {}): LoadedListener {
  const dir = join(root, 'events', id)
  const dataDir = join(root, 'events-data', id)
  mkdirSync(dir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  return {
    id,
    manifest: {
      spec: 'craft-listener/1',
      id,
      name: id,
      version: '1.0.0',
      eventTypes: ['test.ping'],
      runtime: { program, readyTimeoutMs: 500, restart: { policy: 'on-failure', maxAttempts: 2, backoffMs: [10, 20] } },
    },
    dir,
    dataDir,
    enabled: true,
    config: {},
    dependencies: [],
    ready: true,
    errors: [],
    warnings: [],
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-supervisor-'))
  statuses.length = 0
  supervisor = new ListenerSupervisor({
    envFor: (id) => ({ CRAFT_EVENTS_URL: `http://127.0.0.1:1/events/${id}`, CRAFT_EVENTS_TOKEN: 't' }),
    onStatus: (status) => statuses.push(status.state),
  })
})

afterEach(async () => {
  await supervisor.stopAll()
  rmSync(root, { recursive: true, force: true })
})

describe('ListenerSupervisor', () => {
  it('runs a program that stays alive and marks it running when healthy', async () => {
    // The listener script: print, then idle.
    const entry = listener('live', [])
    const script = join(entry.dir, 'listener.js')
    writeFileSync(script, 'console.log("started"); setInterval(() => {}, 1000);', 'utf8')
    entry.manifest.runtime = { program: [process.execPath, script], readyTimeoutMs: 500 }

    const status = supervisor.start(entry)
    expect(status.state).toBe('starting')
    expect(status.pid).toBeGreaterThan(0)

    supervisor.markHealthy('live')
    expect(supervisor.getStatus('live').state).toBe('running')

    await supervisor.stop('live')
    expect(supervisor.getStatus('live').state).toBe('stopped')
  })

  it('writes stdout to proc.log', async () => {
    const entry = listener('logger', [process.execPath, '-e', 'console.log("hello-from-listener")'])
    supervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const logPath = join(entry.dataDir, 'proc.log')
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf8')).toContain('hello-from-listener')
  })

  it('marks the listener failed when the command does not exist', async () => {
    const entry = listener('missing-bin', ['definitely-not-a-real-binary-xyz'])
    const status = supervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = supervisor.getStatus('missing-bin')
    expect([status.state, after.state]).toContain('failed')
    expect(after.lastError ?? '').toContain('spawn error')
  })

  it('refuses to start a listener without a runtime program', () => {
    const entry = listener('no-runtime', [], { manifest: { spec: 'craft-listener/1', id: 'no-runtime', name: 'x', version: '1.0.0', eventTypes: [] } })
    const status = supervisor.start(entry)
    expect(status.state).toBe('failed')
    expect(status.lastError).toContain('no runtime.program')
  })

  it('reports stopped for an unknown listener', async () => {
    expect(supervisor.getStatus('nope').state).toBe('stopped')
    await supervisor.stop('nope')
    expect(supervisor.getStatus('nope').state).toBe('stopped')
  })

  it('exposes the tail of the log', async () => {
    const entry = listener('tail', [process.execPath, '-e', 'console.log("line-1\\nline-2")'])
    supervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const tail = supervisor.tailLog('tail', entry.dataDir)
    expect(tail).toContain('line-1')
    expect(tail).toContain('line-2')
  })
})
