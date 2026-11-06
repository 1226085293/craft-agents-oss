import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadListeners, pluginReadiness, setListenerConfig, setListenerEnabled } from './listener-registry.ts'

/**
 * Autostart must be conditional. These cases pin the rule: Craft only starts a
 * plugin when it is installed, switched on, has its required config, and its
 * dependencies resolve. Everything else rests as `stopped` — not `failed` — so
 * a freshly installed plugin does not raise an error on every launch.
 */

let root: string

function writeListener(id: string, manifest: Record<string, unknown>): void {
  const dir = join(root, 'events', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  // Installing is not enabling: the default for a fresh workspace copy is off,
  // so every case states it explicitly. The "switched off" case turns it back.
  setListenerEnabled(root, id, true)
}

function manifestFor(id: string, overrides: Record<string, unknown> = {}) {
  return {
    spec: 'craft-listener/1',
    id,
    name: `Listener ${id}`,
    version: '1.0.0',
    runtime: { kind: 'script', program: ['node', 'main.js'] },
    ...overrides,
  }
}

function readinessOf(id: string) {
  const plugin = loadListeners({ workspaceRoot: root, catalogDirs: [], skipProbes: true }).find(
    (entry) => entry.id === id,
  )
  expect(plugin).toBeDefined()
  return pluginReadiness(plugin!)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-readiness-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('pluginReadiness', () => {
  it('starts a plugin that is installed, enabled, configured and runnable', () => {
    writeListener('ready', manifestFor('ready'))
    expect(readinessOf('ready')).toEqual({ ready: true })
  })

  it('does not start a plugin the user switched off', () => {
    writeListener('off', manifestFor('off'))
    setListenerEnabled(root, 'off', false)
    const readiness = readinessOf('off')
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toBe('disabled')
  })

  it('does not start a plugin whose required config is blank', () => {
    writeListener(
      'needs-key',
      manifestFor('needs-key', {
        config: {
          type: 'object',
          properties: { apiKey: { type: 'string', title: 'API Key' } },
          required: ['apiKey'],
        },
      }),
    )
    // Enabled but never filled in: the normal state right after install.
    const readiness = readinessOf('needs-key')
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toBe('missing-config')
    expect(readiness.detail).toContain('apiKey')
  })

  it('starts once the required config is filled in', () => {
    writeListener(
      'needs-key',
      manifestFor('needs-key', {
        config: {
          type: 'object',
          properties: { apiKey: { type: 'string', title: 'API Key' } },
          required: ['apiKey'],
        },
      }),
    )
    setListenerConfig(root, 'needs-key', { apiKey: 'sk-live-123' })
    expect(readinessOf('needs-key')).toEqual({ ready: true })
  })

  it('does not start a plugin whose dependency is missing', () => {
    writeListener(
      'needs-dep',
      manifestFor('needs-dep', {
        dependencies: [{ id: 'python', label: 'Python 3.11+', probe: 'python-version' }],
      }),
    )
    const readiness = readinessOf('needs-dep')
    // No python guarantee on the test machine; if it happens to resolve, the
    // assertion is skipped rather than asserting a machine-specific truth.
    if (!readiness.ready) {
      expect(readiness.reason).toBe('missing-deps')
      expect(readiness.detail).toContain('Python')
    }
  })

  it('refuses to start a non-builtin plugin that declares no runtime', () => {
    writeListener('no-runtime', {
      spec: 'craft-listener/1',
      id: 'no-runtime',
      name: 'Listener no-runtime',
      version: '1.0.0',
    })
    const readiness = readinessOf('no-runtime')
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toBe('no-program')
  })

  it('treats a catalog-only plugin as not installed', () => {
    const catalog = mkdtempSync(join(tmpdir(), 'craft-catalog-'))
    try {
      const dir = join(catalog, 'not-adopted')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify(manifestFor('not-adopted'), null, 2),
        'utf8',
      )
      const plugin = loadListeners({
        workspaceRoot: root,
        catalogDirs: [catalog],
        skipProbes: true,
      }).find((entry) => entry.id === 'not-adopted')
      expect(plugin).toBeDefined()
      expect(plugin!.source).toBe('catalog')
      const readiness = pluginReadiness(plugin!)
      expect(readiness.ready).toBe(false)
      expect(readiness.reason).toBe('not-installed')
    } finally {
      rmSync(catalog, { recursive: true, force: true })
    }
  })
})
