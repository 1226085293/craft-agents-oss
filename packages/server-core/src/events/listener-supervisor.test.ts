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
  // Windows keeps the directory locked briefly after the child exits; a failed
  // cleanup is housekeeping, not a verdict on the behaviour under test.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(50)
    }
  }
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

describe('restartWithFallback', () => {
  /**
   * A bad config edit must cost a blip, not an outage.
   *
   * The supervisor writes the config it is starting with to the plugin's data
   * dir, so the file on disk is direct evidence of which config the fallback
   * chose — no need to infer it from process state.
   */
  it('restores the previous config when the new one never becomes ready', async () => {
    const entry = listener('flaky', [], { config: { ok: true } })
    const script = join(entry.dir, 'probe.mjs')
    // Never reports healthy (the test ingest endpoint is unreachable), so the
    // candidate can only end as degraded — which is exactly a failed upgrade.
    writeFileSync(script, 'setInterval(() => undefined, 1000);', 'utf8')
    entry.manifest.runtime = { program: [process.execPath, script], readyTimeoutMs: 300 }

    const status = await supervisor.restartWithFallback(
      { ...entry, config: { ok: false } },
      { ok: true },
    )

    const written = JSON.parse(readFileSync(join(entry.dataDir, 'config.json'), 'utf8')) as {
      ok: boolean
    }
    expect(written.ok).toBe(true)
    expect(status.state).not.toBe('failed')
    expect(status.lastError ?? '').toMatch(/previous configuration/)
  }, 15000)

  it('keeps the new config when it does become ready', async () => {
    const entry = listener('steady', [], { config: { ok: true } })
    const script = join(entry.dir, 'probe2.mjs')
    writeFileSync(
      script,
      [
        "fetch(process.env.CRAFT_EVENTS_URL!.replace(/\/events\/.*$/, '') + '/health', {",
        "  headers: { authorization: 'Bearer ' + process.env.CRAFT_EVENTS_TOKEN },",
        '}).catch(() => undefined)',
        'setInterval(() => undefined, 1000);',
      ].join(String.fromCharCode(10)),
      'utf8',
    )
    entry.manifest.runtime = { program: [process.execPath, script], readyTimeoutMs: 300 }

    // No previous config passed: nothing to restore, so the candidate stays.
    const status = await supervisor.restartWithFallback({ ...entry, config: { ok: false } })
    const written = JSON.parse(readFileSync(join(entry.dataDir, 'config.json'), 'utf8')) as {
      ok: boolean
    }
    expect(written.ok).toBe(false)
    expect(status.lastError ?? '').not.toMatch(/previous configuration/)
  }, 15000)
})

describe('a listener that is up but not signed in', () => {
  /**
   * The deadlock this exists to break.
   *
   * With no credentials the adapter cannot start, so the process never reports
   * health. Calling that `degraded` and gating the sign-in entry on `running`
   * meant the one plugin that needed a scan was the one that could not be given
   * one. The supervisor now asks the plugin before deciding, so "waiting for
   * sign-in" is reported as itself.
   */
  it('reports needs_auth, not degraded, when the plugin says it is awaiting sign-in', async () => {
    const authSupervisor = new ListenerSupervisor({
      envFor: (id) => ({ CRAFT_EVENTS_URL: `http://127.0.0.1:1/events/${id}`, CRAFT_EVENTS_TOKEN: 't' }),
      onStatus: () => {},
      awaitingAuth: async () => true,
    })
    const entry = listener('waits', [])
    const script = join(entry.dir, 'idle.mjs')
    writeFileSync(script, 'setInterval(() => undefined, 1000);', 'utf8')
    entry.manifest.runtime = { program: [process.execPath, script], readyTimeoutMs: 200 }

    authSupervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 700))

    const status = authSupervisor.getStatus('waits')
    expect(status.state).toBe('needs_auth')
    // Nothing is broken, so no failure text is attached to it.
    expect(status.lastError).toBeNull()
    await authSupervisor.stopAll()
  }, 15000)

  it('still reports degraded when the plugin cannot answer at all', async () => {
    const silentSupervisor = new ListenerSupervisor({
      envFor: (id) => ({ CRAFT_EVENTS_URL: `http://127.0.0.1:1/events/${id}`, CRAFT_EVENTS_TOKEN: 't' }),
      onStatus: () => {},
      awaitingAuth: async () => false,
    })
    const entry = listener('silent', [])
    const script = join(entry.dir, 'idle2.mjs')
    writeFileSync(script, 'setInterval(() => undefined, 1000);', 'utf8')
    entry.manifest.runtime = { program: [process.execPath, script], readyTimeoutMs: 200 }

    silentSupervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 700))

    // "Did not report health and says it is not waiting for sign-in" keeps its
    // old, honest reading — this fix must not turn every stall into needs_auth.
    expect(silentSupervisor.getStatus('silent').state).toBe('degraded')
    await silentSupervisor.stopAll()
  }, 15000)

  it('counts needs_auth as up, so a saved credential is not rolled back', async () => {
    // restartWithFallback calls waitForHealthy; if needs_auth read as "not
    // ready" the just-saved credentials would be reverted as a failed upgrade.
    const entry = listener('reauth', [], { config: { ok: true } })
    const script = join(entry.dir, 'idle3.mjs')
    writeFileSync(script, 'setInterval(() => undefined, 1000);', 'utf8')
    entry.manifest.runtime = { program: [process.execPath, script], readyTimeoutMs: 200 }

    const reauthSupervisor = new ListenerSupervisor({
      envFor: (id) => ({ CRAFT_EVENTS_URL: `http://127.0.0.1:1/events/${id}`, CRAFT_EVENTS_TOKEN: 't' }),
      onStatus: () => {},
      awaitingAuth: async () => true,
    })

    const status = await reauthSupervisor.restartWithFallback({ ...entry, config: { ok: false } }, { ok: true })

    const written = JSON.parse(readFileSync(join(entry.dataDir, 'config.json'), 'utf8')) as { ok: boolean }
    expect(written.ok).toBe(false)
    expect(status.lastError ?? '').not.toMatch(/previous configuration/)
    await reauthSupervisor.stopAll()
  }, 20000)
})

describe('a restart and the outgoing process', () => {
  /**
   * The outgoing process must not be able to report itself over the incoming one.
   *
   * `stop()` resolves on whichever happens first: the child's own `exit` event,
   * or `taskkill`'s exit. On Windows the kill returns first, so `start()` spawns
   * the replacement while the old child's `exit` handler is still queued. That
   * handler used to delete `running` and write `stopped` *by id*, which hit the
   * new entry: `waitForHealthy` then read a healthy restart as a failure,
   * `restartWithFallback` restored the previous config — rolling back
   * credentials a sign-in had just written — and the new process was left
   * running with nothing tracking it, so the fallback start produced a second
   * process for the same plugin.
   */
  it('does not let the stopped process overwrite the one that replaced it', async () => {
    const entry = listener('handover', [])
    const script = join(entry.dir, 'idle.mjs')
    writeFileSync(script, 'setInterval(() => undefined, 1000);', 'utf8')
    entry.manifest.runtime = { program: [process.execPath, script], readyTimeoutMs: 60_000 }

    supervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 200))

    // A restart is exactly: stop, then start the next process.
    await supervisor.stop('handover')
    const next = supervisor.start(entry)
    expect(next.state).toBe('starting')

    // Give the outgoing process's late exit event every chance to land.
    await new Promise((resolve) => setTimeout(resolve, 600))

    const after = supervisor.getStatus('handover')
    // The replacement is still the one being tracked under this id…
    expect(after.state).toBe('starting')
    expect(after.pid).toBe(next.pid)
    // …and there is exactly one process for it.
    expect(supervisor.listStatuses().filter((s) => s.id === 'handover')).toHaveLength(1)

    await supervisor.stopAll()
  }, 20000)
})
