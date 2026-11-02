import { describe, it, expect } from 'bun:test'
import {
  isEscapeDuringComposition,
  isCompositionInputEvent,
  syncCompositionFromKeydown,
  isImeCompositionPaste,
  needsTsfRepair,
  parseAttachmentClipboardPayload,
  serializeAttachmentClipboardPayload,
} from '../rich-text-input'
import type { FileAttachment } from '../../../../shared/types'

const reportAttachment: FileAttachment = {
  type: 'text',
  path: 'report.md',
  name: 'report.md',
  mimeType: 'text/markdown',
  text: '# report',
  size: 8,
}

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

describe('isImeCompositionPaste', () => {
  it('returns true while the local composition ref is active', () => {
    // The clipboard path is how some Windows IMEs commit candidate text;
    // intercepting it would duplicate the committed characters.
    expect(isImeCompositionPaste(undefined, true)).toBe(true)
  })

  it('returns true when nativeEvent.isComposing is true', () => {
    expect(
      isImeCompositionPaste({ nativeEvent: { isComposing: true } }, false)
    ).toBe(true)
  })

  it('returns true when the synthetic event carries isComposing', () => {
    expect(isImeCompositionPaste({ isComposing: true }, false)).toBe(true)
  })

  it('returns false for a normal clipboard paste', () => {
    expect(isImeCompositionPaste({ nativeEvent: { isComposing: false } }, false)).toBe(false)
    expect(isImeCompositionPaste(undefined, false)).toBe(false)
  })
})

describe('needsTsfRepair', () => {
  it('repairs when the element holds text and no composition is live', () => {
    expect(needsTsfRepair({ hasExistingText: true, isComposing: false })).toBe(true)
  })
  it('skips empty elements - they are not affected by the TSF first-focus bug', () => {
    expect(needsTsfRepair({ hasExistingText: false, isComposing: false })).toBe(false)
  })

  it('never runs mid-composition', () => {
    expect(needsTsfRepair({ hasExistingText: true, isComposing: true })).toBe(false)
  })
})

describe('attachment clipboard payload', () => {
  it('round-trips the text model and the attachment payloads', () => {
    const text = 'see [attachment:report.md] please'
    const parsed = parseAttachmentClipboardPayload(
      serializeAttachmentClipboardPayload(text, [reportAttachment])
    )

    expect(parsed).not.toBeNull()
    expect(parsed?.text).toBe(text)
    expect(parsed?.attachments).toHaveLength(1)
    // The bytes matter: a tag alone is dead in another conversation.
    expect(parsed?.attachments[0].text).toBe('# report')
    expect(parsed?.attachments[0].name).toBe('report.md')
  })

  it('rejects payloads without usable attachments', () => {
    expect(parseAttachmentClipboardPayload('')).toBeNull()
    expect(parseAttachmentClipboardPayload('not json')).toBeNull()
    expect(parseAttachmentClipboardPayload(JSON.stringify({ text: 'x' }))).toBeNull()
    expect(
      parseAttachmentClipboardPayload(JSON.stringify({ text: 'x', attachments: [{ nope: true }] }))
    ).toBeNull()
  })

  it('drops malformed entries but keeps the valid ones', () => {
    const parsed = parseAttachmentClipboardPayload(
      JSON.stringify({ text: 'x', attachments: [{ nope: true }, reportAttachment] })
    )

    expect(parsed?.attachments).toHaveLength(1)
    expect(parsed?.attachments[0].name).toBe('report.md')
  })
})
