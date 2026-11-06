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
    source: 'workspace' as const,
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
    const entry = listener('no-runtime', [], { manifest: { spec: 'craft-listener/1', id: 'no-runtime', name: 'x', version: '1.0.0' } })
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

  it('snapshots the log tail into startupErrorTail when giving up failed', async () => {
    const entry = listener('crasher', [])
    const script = join(entry.dir, 'crash.js')
    writeFileSync(script, 'console.error("fatal: dependency gone"); process.exit(3);', 'utf8')
    entry.manifest.runtime = {
      program: [process.execPath, script],
      readyTimeoutMs: 500,
      restart: { policy: 'on-failure', maxAttempts: 2, backoffMs: [10, 10] },
    }
    supervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const status = supervisor.getStatus('crasher')
    expect(status.state).toBe('failed')
    expect(status.startupErrorTail).toBeTruthy()
    expect(status.startupErrorTail).toContain('fatal: dependency gone')
  })

  it('keeps startupErrorTail off a clean exit', async () => {
    const entry = listener('clean', [])
    const script = join(entry.dir, 'clean.js')
    writeFileSync(script, 'process.exit(0);', 'utf8')
    entry.manifest.runtime = {
      program: [process.execPath, script],
      readyTimeoutMs: 500,
      restart: { policy: 'on-failure', maxAttempts: 2, backoffMs: [10, 10] },
    }
    supervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const status = supervisor.getStatus('clean')
    expect(status.state).toBe('stopped')
    expect(status.startupErrorTail).toBeUndefined()
  })

  it('writes user config to config.json and hands its path via CRAFT_LISTENER_CONFIG', async () => {
    const entry = listener('withcfg', [])
    entry.config = { email: 'me@qq.com', authCode: 'secret-123' }
    // The child prints the config it received back onto stdout, which lands in
    // proc.log and proves the env → file → child chain actually closed.
    const script = [
      'const fs=require("fs");',
      'const p=process.env.CRAFT_LISTENER_CONFIG;',
      'const c=JSON.parse(fs.readFileSync(p,"utf8"));',
      'console.log("cfg:"+c.email+":"+c.authCode);',
      'setInterval(()=>{},1000);',
    ].join('')
    writeFileSync(join(entry.dir, 'echo.js'), script, 'utf8')
    entry.manifest.runtime = { program: [process.execPath, join(entry.dir, 'echo.js')], readyTimeoutMs: 500 }

    supervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const configPath = join(entry.dataDir, 'config.json')
    expect(existsSync(configPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk).toEqual({ email: 'me@qq.com', authCode: 'secret-123' })

    const log = readFileSync(join(entry.dataDir, 'proc.log'), 'utf8')
    expect(log).toContain('cfg:me@qq.com:secret-123')
  })
})
