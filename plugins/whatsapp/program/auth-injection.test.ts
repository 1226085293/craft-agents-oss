/**
 * WhatsApp path injection — the bug that kept this plugin at `/health` 503.
 *
 * `createAdapter()` used to take no arguments, so `workerEntry` and
 * `authStateDir` were always undefined and `initialize` threw on every start.
 * These tests pin the contract that fixed it: both are resolved from the
 * plugin's own data dir, the worker path is absolute, and an explicit config
 * value still wins.
 */

import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveWhatsAppConfig, createAuth } from './index.ts'

const REPO = join(import.meta.dir, '..', '..', '..')
const BUILT_WORKER = join(REPO, 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs')

describe('resolveWhatsAppConfig', () => {
  it('derives authStateDir from the plugin data dir', () => {
    const dataDir = join(REPO, 'tmp-test-data', 'whatsapp')
    const resolved = resolveWhatsAppConfig({ config: {}, dataDir })
    expect(resolved.authStateDir).toBe(join(dataDir, 'wa-auth'))
  })

  it('resolves an absolute worker entry that exists', () => {
    const resolved = resolveWhatsAppConfig({ config: {}, dataDir: join(REPO, 'tmp-test-data', 'w') })
    expect(resolved.workerEntry).toBe(BUILT_WORKER)
    // Relative would be resolved against the child's cwd (the plugin dir) and
    // fail with "Module not found" — the path must be absolute and real.
    expect(existsSync(resolved.workerEntry)).toBe(true)
  })

  it('prefers explicit config over derived defaults', () => {
    const resolved = resolveWhatsAppConfig({
      config: { authStateDir: '/custom/auth', workerEntry: '/custom/worker.cjs', nodeBin: '/custom/node' },
      dataDir: '/ignored',
    })
    expect(resolved.authStateDir).toBe('/custom/auth')
    expect(resolved.workerEntry).toBe('/custom/worker.cjs')
    expect(resolved.nodeBin).toBe('/custom/node')
  })

  it('runs the worker on node when the plugin itself runs on bun', () => {
    const resolved = resolveWhatsAppConfig({ config: {}, dataDir: '/d' })
    // The worker is a Node-targeted CJS bundle; process.execPath under bun is
    // bun.exe, which is not what it was built for.
    expect(resolved.nodeBin).toBe(process.versions.bun ? 'node' : process.execPath)
  })
})

describe('createAuth', () => {
  it('starts idle and always answers state()', () => {
    const auth = createAuth({ config: {}, dataDir: join(REPO, 'tmp-test-data', 'idle') })
    expect(auth.state().phase).toBe('idle')
  })

  it('reports a failed attempt instead of throwing when the worker is missing', async () => {
    const auth = createAuth({
      config: { workerEntry: join(REPO, 'definitely-not-here.cjs'), nodeBin: 'node' },
      dataDir: join(REPO, 'tmp-test-data', 'broken'),
    })
    const state = await auth.start()
    // The important part is that start() resolves — a throw here is what turned
    // into a `/health` 503 forever.
    expect(state.phase).toBe('failed')
    expect(state.error).toBeTruthy()
    await auth.cancel()
  })
})
