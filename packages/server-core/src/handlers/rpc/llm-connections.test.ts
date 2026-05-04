import { describe, expect, it } from 'bun:test'
import { isMaskedCredential } from './llm-connections'

describe('isMaskedCredential', () => {
  it('detects masked API key placeholders from edit forms', () => {
    expect(isMaskedCredential('••••••••')).toBe(true)
    expect(isMaskedCredential('sk-test••••last')).toBe(true)
    expect(isMaskedCredential('********')).toBe(true)
  })

  it('allows real API key values', () => {
    expect(isMaskedCredential(undefined)).toBe(false)
    expect(isMaskedCredential('123456')).toBe(false)
    expect(isMaskedCredential('sk-local-test')).toBe(false)
  })
})
