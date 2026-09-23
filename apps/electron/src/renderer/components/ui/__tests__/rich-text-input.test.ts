import { describe, it, expect } from 'bun:test'
import {
  isEscapeDuringComposition,
  isCompositionInputEvent,
  syncCompositionFromKeydown,
} from '../rich-text-input'

describe('isEscapeDuringComposition', () => {
  it('returns true for Escape when local composition ref is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, true)).toBe(true)
  })

  it('returns true for Escape when nativeEvent.isComposing is true', () => {
    expect(
      isEscapeDuringComposition(
        { key: 'Escape', nativeEvent: { isComposing: true } },
        false
      )
    ).toBe(true)
  })

  it('returns true for Escape when event.isComposing is true', () => {
    expect(isEscapeDuringComposition({ key: 'Escape', isComposing: true }, false)).toBe(true)
  })

  it('returns false for Escape when no composition signal is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, false)).toBe(false)
  })

  it('returns false for non-Escape keys even if composing', () => {
    expect(isEscapeDuringComposition({ key: 'Enter', isComposing: true }, true)).toBe(false)
  })
})

describe('isCompositionInputEvent', () => {
  it('returns true when the local composition ref is active', () => {
    expect(isCompositionInputEvent(undefined, true)).toBe(true)
  })

  it('returns true when nativeEvent.isComposing is true but the ref lags', () => {
    // Windows TSF can set nativeEvent.isComposing before compositionstart fires,
    // so the ref is still false — the event flag must still suppress publication.
    expect(isCompositionInputEvent({ nativeEvent: { isComposing: true } }, false)).toBe(true)
  })

  it('returns true when the synthetic event carries isComposing', () => {
    expect(isCompositionInputEvent({ isComposing: true }, false)).toBe(true)
  })

  it('returns false when no composition signal is present', () => {
    expect(isCompositionInputEvent({ nativeEvent: {} }, false)).toBe(false)
    expect(isCompositionInputEvent(undefined, false)).toBe(false)
  })
})

describe('syncCompositionFromKeydown', () => {
  it('turns the ref on when the native keydown is composing (TSF first keystroke)', () => {
    // First composing keystroke: compositionstart may not have run yet.
    expect(syncCompositionFromKeydown({ nativeEvent: { isComposing: true } })).toBe(true)
  })

  it('turns the ref off when the native flag is cleared (compositionend may have dropped)', () => {
    expect(syncCompositionFromKeydown({ nativeEvent: { isComposing: false } })).toBe(false)
  })

  it('stays off for plain text keystrokes', () => {
    expect(syncCompositionFromKeydown({ nativeEvent: { isComposing: false } })).toBe(false)
  })

  it('is safe for events without a nativeEvent', () => {
    expect(syncCompositionFromKeydown({})).toBe(false)
  })
})
