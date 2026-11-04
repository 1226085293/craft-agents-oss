import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearProbeCache,
  loadListeners,
  missingConfigKeys,
  setListenerConfig,
  setListenerEnabled,
} from './listener-registry.ts'

let root: string

function writeListener(id: string, manifest: Record<string, unknown>): void {
  const dir = join(root, 'events', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

function manifestFor(id: string, overrides: Record<string, unknown> = {}) {
  return {
    spec: 'craft-listener/1',
    id,
    name: `Listener ${id}`,
    version: '1.0.0',
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-listeners-'))
  clearProbeCache()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('loadListeners', () => {
  it('returns nothing when there is no events directory', () => {
    expect(loadListeners({ workspaceRoot: root })).toEqual([])
  })

  it('loads a manifest and defaults to disabled, not ready without a runtime', () => {
    writeListener('quiet', manifestFor('quiet'))
    const [listener] = loadListeners({ workspaceRoot: root, skipProbes: true })
    expect(listener?.id).toBe('quiet')
    expect(listener?.enabled).toBe(false)
    expect(listener?.ready).toBe(false)
    expect(listener?.warnings.join()).toContain('no runtime.program')
  })

  it('reports a directory without a manifest as an error entry', () => {
    mkdirSync(join(root, 'events', 'empty'), { recursive: true })
    const [listener] = loadListeners({ workspaceRoot: root, skipProbes: true })
    expect(listener?.id).toBe('empty')
    expect(listener?.errors.join()).toContain('manifest.json is missing')
  })

  it('reports invalid JSON instead of throwing', () => {
    const dir = join(root, 'events', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), '{ nope', 'utf8')
    const [listener] = loadListeners({ workspaceRoot: root, skipProbes: true })
    expect(listener?.errors.join()).toContain('not valid JSON')
  })

  it('rejects a manifest whose id disagrees with its directory', () => {
    writeListener('dir-name', manifestFor('other-id'))
    const [listener] = loadListeners({ workspaceRoot: root, skipProbes: true })
    expect(listener?.errors.join()).toContain('does not match directory name')
  })

  it('marks a listener ready when its runtime is present', () => {
    writeListener(
      'with-runtime',
      manifestFor('with-runtime', {
        runtime: { program: ['python', '-u', '${dir}/listener.py'] },
        dependencies: { runtime: { python: '>=3.8' } },
      }),
    )
    const [listener] = loadListeners({ workspaceRoot: root })
    const python = listener?.dependencies.find((dep) => dep.kind === 'runtime')
    // The probe shells out to the real python on this machine.
    expect(python?.state).toBe('ok')
    expect(python?.found).toBeTruthy()
    expect(listener?.ready).toBe(true)
  })

  it('flags a runtime that cannot satisfy the range', () => {
    writeListener(
      'old-python',
      manifestFor('old-python', {
        runtime: { program: ['python'] },
        dependencies: { runtime: { python: '>=99.0' } },
      }),
    )
    const [listener] = loadListeners({ workspaceRoot: root })
    expect(listener?.dependencies[0]?.state).toBe('mismatch')
    expect(listener?.ready).toBe(false)
  })

  it('flags a missing package with an install hint', () => {
    writeListener(
      'needs-pkg',
      manifestFor('needs-pkg', {
        runtime: { program: ['python'] },
        dependencies: { packages: [{ manager: 'pip', name: 'definitely-not-installed-pkg-xyz', range: '*' }] },
      }),
    )
    const [listener] = loadListeners({ workspaceRoot: root })
    const dep = listener?.dependencies.find((d) => d.kind === 'package')
    expect(dep?.state).toBe('missing')
    expect(dep?.installHint).toContain('pip install')
    expect(listener?.ready).toBe(false)
  })

  it('sorts listeners by display name', () => {
    writeListener('b', manifestFor('b', { name: 'Zed' }))
    writeListener('a', manifestFor('a', { name: 'Alpha' }))
    expect(loadListeners({ workspaceRoot: root, skipProbes: true }).map((l) => l.id)).toEqual(['a', 'b'])
  })
})

describe('listener state', () => {
  it('persists the enabled flag and config', () => {
    writeListener('x', manifestFor('x', { runtime: { program: ['python'] } }))
    setListenerEnabled(root, 'x', true)
    setListenerConfig(root, 'x', { email: 'me@qq.com' })

    const [listener] = loadListeners({ workspaceRoot: root, skipProbes: true })
    expect(listener?.enabled).toBe(true)
    expect(listener?.config).toEqual({ email: 'me@qq.com' })
  })

  it('reports missing required config keys', () => {
    writeListener(
      'needs-config',
      manifestFor('needs-config', {
        runtime: { program: ['python'] },
        config: { properties: { authCode: { type: 'string' } }, required: ['authCode'] },
      }),
    )
    let [listener] = loadListeners({ workspaceRoot: root, skipProbes: true })
    expect(missingConfigKeys(listener!)).toEqual(['authCode'])

    setListenerConfig(root, 'needs-config', { authCode: 'abc' })
    ;[listener] = loadListeners({ workspaceRoot: root, skipProbes: true })
    expect(missingConfigKeys(listener!)).toEqual([])
  })
})
