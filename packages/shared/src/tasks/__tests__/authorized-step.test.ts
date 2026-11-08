import { describe, expect, it } from 'bun:test'
import { isAuthorizedStep } from '../plan.ts'

/**
 * 「完成1.2后暂停」 was answered, `authorizedUpTo: "1.2"` was written, and dispatching 1.2 was
 * still refused with 「scope 只覆盖已交付的那一段」 — because the dispatch gate asked whether
 * `spec.scope` was set instead of whether the step was authorised. The plan writer and the
 * resume path already agreed; the gate was the one place with its own definition.
 */
describe('is this step inside what the person authorised', () => {
  it('allows a step at the ceiling', () => {
    expect(isAuthorizedStep('1.2', { authorizedUpTo: '1.2' })).toBe(true)
  })

  it('allows a step below the ceiling, planned or not', () => {
    expect(isAuthorizedStep('1.1', { authorizedUpTo: '1.2' })).toBe(true)
    expect(isAuthorizedStep('1', { authorizedUpTo: '1.2' })).toBe(true)
  })

  it('refuses a step past the ceiling', () => {
    expect(isAuthorizedStep('2', { authorizedUpTo: '1.2' })).toBe(false)
    expect(isAuthorizedStep('2.1', { authorizedUpTo: '1.2' })).toBe(false)
  })

  it('compares numerically, so 1.10 is past 1.2', () => {
    expect(isAuthorizedStep('1.10', { authorizedUpTo: '1.2' })).toBe(false)
    expect(isAuthorizedStep('1.3', { authorizedUpTo: '1.10' })).toBe(true)
  })

  it('honours an explicit list', () => {
    expect(isAuthorizedStep('1', { authorizedSteps: ['1', '1.1'] })).toBe(true)
    expect(isAuthorizedStep('1.2', { authorizedSteps: ['1', '1.1'] })).toBe(false)
  })

  it('treats a list as wide as the ceiling, not narrower', () => {
    // Both forms present: a step qualifies through either.
    expect(isAuthorizedStep('1.2', { authorizedSteps: ['1'], authorizedUpTo: '1.2' })).toBe(true)
  })

  it('authorises nothing when the task declares no boundary', () => {
    expect(isAuthorizedStep('1', undefined)).toBe(false)
    expect(isAuthorizedStep('1', {})).toBe(false)
  })
})
