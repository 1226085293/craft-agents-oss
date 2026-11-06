import { describe, it, expect } from 'bun:test'
import {
  pluginStatusReading,
  missingRequiredConfigValues,
  configSectionInitiallyOpen,
  sanitizePluginConfigUpdate,
  type PluginStatusInput,
  type ListenerConfigSchemaLike,
} from './plugin-status.ts'

const running = { state: 'running', lastError: null } as const
const stopped = { state: 'stopped', lastError: null } as const

function input(overrides: Partial<PluginStatusInput> = {}): PluginStatusInput {
  return {
    enabled: true,
    status: stopped,
    errors: [],
    missingConfig: [],
    dependencies: [],
    ...overrides,
  }
}

describe('pluginStatusReading', () => {
  it('reads green when enabled and running', () => {
    const reading = pluginStatusReading(input({ status: running }))
    expect(reading.tone).toBe('ok')
    expect(reading.label).toBe('运行中')
  })

  it('reads gray when the user switched the plugin off — even if it last failed', () => {
    const failed = { state: 'failed', lastError: 'exit 1' } as const
    expect(pluginStatusReading(input({ enabled: false, status: failed })).tone).toBe('off')
    expect(pluginStatusReading(input({ enabled: false, status: running })).reason).toBe('disabled')
  })

  it('reads red for a manifest/config error', () => {
    const reading = pluginStatusReading(input({ errors: ['manifest.json is missing'] }))
    expect(reading.tone).toBe('bad')
    expect(reading.reason).toBe('config-error')
    expect(reading.label).toContain('manifest.json is missing')
  })

  it('reads red when the process gave up after its retry budget', () => {
    const failed = { state: 'failed', lastError: 'Traceback (most recent call last)' } as const
    const reading = pluginStatusReading(input({ status: failed }))
    expect(reading.tone).toBe('bad')
    expect(reading.reason).toBe('failed')
    expect(reading.label).toContain('Traceback')
  })

  it('reads red while a required config value is still blank', () => {
    const reading = pluginStatusReading(input({ missingConfig: ['email', 'authCode'] }))
    expect(reading.tone).toBe('bad')
    expect(reading.label).toBe('还缺 2 项必选配置')
  })

  it('reads red when a probed dependency is missing or mismatched', () => {
    const deps = [
      { state: 'ok' as const },
      { state: 'not_required' as const },
      { state: 'unknown' as const },
      { state: 'missing' as const },
      { state: 'mismatch' as const },
    ]
    expect(pluginStatusReading(input({ dependencies: deps })).tone).toBe('bad')
    // ok / not_required / unknown are not blocking: they must not light red.
    const soft = [{ state: 'ok' as const }, { state: 'not_required' as const }, { state: 'unknown' as const }]
    expect(pluginStatusReading(input({ dependencies: soft, status: running })).tone).toBe('ok')
  })

  it('reads amber while starting', () => {
    expect(pluginStatusReading(input({ status: { state: 'starting', lastError: null } })).tone).toBe('warn')
  })

  it('reads amber when up but unresponsive', () => {
    expect(pluginStatusReading(input({ status: { state: 'degraded', lastError: null } })).tone).toBe('warn')
  })

  it('reads amber when enabled yet not running — and works without dependency facts (list view)', () => {
    const reading = pluginStatusReading({
      enabled: true,
      status: stopped,
      errors: [],
      missingConfig: [],
    })
    expect(reading.tone).toBe('warn')
    expect(reading.reason).toBe('stopped')
  })

  it('prioritises hard failures over soft ones: failed + missing config stays red/failed', () => {
    const failed = { state: 'failed', lastError: 'connection refused' } as const
    const reading = pluginStatusReading(input({ status: failed, missingConfig: ['email'] }))
    expect(reading.reason).toBe('failed')
  })

  it('prioritises manifest errors over a failed process', () => {
    const failed = { state: 'failed', lastError: 'exit 1' } as const
    expect(pluginStatusReading(input({ status: failed, errors: ['manifest.json is not valid JSON'] })).reason).toBe('config-error')
  })
})

describe('missingRequiredConfigValues', () => {
  const schema: ListenerConfigSchemaLike = {
    properties: {
      email: { type: 'string' },
      limit: { type: 'number' },
      verbose: { type: 'boolean' },
    },
    required: ['email', 'limit'],
  }

  it('treats undefined, null and blank strings as missing', () => {
    expect(missingRequiredConfigValues(schema, { email: '', limit: 3 })).toEqual(['email'])
    expect(missingRequiredConfigValues(schema, {})).toEqual(['email', 'limit'])
    expect(missingRequiredConfigValues(schema, { email: 'a@b.c', limit: 0 })).toEqual([])
    // 0 is a filled value: only empty strings count as blank.
    expect(missingRequiredConfigValues(schema, { email: '  ', limit: 0 })).toEqual(['email'])
  })

  it('reports nothing when there is no schema or no required keys', () => {
    expect(missingRequiredConfigValues(undefined, {})).toEqual([])
    expect(missingRequiredConfigValues({ properties: {} }, {})).toEqual([])
  })
})

describe('configSectionInitiallyOpen', () => {
  const schema = { required: ['token'] }

  it('opens by default when a required value is still blank', () => {
    expect(configSectionInitiallyOpen(schema, {})).toBe(true)
    expect(configSectionInitiallyOpen(schema, { token: '' })).toBe(true)
  })

  it('stays collapsed when every required value is filled', () => {
    expect(configSectionInitiallyOpen(schema, { token: 'abc' })).toBe(false)
    expect(configSectionInitiallyOpen(undefined, {})).toBe(false)
  })
})

describe('sanitizePluginConfigUpdate', () => {
  const schema: ListenerConfigSchemaLike = {
    properties: {
      email: { type: 'string' },
      limit: { type: 'number' },
      verbose: { type: 'boolean' },
    },
    required: ['email'],
  }

  it('coerces values to the declared types', () => {
    const clean = sanitizePluginConfigUpdate(
      { email: 'a@b.c', limit: 42, verbose: true, junk: { nested: true } },
      schema,
    )
    expect(clean).toEqual({ email: 'a@b.c', limit: 42, verbose: true })
  })

  it('drops non-finite numbers and coerces boolean-ish strings', () => {
    const clean = sanitizePluginConfigUpdate(
      { limit: 'abc', verbose: 'false' },
      schema,
    )
    expect(clean).toEqual({ verbose: false })
  })

  it('coerces primitives to strings for string fields', () => {
    expect(sanitizePluginConfigUpdate({ email: 7 }, schema)).toEqual({ email: '7' })
  })

  it('rejects unknown keys when the schema declares properties', () => {
    expect(sanitizePluginConfigUpdate({ email: 'a@b.c', rogue: 'x' }, schema)).toEqual({
      email: 'a@b.c',
    })
  })

  it('accepts primitive unknown keys when the schema declares none', () => {
    const clean = sanitizePluginConfigUpdate({ anything: 1, nested: { a: 1 } }, undefined)
    expect(clean).toEqual({ anything: 1 })
  })

  it('never passes objects or arrays through', () => {
    expect(sanitizePluginConfigUpdate({ evil: { cmd: 'rm' }, list: ['a'] }, schema)).toEqual({})
    expect(sanitizePluginConfigUpdate('not an object', schema)).toEqual({})
  })
})
