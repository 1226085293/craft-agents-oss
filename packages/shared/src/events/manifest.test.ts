import { describe, it, expect } from 'bun:test'
import { parseManifest, satisfiesRange } from './manifest.ts'

function base(overrides: Record<string, unknown> = {}) {
  return {
    spec: 'craft-listener/1',
    id: 'qqmail-idle',
    name: 'QQ 邮箱',
    version: '1.2.0',
    eventTypes: ['mail.received'],
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
    expect(parseManifest(base({ eventTypes: ['Mail'] })).ok).toBe(false)
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
          runtime: { python: '>=3.9 <4' },
          packages: [{ manager: 'pip', name: 'requests' }, { manager: 'npm', name: 'ws', range: '^8' }],
          system: ['curl'],
        },
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.manifest?.dependencies?.packages?.[0]?.range).toBe('*')
    expect(result.manifest?.dependencies?.runtime?.python).toBe('>=3.9 <4')
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
