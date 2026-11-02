import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { coerceInputText } from '@/lib/input-text'
import { cn } from '@/lib/utils'
import { findMentionMatches, parseMentions, type MentionMatch } from '@/lib/mentions'
import {
  attachmentTokenKey,
  findAttachmentTokens,
  formatAttachmentToken,
  hasAttachmentToken,
  resolveAttachmentTokens,
} from '@/lib/attachment-tokens'
import {
  loadSourceIcon,
  loadSkillIcon,
  getSourceIconSync,
  getSkillIconSync,
  EMOJI_ICON_PREFIX,
} from '@/lib/icon-cache'
import type { FileAttachment, LoadedSkill, LoadedSource } from '../../../shared/types'
import type { MentionItemType } from './mention-menu'

// ============================================================================
// Types
// ============================================================================

/** Line count threshold for auto-converting pasted text to file attachment */
const LONG_TEXT_LINE_THRESHOLD = 100

/** Upper bound on stored undo steps (text + caret snapshots are tiny). */
const HISTORY_LIMIT = 200

/**
 * Clipboard MIME carrying attachment payloads next to the text model.
 *
 * Copying a chip must move the *attachment*, not just its `[attachment:…]`
 * tag: the tag only resolves against the source composer's staged list, so it
 * went dead as soon as it was pasted into another conversation. Unknown MIMEs
 * are ignored by other apps, which still receive the plain-text tokens and the
 * real files below.
 */
const ATTACHMENT_CLIPBOARD_MIME = 'application/x-craft-attachments'

/**
 * Rebuild a clipboard `File` from a staged attachment (best effort).
 *
 * Lets a chip copied in one conversation be pasted into Explorer/Word (or any
 * other app) as the underlying file, not as a tag.
 */
function fileAttachmentToFile(attachment: FileAttachment): File | null {
  const type = attachment.mimeType || 'application/octet-stream'
  try {
    if (typeof attachment.text === 'string' && attachment.text.length > 0) {
      return new File([attachment.text], attachment.name, { type })
    }
    if (attachment.base64) {
      const binary = atob(attachment.base64.replace(/^data:[^;]+;base64,/, ''))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return new File([bytes], attachment.name, { type })
    }
  } catch {
    return null
  }
  return null
}

/** Serialize the clipboard payload written by copy/cut (text model + payloads). */
export function serializeAttachmentClipboardPayload(text: string, attachments: FileAttachment[]): string {
  return JSON.stringify({ text, attachments })
}

/** Parse a clipboard payload written by the copy/cut handlers. */
export function parseAttachmentClipboardPayload(
  raw: string
): { text: string; attachments: FileAttachment[] } | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { text, attachments } = parsed as { text?: unknown; attachments?: unknown }
    if (typeof text !== 'string' || !Array.isArray(attachments)) return null
    const valid = attachments.filter((candidate): candidate is FileAttachment => {
      if (!candidate || typeof candidate !== 'object') return false
      const attachment = candidate as Partial<FileAttachment>
      return typeof attachment.name === 'string' && typeof attachment.type === 'string'
    })
    return valid.length > 0 ? { text, attachments: valid } : null
  } catch {
    return null
  }
}

/** One undo step: the text model and the caret offset it was edited at. */
interface HistoryEntry {
  text: string
  cursor: number
}

/**
 * Display data for one inline attachment chip.
 *
 * Deliberately narrow: the composer only needs an icon, a tooltip and the name
 * that keys the inline token. Bytes stay in the parent's `FileAttachment`.
 */
export interface RichTextAttachmentChip {
  name: string
  type: FileAttachment['type']
  mimeType?: string
}

/** Where a chip sits on screen, reported on hover so the parent can place a card. */
export interface AttachmentChipRect {
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

export interface EscapeCompositionEventLike {
  key?: string
  isComposing?: boolean
  nativeEvent?: {
    isComposing?: boolean
  }
}

/**
 * Returns true when Escape is pressed while IME composition is active.
 *
 * Uses both local composition state and event-level composing flags for
 * browser/runtime compatibility.
 */
export function isEscapeDuringComposition(
  event: EscapeCompositionEventLike,
  isComposingRefActive: boolean
): boolean {
  if (event.key !== 'Escape') return false
  return Boolean(isComposingRefActive || event.isComposing || event.nativeEvent?.isComposing)
}

/**
 * Loose event shape accepted by `isCompositionInputEvent`. Deliberately avoids
 * relying on React's `FormEvent.nativeEvent` typing (plain `Event`, which has
 * no `isComposing` member on all platforms/runtimes).
 */
export interface CompositionInputEventLike {
  isComposing?: unknown
  nativeEvent?: unknown
}

/**
 * Returns true when an input event is part of an active IME composition.
 *
 * Uses both the local composition ref and the event's own flags. The native
 * flag matters because Windows TSF (CJK IMEs) can dispatch the composition's
 * first `input` event with `nativeEvent.isComposing === true` *before* our
 * `compositionstart` handler runs, so the local ref may still be false.
 * Publishing pre-edit text in that window triggers a DOM rewrite that kills
 * the composition (fixes the "Nn俄好" / "Zz" input corruption).
 */
export function isCompositionInputEvent(
  event: CompositionInputEventLike | undefined,
  isComposingRefActive: boolean
): boolean {
  if (isComposingRefActive) return true
  if (!event) return false
  if (event.isComposing === true) return true
  const native = event.nativeEvent
  if (native && typeof native === 'object' && 'isComposing' in native) {
    return (native as { isComposing?: boolean }).isComposing === true
  }
  return false
}

/**
 * Loose event shape accepted by `syncCompositionFromKeydown`. Only the native
 * `isComposing` flag is consulted.
 */
export interface CompositionKeydownEventLike {
  nativeEvent?: {
    isComposing?: boolean
  }
}

/**
 * Steer local composition state from the *native* keydown signal so it stays in
 * sync even when React's compositionstart/compositionend events lag or drop:
 * Windows TSF can flag the first composing keystroke before compositionstart
 * runs, and can clear the flag before compositionend.
 *
 * Returns the new value for the local composition ref. Clearing is safe
 * because the publication gates (`isCompositionInputEvent`) still consult the
 * native flag themselves, so pre-edit text can never slip through a cleared
 * ref. Never reads the DOM and never publishes — the trailing `input` event
 * still drives syncing.
 */
export function syncCompositionFromKeydown(event: CompositionKeydownEventLike): boolean {
  return event.nativeEvent?.isComposing === true
}

/**
 * Loose event shape accepted by `isImeCompositionPaste`. Clipboard events do
 * not always carry the composition flag, so the local ref is the primary
 * signal and the event flags are a secondary check.
 */
export interface CompositionPasteEventLike {
  isComposing?: unknown
  nativeEvent?: unknown
}

/**
 * True when a paste event belongs to a live IME composition.
 *
 * Windows IMEs (Microsoft Pinyin's compatibility mode in particular) can
 * commit candidate text through the clipboard path. Intercepting that with
 * `preventDefault()` + `execCommand('insertText')` stacks a second insertion on
 * top of what the IME already committed, which is exactly the "first input
 * duplicated / IME never took over" corruption. When this returns true the
 * caller must leave the event completely alone and let the browser apply the
 * IME's own insertion.
 */
export function isImeCompositionPaste(
  event: CompositionPasteEventLike | undefined,
  isComposingRefActive: boolean
): boolean {
  if (isComposingRefActive) return true
  const nativeEvent = event?.nativeEvent as { isComposing?: unknown } | undefined
  if (nativeEvent?.isComposing === true) return true
  return event?.isComposing === true
}

/**
 * Windows TSF / IME recovery.
 *
 * On Windows, the first focus of a text element that already holds content can
 * leave the system's TSF/IME context broken: CJK input stops producing a
 * candidate window and keystrokes land as raw ASCII letters until focus moves
 * to a *different* text element and back. This matches the user-visible "first
 * input after a session switch never triggers the IME" corruption.
 *
 * The recovery is a focus detour through a dedicated empty <textarea> (which
 * re-primes TSF against an element whose text/selection is trivially
 * synchronizable), then a refocus on the target. All calls run in one task, so
 * React batches the focus/blur callbacks and the caret never visibly moves.
 */
let tsfPrimingElement: HTMLTextAreaElement | null = null

function getTsfPrimingElement(): HTMLTextAreaElement {
  if (tsfPrimingElement && document.body.contains(tsfPrimingElement)) return tsfPrimingElement
  const ta = document.createElement('textarea')
  ta.setAttribute('aria-hidden', 'true')
  // Marker so UI layers (e.g. Radix popovers) can recognize this element's
  // transient focus as an internal TSF repair detour rather than a real
  // focus-outside interaction.
  ta.setAttribute('data-craft-tsf-priming', '')
  ta.tabIndex = -1
  Object.assign(ta.style, {
    position: 'fixed',
    left: '-9999px',
    top: '0',
    width: '0',
    height: '0',
    opacity: '0',
    padding: '0',
    border: 'none',
    resize: 'none',
    pointerEvents: 'none',
  })
  document.body.appendChild(ta)
  tsfPrimingElement = ta
  return ta
}

/**
 * Pure decision: should the focus-rewrite path run the TSF recovery cycle?
 *
 * Only elements that hold existing text are at risk (empty elements are
 * unaffected — their focus has nothing to synchronize against, which is
 * exactly why "empty inputs work" in the documented repro). A live
 * composition must never be touched — the cycle would abort the IME.
 */
export function needsTsfRepair(input: { hasExistingText: boolean; isComposing: boolean }): boolean {
  return input.hasExistingText && !input.isComposing
}

export function runTsfRecoveryCycle(el: HTMLElement): void {
  const priming = getTsfPrimingElement()
  el.blur()
  priming.focus()
  priming.blur()
  el.focus()
}

export interface RichTextInputProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'onInput' | 'onPaste'> {
  /** Current text value */
  value: string
  /** Called when text changes */
  onChange: (value: string) => void
  /** Placeholder text(s) when empty - can be a single string or array for rotation */
  placeholder?: string | string[]
  /** Available skills for mention parsing */
  skills?: LoadedSkill[]
  /** Available sources for mention parsing */
  sources?: LoadedSource[]
  /** Workspace ID for avatars */
  workspaceId?: string
  /** Whether the input is disabled */
  disabled?: boolean
  /** Called when input changes (provides value and cursor position for mention detection) */
  onInput?: (value: string, cursorPosition: number) => void
  /** Called on paste */
  onPaste?: (e: React.ClipboardEvent) => void
  /** Called when pasted text exceeds line threshold - should create file attachment */
  onLongTextPaste?: (text: string) => void
  /**
   * Staged attachments. Their inline tokens in `value` render as atomic chips,
   * ~one character wide, at exactly the position the user dropped them.
   */
  attachments?: RichTextAttachmentChip[]
  /** Hover over a chip (token text + viewport rect), for a preview card. */
  onAttachmentHover?: (token: string, rect: AttachmentChipRect) => void
  /** Pointer left the chip. */
  onAttachmentLeave?: () => void
  /** Double-click / Enter on a chip - open the attachment preview. */
  onAttachmentActivate?: (token: string) => void
  /**
   * Resolve the staged attachment behind a chip (by its token text) so
   * copy/cut put the attachment itself on the clipboard instead of only its
   * inline tag. This is what makes Ctrl+C / Ctrl+X on a chip survive a paste
   * into a different conversation.
   */
  getAttachmentClipboardPayload?: (tokenText: string) => FileAttachment | null
  /** Stage attachments that arrived on the clipboard from another composer. */
  onPasteAttachments?: (attachments: FileAttachment[]) => void
}

export interface RichTextInputHandle {
  focus: () => void
  blur: () => void
  /** The text value */
  value: string
  /** Selection start position in text model */
  selectionStart: number
  /** Set the text value */
  setValue: (value: string) => void
  /** Set selection range */
  setSelectionRange: (start: number, end: number) => void
  /** Get bounding rect for position calculations */
  getBoundingClientRect: () => DOMRect
  /** Get bounding rect of the current caret/selection position */
  getCaretRect: () => DOMRect | null
  /** The underlying div element */
  element: HTMLDivElement | null
  /**
   * Insert an attachment chip at the caret (or append it when the caret is
   * outside the input). The chip behaves like a single character from then on.
   * Returns false when the composer is not editable right now (disabled or not
   * mounted), so the caller can fall back to appending the token itself.
   */
  insertAttachment: (attachment: RichTextAttachmentChip) => boolean
}

// ============================================================================
// InlineMentionBadge - Compact badge for inline display (static HTML version)
// ============================================================================

// SVG icons as HTML strings (avoiding react-dom/server which doesn't work in browser)
const SKILL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`

const SOURCE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`

// File icon (document with folded corner) - matches UserMessageBubble style (12x12, text-muted-foreground)
const FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M9 16H15M9 12H10M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/></svg>`

// Code file icon (document with < > brackets) - matches UserMessageBubble style (12x12, text-muted-foreground)
const CODE_FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M10.5 12.8799C9.70024 13.2985 9.10807 13.8275 8.64232 14.5478C8.51063 14.7515 8.44479 14.8533 8.44489 15.0011C8.44498 15.1488 8.51099 15.2506 8.643 15.4542C9.1095 16.1736 9.70167 16.7028 10.5 17.1225M13.5 12.8799C14.2998 13.2985 14.8919 13.8275 15.3577 14.5478C15.4894 14.7515 15.5552 14.8533 15.5551 15.0011C15.555 15.1488 15.489 15.2506 15.357 15.4542C14.8905 16.1736 14.2983 16.7028 13.5 17.1225M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/></svg>`

// Folder icon (open folder) - matches UserMessageBubble style (12x12, text-muted-foreground)
const FOLDER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M20.5 10C20.5 9.07003 20.5 8.60504 20.3978 8.22354C20.1204 7.18827 19.3117 6.37962 18.2765 6.10222C17.895 6 17.43 6 16.5 6H13.1008C12.4742 6 12.1609 6 11.8739 5.91181C11.6824 5.85298 11.5009 5.76572 11.3353 5.65295C11.0871 5.48389 10.8914 5.23926 10.5 4.75L10.4095 4.63693C10.107 4.25881 9.9558 4.06975 9.7736 3.92674C9.54464 3.74703 9.27921 3.61946 8.99585 3.55294C8.77037 3.5 8.52825 3.5 8.04402 3.5C6.60485 3.5 5.88527 3.5 5.32008 3.74178C4.61056 4.0453 4.0453 4.61056 3.74178 5.32008C3.5 5.88527 3.5 6.60485 3.5 8.04402V10M9.46502 20.5H14.535C16.9102 20.5 18.0978 20.5 18.9301 19.8113C19.7624 19.1226 19.9846 17.9559 20.429 15.6227L20.8217 13.5613C21.1358 11.9121 21.2929 11.0874 20.843 10.5437C20.393 10 19.5536 10 17.8746 10H6.12537C4.44643 10 3.60696 10 3.15704 10.5437C2.70713 11.0874 2.8642 11.9121 3.17835 13.5613L3.57099 15.6227C4.01541 17.9559 4.23763 19.1226 5.06992 19.8113C5.90221 20.5 7.08981 20.5 9.46502 20.5Z"/></svg>`

/** Known code file extensions - used to pick code file icon vs generic file icon */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'rb', 'swift', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sh', 'bash', 'zsh', 'fish',
  'md', 'mdx',
  'sql', 'graphql', 'proto',
])

function isCodeFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext ? CODE_EXTENSIONS.has(ext) : false
}

function renderBadgeHTML(
  type: MentionItemType,
  label: string,
  skill?: LoadedSkill,
  source?: LoadedSource,
  workspaceId?: string,
  tooltip?: string
): string {
  // Try to get cached icon first
  let iconHtml = ''
  let cachedIconUrl: string | null = null

  if (type === 'skill' && skill && workspaceId) {
    cachedIconUrl = getSkillIconSync(workspaceId, skill.slug)
  } else if (type === 'source' && source && workspaceId) {
    cachedIconUrl = getSourceIconSync(workspaceId, source.config.slug)
  }

  if (cachedIconUrl) {
    // Check for emoji marker - render as text, not image
    if (cachedIconUrl.startsWith(EMOJI_ICON_PREFIX)) {
      const emoji = cachedIconUrl.slice(EMOJI_ICON_PREFIX.length)
      iconHtml = `<span class="h-[12px] w-[12px] flex items-center justify-center text-[10px] leading-none shrink-0">${emoji}</span>`
    } else {
      // Use cached icon as img (data URL or external URL)
      iconHtml = `<img src="${cachedIconUrl}" class="h-[12px] w-[12px] rounded-[2px] shrink-0" alt="" />`
    }
  } else {
    // Fall back to generic SVG icon based on type
    if (type === 'skill') {
      iconHtml = `<span class="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0">${SKILL_ICON_SVG}</span>`
    } else if (type === 'source') {
      iconHtml = `<span class="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0">${SOURCE_ICON_SVG}</span>`
    } else if (type === 'file') {
      // Pick code file or generic file icon based on extension (no container, icon carries its own classes)
      iconHtml = isCodeFile(label) ? CODE_FILE_ICON_SVG : FILE_ICON_SVG
    } else if (type === 'folder') {
      iconHtml = FOLDER_ICON_SVG
    }
  }

  const escapedLabel = label.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const titleAttr = tooltip ? ` title="${tooltip.replace(/"/g, '&quot;')}"` : ''

  // Line height is increased when badges are present (see hasMentions in component)
  // Use transform for upward shift - doesn't affect layout flow (works even at start of line)
  return `<span contenteditable="false" data-mention="true"${titleAttr} class="mention-badge inline-flex items-center gap-1 h-[22px] px-1.5 mx-1 rounded-[5px] bg-background shadow-minimal text-[12px] text-foreground select-none [&_*]:selection:bg-transparent selection:bg-transparent" style="vertical-align: middle; transform: translateY(-1px)">${iconHtml}<span class="truncate max-w-[200px]">${escapedLabel}</span></span>`
}

// ============================================================================
// Inline attachment chip
// ============================================================================

// 12x12 image glyph
const IMAGE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.35-4.35a2 2 0 0 0-2.83 0L4 21"/></svg>`

// 12x12 text glyph (lines) - "readable text", code included
const TEXT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="shrink-0 text-muted-foreground"><path d="M4 6h16M4 12h16M4 18h9"/></svg>`

/** Extensions treated as "readable text" (same bucket as `type: 'text'`). */
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'log', 'csv', 'tsv', 'tex',
  ...CODE_EXTENSIONS,
])

function isTextAttachment(attachment: RichTextAttachmentChip): boolean {
  if (attachment.type === 'text') return true
  if (attachment.mimeType?.startsWith('text/')) return true
  const ext = attachment.name.split('.').pop()?.toLowerCase()
  return ext ? TEXT_EXTENSIONS.has(ext) : false
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render one attachment as an atomic inline chip.
 *
 * Shape is fixed: a long pill of constant width, icon on the left, file name on
 * the right with an ellipsis when it does not fit. Keeping the width fixed
 * means a row of chips lines up and the caret never reflows while typing.
 *
 * `contenteditable="false"` is what makes the chip behave like a single unit:
 * the caret hops over it, Backspace/Delete remove it whole and shift-selection
 * expands across it in one step. The token is carried in `data-attachment-text`
 * so the text model can be rebuilt from the DOM without knowing anything about
 * the attachment itself.
 */
export function renderAttachmentChipHTML(attachment: RichTextAttachmentChip, token: string): string {
  // Three icon buckets, matching the three kinds users think in:
  // image / readable text (code included) / everything else.
  const icon = attachment.type === 'image'
    ? IMAGE_ICON_SVG
    : isTextAttachment(attachment)
      ? TEXT_ICON_SVG
      : FILE_ICON_SVG
  const title = escapeAttr(attachment.name || '')
  const tokenAttr = escapeAttr(token)
  const label = escapeAttr(attachment.name || '')

  // The trailing zero-width space lives INSIDE the chip on purpose: it gives
  // Chromium a text node to anchor the caret to right after the chip, without
  // creating an extra editable caret stop. A ZWS as a sibling text node would
  // make "caret right of the chip → press Left" take two presses instead of one.
  return `<span contenteditable="false" data-attachment="true" data-attachment-text="${tokenAttr}" title="${title}" class="attachment-chip inline-flex items-center gap-1 h-[1.45em] w-[132px] shrink-0 mx-0.5 px-1.5 rounded-full bg-foreground/8 text-[11px] leading-none text-foreground/80 align-middle overflow-hidden select-none [&_*]:selection:bg-transparent selection:bg-transparent" style="vertical-align: -0.2em">${icon}<span class="min-w-0 flex-1 truncate text-left">${label}</span>\u200B</span>`
}

// ============================================================================
// Helper: Extract plain text from contenteditable
// ============================================================================

function getTextFromElement(element: HTMLElement): string {
  let text = ''

  // isTopLevel: true for direct children of the contenteditable root
  function processNode(node: Node, isTopLevel: boolean = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Filter out zero-width spaces (used for contenteditable cursor fix)
      text += (node.textContent || '').replace(/\u200B/g, '')
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement

      // Skip mention badges - they shouldn't contribute additional text
      if (el.getAttribute('data-mention') === 'true') {
        // Get the mention text from data attribute
        const mentionText = el.getAttribute('data-mention-text')
        if (mentionText) {
          text += mentionText
        }
        return // Don't process children
      }

      // Inline attachment chips serialize back to their token
      if (el.getAttribute('data-attachment') === 'true') {
        const attachmentText = el.getAttribute('data-attachment-text')
        if (attachmentText) text += attachmentText
        return // Don't process children
      }

      // Handle line breaks
      if (el.tagName === 'BR') {
        text += '\n'
      } else if (el.tagName === 'DIV' && text.length > 0 && !text.endsWith('\n')) {
        // DIVs in contenteditable normally represent line breaks.
        // HOWEVER: When typing before a badge at position 0, browsers wrap the
        // typed character in a <div>, creating: <div>typed</div><span badge>
        // This is NOT a user-intended line break - it's browser behavior.
        // We detect this by checking if a top-level DIV is immediately followed
        // by a mention badge sibling. If so, skip adding the newline.
        if (isTopLevel) {
          // Check if this DIV is followed by a mention badge at top level.
          // Skip over ZWS-only text nodes - browser may preserve them between
          // the DIV wrapper and the badge span.
          let nextSibling: Node | null = el.nextSibling
          while (
            nextSibling?.nodeType === Node.TEXT_NODE &&
            nextSibling.textContent?.replace(/\u200B/g, '') === ''
          ) {
            nextSibling = nextSibling.nextSibling
          }
          const isBrowserWrapper =
            (nextSibling as HTMLElement)?.getAttribute?.('data-mention') === 'true'
          if (!isBrowserWrapper) {
            text += '\n'
          }
          // If it IS followed by a badge, don't add newline - just process children
        } else {
          // Nested DIVs are always treated as line breaks
          text += '\n'
        }
      }

      // Process children (no longer top-level)
      Array.from(el.childNodes).forEach(child => {
        processNode(child, false)
      })
    }
  }

  // Process direct children as top-level nodes
  Array.from(element.childNodes).forEach(child => {
    processNode(child, true)
  })

  return text
}

/**
 * Find the attachment chip immediately before/after a collapsed caret.
 *
 * Zero-width spaces are DOM-only artifacts that sit right next to a chip, so
 * they are skipped: without that the caret practically never looks adjacent to
 * the chip and Backspace silently does nothing (the "chip won't delete" bug).
 */
function findAdjacentChip(root: HTMLElement, direction: 'backward' | 'forward'): HTMLElement | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return null

  let node: Node = range.startContainer
  let offset = range.startOffset

  // Inside a text node, only its very edge can be adjacent to a chip.
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    const before = text.slice(0, offset).replace(/\u200B/g, '')
    const after = text.slice(offset).replace(/\u200B/g, '')
    if (direction === 'backward' ? before.length > 0 : after.length > 0) return null
    const parent = node.parentNode
    if (!parent) return null
    offset = Array.prototype.indexOf.call(parent.childNodes, node) + (direction === 'forward' ? 1 : 0)
    node = parent
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const container = node as HTMLElement
  let index = direction === 'backward' ? offset - 1 : offset

  while (index >= 0 && index < container.childNodes.length) {
    const sibling = container.childNodes[index]

    if (sibling.nodeType === Node.TEXT_NODE) {
      // Skip the zero-width space that follows/precedes a chip.
      if ((sibling.textContent ?? '').replace(/\u200B/g, '').length > 0) return null
      index += direction === 'backward' ? -1 : 1
      continue
    }

    if (sibling.nodeType !== Node.ELEMENT_NODE) return null
    const el = sibling as HTMLElement
    return el.getAttribute('data-attachment') === 'true' ? el : null
  }

  return null
}

// ============================================================================
// Helper: Get cursor position in text model
// ============================================================================

function getCursorPosition(element: HTMLElement, fallback: number = 0): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return fallback

  const range = selection.getRangeAt(0)

  // Create a range from start of element to cursor
  const preRange = document.createRange()
  preRange.selectNodeContents(element)
  preRange.setEnd(range.startContainer, range.startOffset)

  // Get text length before cursor, excluding badge content
  const fragment = preRange.cloneContents()
  const div = document.createElement('div')
  div.appendChild(fragment)
  return getTextFromElement(div).length
}

// ============================================================================
// Helper: Set cursor position in contenteditable
// ============================================================================

function setCursorPosition(element: HTMLElement, targetPosition: number): void {
  const selection = window.getSelection()
  if (!selection) return

  let currentPos = 0

  function findPosition(node: Node): { node: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = node.textContent || ''
      // Filter out zero-width spaces to match text model (ZWS is a DOM-only artifact)
      const textWithoutZWS = rawText.replace(/\u200B/g, '')
      const modelLength = textWithoutZWS.length

      if (currentPos + modelLength >= targetPosition) {
        // Calculate actual DOM offset accounting for zero-width spaces
        const modelOffset = targetPosition - currentPos
        let domOffset = 0
        let modelCount = 0
        while (modelCount < modelOffset && domOffset < rawText.length) {
          if (rawText[domOffset] !== '\u200B') {
            modelCount++
          }
          domOffset++
        }
        // Skip any trailing ZWS at the target position
        while (domOffset < rawText.length && rawText[domOffset] === '\u200B') {
          domOffset++
        }
        return { node, offset: domOffset }
      }
      currentPos += modelLength
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement

      // Skip mention badge internals - treat as atomic
      if (el.getAttribute('data-mention') === 'true') {
        const mentionText = el.getAttribute('data-mention-text') || ''
        const mentionLength = mentionText.length
        const index = Array.from(el.parentNode!.childNodes).indexOf(el)
        // A target at the badge's left edge belongs BEFORE it; only an offset
        // strictly inside the text it represents is "after the badge".
        if (currentPos >= targetPosition) return { node: el.parentNode!, offset: index }
        if (currentPos + mentionLength >= targetPosition) {
          // Position cursor after the badge
          return { node: el.parentNode!, offset: index + 1 }
        }
        currentPos += mentionLength
        return null
      }

      // Attachment chips are atomic too: advance by the token and place the
      // caret after the chip when the target offset falls inside it. Descending
      // into the chip would target its label text (non-editable) instead.
      if (el.getAttribute('data-attachment') === 'true') {
        const tokenText = el.getAttribute('data-attachment-text') || ''
        const tokenLength = tokenText.length
        const index = Array.from(el.parentNode!.childNodes).indexOf(el)
        // Same boundary rule as badges: the left edge is before the chip. Using
        // `>=` here jumped the caret over the whole chip, which looked like it
        // drifted right after a paste that ended right before a tag.
        if (currentPos >= targetPosition) return { node: el.parentNode!, offset: index }
        if (currentPos + tokenLength >= targetPosition) {
          return { node: el.parentNode!, offset: index + 1 }
        }
        currentPos += tokenLength
        return null
      }

      // Handle BR
      if (el.tagName === 'BR') {
        currentPos += 1
        if (currentPos >= targetPosition) {
          return { node: el.parentNode!, offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1 }
        }
        return null
      }

      for (let i = 0; i < el.childNodes.length; i++) {
        const result = findPosition(el.childNodes[i])
        if (result) return result
      }
    }
    return null
  }

  const result = findPosition(element)

  if (result) {
    const range = document.createRange()
    range.setStart(result.node, result.offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  } else {
    // Position at end
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
}

/**
 * Insert HTML at the caret and return the last inserted node.
 *
 * The caret has to end up immediately after what was inserted. Deriving that
 * from a text offset is unreliable right after a cut: the cut rewrites the whole
 * editor DOM, so an offset measured "before" the insert can describe the old
 * markup and the caret lands off by the characters preceding the insertion.
 * Anchoring to the inserted node instead is exact, whatever came before.
 */
function insertHtmlAtCaret(element: HTMLElement, html: string): Node | null {
  const template = document.createElement('template')
  template.innerHTML = html
  const fragment = template.content
  const lastNode = fragment.lastChild
  if (!lastNode) return null

  // An empty contenteditable is rendered as a single <br> placeholder. Inserting
  // beside it leaves the <br> in front of the new content, which the text model
  // reads as a leading newline (Ctrl+A, Ctrl+X, Ctrl+V added one). Drop it and
  // start from a genuinely empty editor instead.
  if (element.childNodes.length === 1 && (element.firstChild as HTMLElement | null)?.nodeName === 'BR') {
    element.innerHTML = ''
    const fresh = document.createRange()
    fresh.setStart(element, 0)
    fresh.collapse(true)
    const freshSelection = window.getSelection()
    freshSelection?.removeAllRanges()
    freshSelection?.addRange(fresh)
  }

  const selection = window.getSelection()
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  if (range && element.contains(range.commonAncestorContainer)) {
    range.deleteContents()
    range.insertNode(fragment)
    return lastNode
  }

  // No usable caret (focus lost): append so the insertion is never dropped.
  element.appendChild(fragment)
  return lastNode
}

/** Collapse the selection immediately after `node`. */
function placeCaretAfter(node: Node): void {
  const parent = node.parentNode
  const selection = window.getSelection()
  if (!parent || !selection) return
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

// ============================================================================
// Convert text with mentions to HTML
// ============================================================================

export function textToHTML(
  text: string,
  skills: LoadedSkill[],
  sources: LoadedSource[],
  workspaceId?: string,
  attachments?: readonly RichTextAttachmentChip[]
): string {
  if (!text) return ''

  const skillSlugs = skills.map(s => s.slug)
  const sourceSlugs = sources.map(s => s.config.slug)
  const matches = findMentionMatches(text, skillSlugs, sourceSlugs)

  // Escape HTML in text
  const escapeHTML = (str: string) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')

  // Everything that renders as an atomic chip: mention badges and attachment
  // capsules, positioned in one ordered pass so the two can interleave.
  const spans: Array<{ start: number; end: number; html: string }> = []

  for (const match of matches) {
    // Determine label and data for badge
    let label = match.id
    let skill: LoadedSkill | undefined
    let source: LoadedSource | undefined
    let tooltip: string | undefined

    if (match.type === 'skill') {
      skill = skills.find(s => s.slug === match.id)
      label = skill?.metadata.name || match.id
    } else if (match.type === 'source') {
      source = sources.find(s => s.config.slug === match.id)
      label = source?.config.name || match.id
    } else if (match.type === 'file') {
      // Show filename as badge label, full path as tooltip
      label = match.id.split('/').pop() || match.id
      tooltip = match.id
    } else if (match.type === 'folder') {
      // Show folder name as badge label, full path as tooltip
      label = match.id.split('/').pop() || match.id
      tooltip = match.id
    }

    // Render badge with data-mention-text storing the original text
    const badgeHtml = renderBadgeHTML(match.type, label, skill, source, workspaceId, tooltip)
    // Add data-mention-text attribute to store original text for extraction
    const withMentionText = badgeHtml.replace(
      'data-mention="true"',
      `data-mention="true" data-mention-text="${match.fullMatch.replace(/"/g, '&quot;')}"`
    )
    spans.push({
      start: match.startIndex,
      end: match.startIndex + match.fullMatch.length,
      html: withMentionText,
    })
  }

  for (const { token, attachment } of resolveAttachmentTokens(text, attachments)) {
    spans.push({ start: token.start, end: token.end, html: renderAttachmentChipHTML(attachment, token.raw) })
  }

  if (spans.length === 0) return escapeHTML(text)

  spans.sort((a, b) => a.start - b.start)

  let html = ''
  let lastIndex = 0

  // A chip at offset 0 needs a leading zero-width space so the caret can be
  // placed before it at all (contenteditable cursor fix).
  if (spans[0].start === 0) {
    html += '\u200B'
  }

  for (const span of spans) {
    if (span.start < lastIndex) continue // overlapping token: keep the first
    // Add escaped text before this chip
    if (span.start > lastIndex) {
      html += escapeHTML(text.slice(lastIndex, span.start))
    }

    html += span.html

    lastIndex = span.end
  }

  // Add remaining text after the last chip
  if (lastIndex < text.length) {
    html += escapeHTML(text.slice(lastIndex))
  }

  return html
}

// ============================================================================
// Check if mentions have changed (for determining if we need to re-render HTML)
// ============================================================================

function getInlineSignature(text: string, skillSlugs: string[], sourceSlugs: string[]): string {
  const matches = findMentionMatches(text, skillSlugs, sourceSlugs)
  const mentions = matches.map(m => `${m.type}:${m.id}:${m.startIndex}`)
  // Attachment tokens participate too: a token appearing/disappearing is exactly
  // what turns into (or out of) a chip, so it must trigger the HTML rewrite.
  const attachments = findAttachmentTokens(text).map(t => `${t.key}:${t.start}`)
  return [...mentions, ...attachments].join('|')
}

// ============================================================================
// RotatingPlaceholder Component
// Animated placeholder that cycles through an array of strings with fade transitions.
// Stays visible even when input is focused (until user types).
// ============================================================================

interface RotatingPlaceholderProps {
  /** Array of placeholder strings to rotate through */
  placeholders: string[]
  /** Interval in ms between rotations (default: 5000) */
  intervalMs?: number
  /** Additional className for styling */
  className?: string
}

function RotatingPlaceholder({
  placeholders,
  intervalMs = 5000,
  className,
}: RotatingPlaceholderProps) {
  const [currentIndex, setCurrentIndex] = React.useState(0)
  const [opacity, setOpacity] = React.useState(1)

  React.useEffect(() => {
    // Don't rotate if only one placeholder
    if (placeholders.length <= 1) return

    const interval = setInterval(() => {
      // Fade out
      setOpacity(0)

      // After fade out (300ms), swap text and fade back in
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % placeholders.length)
        setOpacity(1)
      }, 300)
    }, intervalMs)

    return () => clearInterval(interval)
  }, [placeholders.length, intervalMs])

  return (
    <div
      className={cn('transition-opacity duration-300 ease-in-out', className)}
      style={{ opacity }}
    >
      {placeholders[currentIndex]}
    </div>
  )
}

// ============================================================================
// RichTextInput Component
// ============================================================================

export const RichTextInput = React.forwardRef<RichTextInputHandle, RichTextInputProps>(
  function RichTextInput(
    {
      value,
      onChange,
      placeholder,
      skills = [],
      sources = [],
      workspaceId,
      disabled = false,
      className,
      onFocus,
      onBlur,
      onKeyDown,
      onInput,
      onPaste,
      onLongTextPaste,
      onCopy: onCopyProp,
      onCut: onCutProp,
      attachments,
      getAttachmentClipboardPayload,
      onPasteAttachments,
      onAttachmentHover,
      onAttachmentLeave,
      onAttachmentActivate,
      ...restProps
    },
    forwardedRef
  ) {
    const { t } = useTranslation()
    const safeValue = React.useMemo(() => coerceInputText(value), [value])
    const divRef = React.useRef<HTMLDivElement>(null)
    const [isFocused, setIsFocused] = React.useState(false)
    const isComposing = React.useRef(false)
    /**
     * Render-visible mirror of `isComposing`.
     *
     * While composing, the IME writes the pre-edit text straight into the DOM but
     * `handleInput` deliberately does not publish it (see below), so `value` is
     * still empty. Anything derived from `value` alone would therefore style the
     * pre-edit text as if it were a placeholder — i.e. paint it transparent.
     */
    const [isComposingRender, setIsComposingRender] = React.useState(false)
    /** Timer used to defer reading the DOM until the IME has committed its text. */
    const compositionEndTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const lastValueRef = React.useRef(safeValue)
    const cursorPositionRef = React.useRef(safeValue.length)
    const lastMentionSignatureRef = React.useRef('')
    const isInternalUpdate = React.useRef(false)
    // Pending cursor position to restore after external value update (e.g., after @mention selection)
    const pendingCursorRef = React.useRef<number | null>(null)
    /** Timestamp of the last TSF recovery cycle (dedupes the re-entrant focus event). */
    const tsfRepairAtRef = React.useRef(0)
    /** Latest staged attachments (ref form: read inside DOM event handlers). */
    const attachmentsRef = React.useRef<RichTextAttachmentChip[]>(attachments ?? [])
    attachmentsRef.current = attachments ?? []
    /**
     * Chips inserted before the parent's `attachments` prop caught up.
     *
     * `insertAttachment()` runs synchronously, while React state lands on the
     * next render; without this the freshly inserted token would serialize fine
     * but the follow-up HTML rewrite would no longer recognise it as a chip.
     */
    const insertedChipsRef = React.useRef(new Map<string, RichTextAttachmentChip>())
    /** Attachment currently under the pointer (hover card anchor). */
    const hoveredChipRef = React.useRef<HTMLElement | null>(null)
    /** Imperative chip insertion (assigned after `handleInput` exists). */
    const insertAttachmentRef = React.useRef<(attachment: RichTextAttachmentChip) => boolean>(() => false)
    /**
     * Undo/redo history.
     *
     * The DOM cannot own this: re-rendering chips/badges writes `innerHTML`,
     * which wipes Chromium's native undo stack (and direct node removal never
     * enters it). Snapshots of the text model plus the caret are the only
     * reliable source of truth here.
     */
    const historyRef = React.useRef<{ past: HistoryEntry[]; future: HistoryEntry[] }>({ past: [], future: [] })
    const currentEntryRef = React.useRef<HistoryEntry>({ text: safeValue, cursor: safeValue.length })
    const resetHistory = React.useCallback((text: string, cursor: number) => {
      historyRef.current = { past: [], future: [] }
      currentEntryRef.current = { text, cursor }
    }, [])

    const getChipAttachments = React.useCallback((): RichTextAttachmentChip[] => {
      const merged = [...attachmentsRef.current]
      for (const chip of insertedChipsRef.current.values()) {
        if (!merged.some(existing => attachmentTokenKey(existing.name) === attachmentTokenKey(chip.name))) {
          merged.push(chip)
        }
      }
      return merged
    }, [])

    const skillSlugs = React.useMemo(() => skills.map(s => s.slug), [skills])
    const sourceSlugs = React.useMemo(() => sources.map(s => s.config.slug), [sources])

    // Preload icons for sources and skills
    React.useEffect(() => {
      if (!workspaceId) return

      // Preload source icons
      for (const source of sources) {
        loadSourceIcon({ config: source.config, workspaceId })
      }

      // Preload skill icons (handles emoji, URL, file, and auto-discovery)
      for (const skill of skills) {
        loadSkillIcon(skill, workspaceId)
      }
    }, [sources, skills, workspaceId])

    // Expose imperative handle
    React.useImperativeHandle(forwardedRef, () => ({
      focus: () => divRef.current?.focus(),
      blur: () => divRef.current?.blur(),
      get value() { return lastValueRef.current },
      get selectionStart() { return cursorPositionRef.current },
      setValue: (newValue: string) => {
        lastValueRef.current = newValue
      },
      setSelectionRange: (start: number, _end: number) => {
        // Store pending cursor for when external value sync runs
        pendingCursorRef.current = start
        cursorPositionRef.current = start
        if (divRef.current) {
          setCursorPosition(divRef.current, start)
        }
      },
      getBoundingClientRect: () => divRef.current?.getBoundingClientRect() ?? new DOMRect(),
      getCaretRect: () => {
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) return null
        const range = selection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        // If rect has zero dimensions (collapsed selection at line start), use a fallback
        if (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0) {
          // Insert a temporary span to measure position
          const span = document.createElement('span')
          span.textContent = '\u200B' // Zero-width space
          range.insertNode(span)
          const spanRect = span.getBoundingClientRect()
          span.remove()
          // Restore selection
          selection.removeAllRanges()
          selection.addRange(range)
          return spanRect
        }
        return rect
      },
      get element() { return divRef.current },
      insertAttachment: (attachment: RichTextAttachmentChip) => {
        return insertAttachmentRef.current(attachment)
      },
    }), [])

    // Handle input events
    const handleInput = React.useCallback((e?: React.FormEvent<HTMLDivElement>) => {
      // Never publish while a composition is active — neither when the local
      // ref is set (compositionstart ran) nor when only the event says so
      // (Windows TSF can flip nativeEvent.isComposing before compositionstart).
      // Publishing pre-edit text lets parents rewrite value + DOM, which aborts
      // the IME composition and strands pinyin letters as plain text.
      if (isCompositionInputEvent(e, isComposing.current)) return
      if (!divRef.current) return

      const newText = getTextFromElement(divRef.current)
      const cursorPos = getCursorPosition(divRef.current, cursorPositionRef.current)

      lastValueRef.current = newText
      cursorPositionRef.current = cursorPos

      // Record one history step per distinct text state. Repeated input events
      // that only move the caret update the current snapshot instead of
      // pushing a new step, so Ctrl+Z undoes real edits only.
      const currentEntry = currentEntryRef.current
      if (newText !== currentEntry.text) {
        historyRef.current.past.push(currentEntry)
        if (historyRef.current.past.length > HISTORY_LIMIT) historyRef.current.past.shift()
        historyRef.current.future.length = 0
        currentEntryRef.current = { text: newText, cursor: cursorPos }
      } else {
        currentEntryRef.current = { text: currentEntry.text, cursor: cursorPos }
      }

      // Check if mentions/chips changed - if so, we need to re-render HTML
      const newSignature = getInlineSignature(newText, skillSlugs, sourceSlugs)
      if (newSignature !== lastMentionSignatureRef.current) {
        lastMentionSignatureRef.current = newSignature
        // Re-render with badges and attachment chips
        isInternalUpdate.current = true
        const html = textToHTML(newText, skills, sources, workspaceId, getChipAttachments())
        divRef.current.innerHTML = html || '<br>' // Empty contenteditable needs a BR
        // Restore cursor
        setCursorPosition(divRef.current, cursorPos)
        isInternalUpdate.current = false
      }

      onChange(newText)
      onInput?.(newText, cursorPos)
    }, [onChange, onInput, skills, sources, skillSlugs, sourceSlugs, workspaceId, getChipAttachments])

    /**
     * Insert a chip at the caret.
     *
     * Insertion goes through `insertHTML` (not `insertNode`) so the browser's
     * undo stack keeps working. The chip carries its own zero-width space
     * internally, so the caret lands right after it without an extra stop;
     * `handleInput()` then re-syncs the text model (token included) and
     * re-renders the chip from the token, so DOM and value cannot drift apart.
     */
    insertAttachmentRef.current = (attachment: RichTextAttachmentChip) => {
      const el = divRef.current
      if (!el || disabled) return false

      insertedChipsRef.current.set(attachmentTokenKey(attachment.name), attachment)

      const token = formatAttachmentToken(attachment.name)
      // No trailing zero-width space here: the chip carries its own (inside the
      // atomic node), so the caret crosses the chip in a single step.
      const html = renderAttachmentChipHTML(attachment, token)

      el.focus()
      const selection = window.getSelection()
      const caretInside = !!selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)
      if (!caretInside) {
        // No caret in the input (e.g. attachment added while a menu had focus):
        // append so the chip is never silently dropped.
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        selection?.removeAllRanges()
        selection?.addRange(range)
      }

      const inserted = insertHtmlAtCaret(el, html)
      if (!inserted) return false
      // Caret anchored to the inserted chip, then publish. The signature is
      // pre-armed so `handleInput` does not rewrite innerHTML (which would move
      // the caret from an offset again).
      placeCaretAfter(inserted)
      lastMentionSignatureRef.current = getInlineSignature(getTextFromElement(el), skillSlugs, sourceSlugs)
      handleInput()
      return true
    }

    /**
     * Rebuild the editor from a history snapshot.
     *
     * Always a full re-render: a queued chip may have been deleted and the DOM
     * no longer matches the text model, so replaying DOM operations is not an
     * option. The caret is restored from the snapshot's model offset.
     */
    const applyHistoryEntry = React.useCallback((entry: HistoryEntry) => {
      const el = divRef.current
      if (!el) return
      isInternalUpdate.current = true
      el.innerHTML = textToHTML(entry.text, skills, sources, workspaceId, getChipAttachments()) || '<br>'
      lastValueRef.current = entry.text
      lastMentionSignatureRef.current = getInlineSignature(entry.text, skillSlugs, sourceSlugs)
      cursorPositionRef.current = entry.cursor
      isInternalUpdate.current = false

      el.focus()
      setCursorPosition(el, entry.cursor)
      onChange(entry.text)
      onInput?.(entry.text, entry.cursor)
    }, [skills, sources, workspaceId, skillSlugs, sourceSlugs, getChipAttachments, onChange, onInput])

    /** Step through history. `redo` walks forward, otherwise backwards. */
    const stepHistory = React.useCallback((redo: boolean): boolean => {
      const history = historyRef.current
      const from = redo ? history.future : history.past
      const to = redo ? history.past : history.future
      const entry = from.pop()
      if (!entry) return false
      to.push(currentEntryRef.current)
      currentEntryRef.current = entry
      applyHistoryEntry(entry)
      return true
    }, [applyHistoryEntry])

    /**
     * Backspace/Delete on a chip.
     *
     * Chromium often leaves the chip in place when the caret sits right next to
     * it (the zero-width space beside the chip absorbs the keystroke), so the
     * atomic deletion is performed explicitly: remove the node, then publish.
     */
    const deleteAdjacentChip = React.useCallback((direction: 'backward' | 'forward'): boolean => {
      const el = divRef.current
      if (!el) return false
      const chip = findAdjacentChip(el, direction)
      if (!chip) return false
      chip.remove()
      handleInput()
      return true
    }, [handleInput])

    // Handle composition (IME)
    React.useEffect(() => () => {
      if (compositionEndTimerRef.current !== null) clearTimeout(compositionEndTimerRef.current)
    }, [])

    const handleCompositionStart = React.useCallback(() => {
      if (compositionEndTimerRef.current !== null) {
        clearTimeout(compositionEndTimerRef.current)
        compositionEndTimerRef.current = null
      }
      isComposing.current = true
      setIsComposingRender(true)
    }, [])

    const handleCompositionEnd = React.useCallback(() => {
      isComposing.current = false
      setIsComposingRender(false)
      // Chromium can dispatch `compositionend` before the composed text is fully
      // committed to the DOM. Reading the element synchronously publishes the raw
      // pinyin/romaji pre-edit string as if it were committed, and the resulting
      // re-render then leaves those letters in the DOM so the real commit lands
      // next to them — the "duplicate letters after IME selection" bug. Wait for
      // the trailing `input` event instead; it fires right after the commit.
      if (compositionEndTimerRef.current !== null) clearTimeout(compositionEndTimerRef.current)
      compositionEndTimerRef.current = setTimeout(() => {
        compositionEndTimerRef.current = null
        // A new composition may have started in the meantime.
        if (isComposing.current) return
        handleInput()
      }, 0)
    }, [handleInput])

    /**
     * Keep `isComposing` in sync with the *native* composition signal on every
     * keydown. Windows TSF can dispatch the first composing keystroke before
     * React's `compositionstart` handler runs (or with that event lost), so the
     * local ref can lag behind the native flag; the reverse also happens when
     * `compositionend` drops while the IME already cleared the flag.
     *
     * Never re-reads the DOM and never publishes here — the trailing `input`
     * event still drives syncing — so this is purely state steering.
     */
    const handleKeyDownInternal = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
      const nextComposing = syncCompositionFromKeydown(e)
      if (nextComposing !== isComposing.current) {
        isComposing.current = nextComposing
        setIsComposingRender(nextComposing)
      }

      if (isEscapeDuringComposition(e, isComposing.current)) {
        e.stopPropagation()
        return
      }

      // Undo/redo. Handled here because the chip/badge re-render destroys the
      // browser's own undo stack. Always intercept while focused: letting the
      // event through would replay Chromium's partial history against our DOM
      // when our own history is empty, desyncing the text model.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.nativeEvent.isComposing) {
        const key = e.key.toLowerCase()
        if (key === 'z' || key === 'y') {
          e.preventDefault()
          stepHistory(key === 'y' || e.shiftKey)
          return
        }
      }

      // Explicit atomic deletion for chips (Backspace/Delete next to a chip).
      if (!e.nativeEvent.isComposing && (e.key === 'Backspace' || e.key === 'Delete')) {
        const direction = e.key === 'Backspace' ? 'backward' : 'forward'
        if (deleteAdjacentChip(direction)) {
          e.preventDefault()
          return
        }
      }

      onKeyDown?.(e)
    }, [onKeyDown, deleteAdjacentChip, stepHistory])

    // Handle paste - delegate files to parent, manually insert plain text
    const handlePasteInternal = React.useCallback((e: React.ClipboardEvent) => {
      // Never interfere while an IME composition is live. The clipboard path is
      // how some Windows IMEs commit candidate text; swallowing it here would
      // either block the commit or duplicate the committed characters. Leave
      // the event untouched so the browser applies the IME's own insertion.
      if (isImeCompositionPaste(e, isComposing.current)) return

      // Attachments copied from a composer (possibly in another conversation).
      // Preferred over the plain-text tokens below: the payload restores the
      // real attachment, so the chip paste is live in *this* composer too.
      const attachmentPayload = parseAttachmentClipboardPayload(
        e.clipboardData?.getData(ATTACHMENT_CLIPBOARD_MIME) ?? ''
      )
      if (attachmentPayload) {
        const el = divRef.current
        if (!el) return
        e.preventDefault()
        // Register the chips before rendering: the parent's `attachments` state
        // only lands on the next render, and until then the tokens would
        // serialize as plain text.
        for (const attachment of attachmentPayload.attachments) {
          insertedChipsRef.current.set(attachmentTokenKey(attachment.name), {
            name: attachment.name,
            type: attachment.type,
            mimeType: attachment.mimeType,
          })
        }
        onPasteAttachments?.(attachmentPayload.attachments)
        el.focus()
        // Insert through the browser command and let it own the caret: it places
        // the caret immediately after the inserted run (right after a pasted
        // chip). Any offset we compute ourselves becomes a second opinion, and
        // applying it after the browser already moved the caret is exactly how a
        // paste ends up shifted by the text that preceded it.
        const inserted = insertHtmlAtCaret(
          el,
          textToHTML(attachmentPayload.text, skills, sources, workspaceId, getChipAttachments())
        )
        if (inserted) placeCaretAfter(inserted)
        // The inserted markup already renders chips/badges, so suppress the
        // signature-triggered rewrite for this input: that rewrite restores the
        // caret from an offset measured before the browser settled the
        // selection.
        lastMentionSignatureRef.current = getInlineSignature(getTextFromElement(el), skillSlugs, sourceSlugs)
        handleInput()
        return
      }

      // Check if we have files - let parent handle that
      const hasFiles = e.clipboardData?.files && e.clipboardData.files.length > 0
      if (hasFiles && onPaste) {
        e.preventDefault()
        onPaste(e)
        return
      }

      // Prevent default to avoid HTML paste, then insert plain text manually
      e.preventDefault()

      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      // Windows clipboards use CRLF. A CR survives into the DOM as an invisible
      // character that still counts toward model offsets, which is exactly the
      // kind of off-by-a-few noise that makes a caret look shifted.
      const normalizedText = text.replace(/\r\n?/g, '\n')

      const el = divRef.current
      if (!el) return

      // Check if text is too long - convert to file attachment instead
      const lineCount = normalizedText.split('\n').length
      if (lineCount > LONG_TEXT_LINE_THRESHOLD && onLongTextPaste) {
        onLongTextPaste(normalizedText)
        return
      }

      // Tokens of attachments that are still staged come back as chips, so
      // copying a chip (or a run of text containing one) and pasting it again
      // restores the real attachment instead of a dead `[attachment:…]` string.
      const chipAttachments = getChipAttachments()
      el.focus()
      // See the payload branch above: the browser's own insertion keeps the caret
      // correct, and the signature is pre-armed so `handleInput` does not rewrite
      // the DOM (and reposition the caret) right after the paste.
      const inserted = insertHtmlAtCaret(el, textToHTML(normalizedText, skills, sources, workspaceId, chipAttachments))
      if (inserted) placeCaretAfter(inserted)
      lastMentionSignatureRef.current = getInlineSignature(getTextFromElement(el), skillSlugs, sourceSlugs)
      handleInput()
    }, [onPaste, onLongTextPaste, onPasteAttachments, getChipAttachments, skills, sources, workspaceId, handleInput])

    //
    // Selection helpers for Ctrl+C / Ctrl+X over chips.
    //
    // The browser's native copy of a chip yields markup that means nothing to
    // the clipboard (bytes can't travel), so a selection containing a chip is
    // serialized through the text model instead: chips become their tokens.
    // Plain text selections are left completely alone (native rich copy).
    //

    const getSelectedText = React.useCallback((): string | null => {
      const el = divRef.current
      if (!el) return null
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      if (!el.contains(range.commonAncestorContainer)) return null

      const holder = document.createElement('div')
      holder.appendChild(range.cloneContents())
      return getTextFromElement(holder)
    }, [])

    /**
     * Tokens of the chips inside the current selection, in document order.
     *
     * The chip's `data-attachment-text` is the token itself, so the parent can
     * resolve the staged payload by token without re-deriving the name.
     */
    const getSelectedAttachmentTokens = React.useCallback((): string[] => {
      const el = divRef.current
      if (!el) return []
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return []
      const range = selection.getRangeAt(0)
      if (!el.contains(range.commonAncestorContainer)) return []

      const tokens: string[] = []
      for (const chip of Array.from(el.querySelectorAll<HTMLElement>('[data-attachment="true"]'))) {
        if (!range.intersectsNode(chip)) continue
        const token = chip.getAttribute('data-attachment-text')
        if (token) tokens.push(token)
      }
      return tokens
    }, [])

    /**
     * Put the attachments themselves on the clipboard.
     *
     * The plain-text tokens stay as a fallback, but a tag is meaningless
     * outside the composer that staged it: pasting `[attachment:x]` into
     * another conversation used to leave a dead chip. The payload MIME carries
     * name/type/bytes so any composer can stage it again, and the same copy is
     * also exposed as real files for apps outside Craft.
     */
    const writeAttachmentClipboard = React.useCallback((
      clipboard: DataTransfer | null,
      text: string,
      tokens: string[],
    ) => {
      if (!clipboard || tokens.length === 0) return

      const attachments: FileAttachment[] = []
      const files: File[] = []
      for (const token of tokens) {
        const payload = getAttachmentClipboardPayload?.(token)
        if (!payload) continue
        attachments.push(payload)
        const file = fileAttachmentToFile(payload)
        if (file) files.push(file)
      }
      if (attachments.length === 0) return

      clipboard.setData(ATTACHMENT_CLIPBOARD_MIME, serializeAttachmentClipboardPayload(text, attachments))
      for (const file of files) {
        try {
          // Chromium materializes file items as real OS clipboard files, so the
          // same Ctrl+C also pastes into Explorer / Word / any other app.
          clipboard.items.add(file)
        } catch {
          // Platforms that refuse file items still keep the MIME payload above.
        }
      }
    }, [getAttachmentClipboardPayload])

    const handleCopyInternal = React.useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
      onCopyProp?.(e)
      if (e.defaultPrevented) return

      const text = getSelectedText()
      if (!text || !hasAttachmentToken(text)) return
      // Chips travel as attachments, not as tags: the clipboard carries the
      // payloads so the paste works in any composer (other conversations) and
      // as real files so it also works outside the app.
      writeAttachmentClipboard(e.clipboardData, text, getSelectedAttachmentTokens())
      e.clipboardData?.setData('text/plain', text)
      e.preventDefault()
    }, [onCopyProp, getSelectedText, writeAttachmentClipboard, getSelectedAttachmentTokens])

    const handleCutInternal = React.useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
      onCutProp?.(e)
      if (e.defaultPrevented) return

      const text = getSelectedText()
      if (!text || !hasAttachmentToken(text)) return
      writeAttachmentClipboard(e.clipboardData, text, getSelectedAttachmentTokens())
      e.clipboardData?.setData('text/plain', text)
      e.preventDefault()
      // `delete` runs through the native command so undo history stays coherent.
      document.execCommand('delete')
    }, [onCutProp, getSelectedText, writeAttachmentClipboard, getSelectedAttachmentTokens])

    // Hover / double-click on chips (preview card + preview overlay).
    const handleMouseOverInternal = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      const chip = (e.target as HTMLElement | null)?.closest?.('[data-attachment="true"]') as HTMLElement | null
      if (!chip || !divRef.current?.contains(chip)) return
      if (hoveredChipRef.current === chip) return

      hoveredChipRef.current = chip
      const rect = chip.getBoundingClientRect()
      onAttachmentHover?.(chip.getAttribute('data-attachment-text') ?? '', {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      })
    }, [onAttachmentHover])

    const handleMouseOutInternal = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      const chip = hoveredChipRef.current
      if (!chip) return
      const next = e.relatedTarget as Node | null
      if (next && chip.contains(next)) return
      hoveredChipRef.current = null
      onAttachmentLeave?.()
    }, [onAttachmentLeave])

    const handleDoubleClickInternal = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      const chip = (e.target as HTMLElement | null)?.closest?.('[data-attachment="true"]') as HTMLElement | null
      if (!chip || !divRef.current?.contains(chip)) return
      const token = chip.getAttribute('data-attachment-text')
      if (!token) return
      e.preventDefault()
      onAttachmentActivate?.(token)
    }, [onAttachmentActivate])

    // Handle focus
    const handleFocus = React.useCallback((e: React.FocusEvent<HTMLDivElement>) => {
      setIsFocused(true)
      onFocus?.(e)
      const el = e.currentTarget
      // A first focus that lands on an element holding text can leave the
      // Windows TSF/IME context broken (no candidate window; keystrokes land
      // as raw letters). Re-prime it through the off-screen empty textarea and
      // back. The cycle's own refocus re-fires this handler, so a 250 ms
      // window dedupes the re-entry instead of chaining cycles.
      const now = performance.now()
      if (needsTsfRepair({ hasExistingText: getTextFromElement(el).length > 0, isComposing: isComposing.current })
        && now - tsfRepairAtRef.current > 250) {
        tsfRepairAtRef.current = now
        Promise.resolve().then(() => {
          // Only re-run if focus is still on our element — the user may have
          // already moved on, in which case a different element's focus will
          // repair TSF for it.
          if (document.activeElement === el) runTsfRecoveryCycle(el)
        })
      }
    }, [onFocus])

    // Handle blur
    const handleBlur = React.useCallback((e: React.FocusEvent<HTMLDivElement>) => {
      setIsFocused(false)
      onBlur?.(e)
    }, [onBlur])

    // Sync value from props (when parent updates value externally)
    React.useEffect(() => {
      if (!divRef.current) return
      if (isInternalUpdate.current) return
      // Never rewrite the DOM mid-composition: replacing innerHTML destroys the
      // browser's composition node, which aborts the IME and strands the pre-edit
      // letters as plain text. `handleInput()` re-syncs once the composition ends.
      if (isComposing.current) return
      if (lastValueRef.current === safeValue) return

      // External value change - update content. The edit history belongs to the
      // previous document, so it must not survive into the new one.
      resetHistory(safeValue, pendingCursorRef.current ?? safeValue.length)
      const nextInlineSignature = getInlineSignature(safeValue, skillSlugs, sourceSlugs)
      const inlineSignatureChanged = nextInlineSignature !== lastMentionSignatureRef.current
      lastValueRef.current = safeValue
      lastMentionSignatureRef.current = nextInlineSignature

      // Re-serializing a tree that already matches the requested value is pure
      // collateral damage: it destroys the browser's edit context, which on
      // Windows leaves the *next* keystroke outside the IME (it lands as plain
      // text / duplicated letters). Skip the rewrite when both the text and the
      // inline-chip signature are already in sync.
      if (!inlineSignatureChanged && getTextFromElement(divRef.current) === safeValue) {
        pendingCursorRef.current = null
        return
      }

      const html = textToHTML(safeValue, skills, sources, workspaceId, getChipAttachments())
      divRef.current.innerHTML = html || '<br>'
      // Writing innerHTML drops the node's edit context. When the user holds
      // focus, re-prime TSF against the rewritten DOM by detouring focus
      // through the empty priming textarea and back — without this, the first
      // keystroke after an external value change (e.g. a draft restored on
      // session switch) never reaches the IME. The whole cycle runs in one
      // synchronous task, so React batches the focus callbacks (no flicker).
      if (document.activeElement === divRef.current && needsTsfRepair({ hasExistingText: safeValue.length > 0, isComposing: false })) {
        tsfRepairAtRef.current = performance.now()
        runTsfRecoveryCycle(divRef.current)
      }

      // Restore cursor position after innerHTML update.
      // Only restore if:
      // 1. We have a pending position from setSelectionRange (explicit programmatic positioning), OR
      // 2. The element is actually focused (user is actively editing)
      // This prevents stealing focus during session changes when search is active.
      if (pendingCursorRef.current !== null || document.activeElement === divRef.current) {
        const cursorPos = pendingCursorRef.current ?? cursorPositionRef.current ?? safeValue.length
        setCursorPosition(divRef.current, cursorPos)
        pendingCursorRef.current = null // Clear after use
      }
    }, [safeValue, skills, sources, skillSlugs, sourceSlugs, workspaceId, getChipAttachments])

    // Initialize content on mount
    React.useEffect(() => {
      // Tell the document to use <br> instead of <div> for line breaks in
      // contenteditable (set once; it is a document-wide preference). Doing this
      // on every focus used to be a TSF hazard: the execCommand rewires the
      // selection synchronously inside the focus sequence, which on Windows can
      // leave the very first IME composition without an edit context (first
      // keystroke falls through as plain text / duplicated letters).
      document.execCommand('defaultParagraphSeparator', false, 'br')
      if (!divRef.current) return
      lastMentionSignatureRef.current = getInlineSignature(safeValue, skillSlugs, sourceSlugs)
      const html = textToHTML(safeValue, skills, sources, workspaceId, getChipAttachments())
      divRef.current.innerHTML = html || '<br>'
      lastValueRef.current = safeValue
      resetHistory(safeValue, safeValue.length)
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * Track caret moves that do not produce an input event (clicks, arrow keys,
     * Home/End).
     *
     * History snapshots are pushed by `handleInput`, which only runs on edits —
     * so without this the "state before this edit" snapshot carried the caret
     * from the last *typing*, not from where the user actually was. Undoing a
     * paste then threw the caret back to that older position (paste after "4",
     * undo, caret jumps to after "3").
     */
    React.useEffect(() => {
      const handleSelectionChange = () => {
        const el = divRef.current
        if (!el || document.activeElement !== el) return
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) return
        if (!selection.isCollapsed) return
        const range = selection.getRangeAt(0)
        if (!el.contains(range.startContainer)) return

        const cursor = getCursorPosition(el, currentEntryRef.current.cursor)
        if (currentEntryRef.current.cursor === cursor) return
        currentEntryRef.current = { text: currentEntryRef.current.text, cursor }
        cursorPositionRef.current = cursor
      }

      document.addEventListener('selectionchange', handleSelectionChange)
      return () => document.removeEventListener('selectionchange', handleSelectionChange)
    }, [])

    // Handle selection changes to highlight badges when selected
    React.useEffect(() => {
      // Get selection color from CSS variable (accent with transparency)
      const getSelectionColor = () => {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
        // Return accent color with 40% opacity
        return accent ? `oklch(${accent.replace('oklch(', '').replace(')', '')} / 0.4)` : 'rgba(99, 102, 241, 0.4)'
      }

      const handleSelectionChange = () => {
        if (!divRef.current) return

        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) return

        const range = selection.getRangeAt(0)

        // Get all mention badges and attachment chips
        const badges = divRef.current.querySelectorAll('.mention-badge, .attachment-chip') as NodeListOf<HTMLElement>

        badges.forEach((badge) => {
          // Check if badge is within selection range
          const badgeRange = document.createRange()
          badgeRange.selectNode(badge)

          const isSelected =
            range.compareBoundaryPoints(Range.START_TO_END, badgeRange) > 0 &&
            range.compareBoundaryPoints(Range.END_TO_START, badgeRange) < 0

          const isMentionBadge = badge.classList.contains('mention-badge')
          if (isSelected) {
            badge.style.backgroundColor = getSelectionColor()
            if (isMentionBadge) badge.classList.remove('bg-background')
          } else {
            badge.style.backgroundColor = ''
            if (isMentionBadge) badge.classList.add('bg-background')
          }
        })
      }

      document.addEventListener('selectionchange', handleSelectionChange)
      return () => document.removeEventListener('selectionchange', handleSelectionChange)
    }, [])

    // Show placeholder when input is empty (regardless of focus state).
    // Suppressed while composing: the IME's pre-edit text is already in the DOM
    // but has not been published through `onChange` yet, so `safeValue` is still
    // empty and the transparent placeholder styling would hide what the user types.
    const showPlaceholder = !safeValue && !isComposingRender

    // Normalize placeholder to array for RotatingPlaceholder
    const placeholderArray = React.useMemo(() => {
      if (!placeholder) return [t("chatInput.placeholder.typeMessage")]
      return Array.isArray(placeholder) ? placeholder : [placeholder]
    }, [placeholder])

    // Check if value contains any mentions (badges) to adjust line height
    const hasMentions = React.useMemo(() => {
      const mentions = parseMentions(safeValue, skillSlugs, sourceSlugs)
      return mentions.skills.length > 0 || mentions.sources.length > 0 || mentions.files.length > 0 || mentions.folders.length > 0
    }, [safeValue, skillSlugs, sourceSlugs])

    return (
      <div className="relative">
        <div
          ref={divRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          tabIndex={disabled ? -1 : 0}
          // Disable auto-capitalization/correction that breaks IME (e.g. CJK pinyin) input (#837/#878)
          autoCapitalize="none"
          autoCorrect="off"
          className={cn(
            'outline-none text-sm whitespace-pre-wrap break-words',
            'min-h-[1.5em]',
            disabled && 'opacity-50 cursor-not-allowed',
            // Make text transparent when showing placeholder (so caret is still visible)
            showPlaceholder && 'text-transparent caret-foreground',
            className
          )}
          // Use inline style for line-height to override text-sm's built-in line-height
          style={{ lineHeight: 1.25 }}
          onInput={handleInput}
          onKeyDown={handleKeyDownInternal}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPaste={handlePasteInternal}
          onCopy={handleCopyInternal}
          onCut={handleCutInternal}
          onMouseOver={handleMouseOverInternal}
          onMouseOut={handleMouseOutInternal}
          onDoubleClick={handleDoubleClickInternal}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          aria-disabled={disabled}
          aria-placeholder={Array.isArray(placeholder) ? placeholder[0] : placeholder}
          role="textbox"
          aria-multiline="true"
          {...restProps}
        />
        {/* Rotating placeholder overlay - visible when empty, even when focused */}
        {showPlaceholder && (
          <RotatingPlaceholder
            placeholders={placeholderArray}
            intervalMs={5000}
            className={cn(
              'absolute inset-0 text-sm text-muted-foreground pointer-events-none select-none',
              className
            )}
          />
        )}
      </div>
    )
  }
)
