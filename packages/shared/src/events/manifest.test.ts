import { describe, it, expect } from 'bun:test'
import { parseManifest, satisfiesRange } from './manifest.ts'

function base(overrides: Record<string, unknown> = {}) {
  return {
    spec: 'craft-listener/1',
    id: 'qqmail-idle',
    name: 'QQ 邮箱',
    version: '1.2.0',
    ...overrides,
  }
}

describe('satisfiesRange', () => {
  it('handles the wildcard forms', () => {
    expect(satisfiesRange('3.11.4', '*')).toBe(true)
    expect(satisfiesRange('2.7.1', '2.*')).toBe(true)
    expect(satisfiesRange('3.7.1', '2.*')).toBe(false)
    expect(satisfiesRange('2.7.1', '2.6.*')).toBe(false)
  })

  it('handles caret ranges', () => {
    expect(satisfiesRange('1.2.3', '^1.2.3')).toBe(true)
    expect(satisfiesRange('1.9.0', '^1.2.3')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfiesRange('1.2.2', '^1.2.3')).toBe(false)
    // 0.x caret pins the minor
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true)
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false)
  })

  it('handles tilde ranges', () => {
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false)
  })

  it('handles comparison chains (space = AND) and || as OR', () => {
    expect(satisfiesRange('3.11.4', '>=3.9 <4')).toBe(true)
    expect(satisfiesRange('4.0.0', '>=3.9 <4')).toBe(false)
    expect(satisfiesRange('2.7.0', '2.* || >=3.9')).toBe(true)
    expect(satisfiesRange('1.0.0', '2.* || >=3.9')).toBe(false)
  })

  it('handles exact and rejects junk versions', () => {
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false)
    expect(satisfiesRange('not-a-version', '^1.0.0')).toBe(false)
    expect(satisfiesRange('1.0.0', '')).toBe(true)
  })
})

describe('parseManifest', () => {
  it('accepts a minimal manifest', () => {
    const result = parseManifest(base())
    expect(result.ok).toBe(true)
    expect(result.manifest?.id).toBe('qqmail-idle')
    expect(result.manifest?.spec).toBe('craft-listener/1')
  })

  it('rejects a wrong spec, missing fields and bad ids', () => {
    expect(parseManifest(base({ spec: 'v2' })).ok).toBe(false)
    expect(parseManifest(base({ id: undefined })).ok).toBe(false)
    expect(parseManifest(base({ id: 'Bad_Id' })).ok).toBe(false)
    expect(parseManifest(base({ name: '' })).ok).toBe(false)
    expect(parseManifest(base({ version: '1.2' })).ok).toBe(false)
  })

  it('checks the id against the directory name', () => {
    const result = parseManifest(base({ id: 'other' }), 'qqmail-idle')
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('does not match directory name')
  })

  it('rejects a single-string program (command injection shape)', () => {
    const result = parseManifest(base({ runtime: { program: ['python listener.py'] } }))
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('argv array')
  })

  it('keeps an argv program and restart policy', () => {
    const result = parseManifest(
      base({
        runtime: {
          program: ['python', '-u', '${dir}/listener.py'],
          readyTimeoutMs: 15000,
          restart: { policy: 'on-failure', maxAttempts: 3, backoffMs: [1000, 2000] },
        },
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.manifest?.runtime?.program).toEqual(['python', '-u', '${dir}/listener.py'])
    expect(result.manifest?.runtime?.restart?.maxAttempts).toBe(3)
  })

  it('parses dependencies, defaulting a missing range to *', () => {
    const result = parseManifest(
      base({
        dependencies: {
          packages: [{ manager: 'pip', name: 'requests' }, { manager: 'npm', name: '@scope/ws', range: '^8' }],
          mcp: [
            { id: 'mail-mcp', mode: 'managed', source: 'npm', package: 'mail-mcp', version: '^1.2.0' },
            { id: 'corp-remote', mode: 'remote', url: 'https://mcp.example.com/sse', auth: 'oauth' },
          ],
          system: ['curl'],
        },
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.manifest?.dependencies?.packages?.[0]?.range).toBe('*')
    expect(result.manifest?.dependencies?.mcp).toHaveLength(2)
    expect(result.manifest?.dependencies?.mcp?.[0]).toMatchObject({
      id: 'mail-mcp', mode: 'managed', source: 'npm', package: 'mail-mcp', version: '^1.2.0',
    })
    expect(result.manifest?.dependencies?.mcp?.[1]).toMatchObject({
      id: 'corp-remote', mode: 'remote', url: 'https://mcp.example.com/sse', auth: 'oauth',
    })
  })

  it('drops dependencies.runtime with a deprecation warning', () => {
    const result = parseManifest(
      base({ dependencies: { runtime: { python: '>=3.9' } } }),
    )
    expect(result.ok).toBe(true)
    expect(result.warnings.join()).toContain('dependencies.runtime is deprecated')
    expect((result.manifest?.dependencies as Record<string, unknown> | undefined)?.runtime).toBeUndefined()
  })

  it('validates package names and ranges against CLI-safe charsets', () => {
    const bad = parseManifest(
      base({
        dependencies: {
          packages: [
            { manager: 'pip', name: '-r /etc/passwd' },
            { manager: 'npm', name: 'ok', range: '>=1 --unsafe' },
          ],
        },
      }),
    )
    expect(bad.ok).toBe(false)
    expect(bad.errors.join()).toContain('forbidden characters')

    const good = parseManifest(
      base({
        dependencies: {
          packages: [
            { manager: 'pip', name: 'requests', range: '>=2.0, <3' },
            { manager: 'npm', name: '@scope/ws', range: '^8 || ^9' },
          ],
        },
      }),
    )
    expect(good.ok).toBe(true)
  })

  it('validates mcp dependency fields', () => {
    const base_mcp = { id: 'mail-mcp', mode: 'managed', source: 'npm', package: 'mail-mcp' }
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base_mcp, id: 'BAD ID' }, 'id'],
      [{ ...base_mcp, mode: 'sideload' }, 'mode'],
      [{ ...base_mcp, source: 'apt' }, 'source'],
      [{ ...base_mcp, package: '--target /tmp' }, 'package'],
      [{ ...base_mcp, version: '1.0; rm' }, 'version'],
      [{ id: 'x1', mode: 'remote', url: 'ftp://nope' }, 'url'],
      [{ id: 'mail-mcp', mode: 'managed', source: 'npm' }, 'package'],
    ]
    for (const [dep, needle] of cases) {
      const result = parseManifest(base({ dependencies: { mcp: [dep] } }))
      expect(result.ok, JSON.stringify(dep)).toBe(false)
      expect(result.errors.join(), JSON.stringify(dep)).toContain(needle)
    }
    // Duplicate ids are rejected too.
    const dup = parseManifest(
      base({ dependencies: { mcp: [base_mcp, { ...base_mcp, mode: 'remote', url: 'https://a.b/c' }] } }),
    )
    expect(dup.errors.join()).toContain('duplicated')
  })

  it('rejects an unknown package manager', () => {
    const result = parseManifest(
      base({ dependencies: { packages: [{ manager: 'apt', name: 'x' }] } }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('pip')
  })

  it('warns (not errors) when there is no runtime', () => {
    const result = parseManifest(base())
    expect(result.ok).toBe(true)
    expect(result.warnings.join()).toContain('no runtime.program')
  })

  it('parses config schema and setup steps', () => {
    const result = parseManifest(
      base({
        config: {
          properties: {
            authCode: { type: 'string', title: '授权码', secret: true },
            host: { type: 'string', default: 'imap.qq.com' },
          },
          required: ['authCode'],
        },
        setup: [{ text: '开启 IMAP/SMTP', link: 'https://service.mail.qq.com/detail/0/1087' }],
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.manifest?.config?.properties.authCode?.secret).toBe(true)
    expect(result.manifest?.setup?.[0]?.link).toContain('service.mail.qq.com')
  })
})
