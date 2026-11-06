/**
 * Markdown → Telegram MarkdownV2 converter.
 *
 * Telegram's MarkdownV2 is *not* a superset of CommonMark:
 *   - `#` has no heading meaning (headings degrade to bold)
 *   - bold is `*single*` and italic is `_single_`
 *   - escaping is mandatory, but the escape set differs per context:
 *       · everywhere          → `_ * [ ] ( ) ~ \` > # + - = | { } . ! \`
 *       · inside code/pre     → only `` ` `` and `\`
 *       · inside a link URL   → only `)` and `\`
 * Sending raw Markdown with no `parse_mode` therefore renders every syntax
 * character literally — the bug this module exists to fix.
 *
 * Design constraints:
 *   - **Zero dependencies.** Mirrors the Lark converter. A full Markdown AST
 *     would be overkill, and the tree→string round-trip is exactly where
 *     entity-nesting bugs live.
 *   - **Always well-formed.** `editMessage` fires on every streaming flush, so
 *     the input is routinely half-written (`**bo`, an unclosed fence, a link
 *     with no `)` yet). Unbalanced markers are emitted as escaped literals and
 *     an unterminated fence is closed, so Telegram never answers
 *     `400: can't parse entities` mid-stream.
 */

/** Characters that must be escaped in Telegram MarkdownV2 outside code/links. */
const TG_SPECIAL_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g

/** Inside `pre`/`code` entities only '`' and '\' may be escaped. */
const TG_CODE_CHARS = /([`\\])/g

/** Inside the `(...)` part of an inline link only ')' and '\' may be escaped. */
const TG_LINK_URL_CHARS = /([)\\])/g

/** Telegram hard limits. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024

export type TelegramParseMode = 'MarkdownV2'

export const TELEGRAM_PARSE_MODE: TelegramParseMode = 'MarkdownV2'

/** Escape text for Telegram MarkdownV2 parse mode. */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(TG_SPECIAL_CHARS, '\\$1')
}

/**
 * Convert agent Markdown to a Telegram MarkdownV2 payload.
 *
 * Coverage:
 *   - `**bold**`            → `*bold*`
 *   - `*italic*` / `_it_`   → `_italic_`
 *   - `***both***`          → `*_both_*`
 *   - `~~strike~~`          → `~strike~`
 *   - `` `inline` ``        → `` `inline` ``
 *   - ` ```lang\ncode``` `  → fenced `pre` block
 *   - `[label](url)`        → `[label](url)`
 *   - `# Heading`           → `*Heading*`
 *   - `> quote`             → `>quote`
 *   - `- [x]` / `- [ ]`     → ☑ / ☐ (no task entity exists)
 *   - GFM tables            → column-aligned monospace block
 *   - other lists / HTML    → literal text (MarkdownV2 has no such entities)
 */
export function formatForTelegram(markdown: string): string {
  if (!markdown) return ''

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    out.push(paragraph.join('\n'))
    paragraph = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code block — consumed verbatim (only `\` and '`' escaped).
    const fence = FENCE_RE.exec(line)
    if (fence) {
      flushParagraph()
      const marker = fence[1]!
      const closeRe = closingFenceRe(marker)
      const body: string[] = []
      i++
      while (i < lines.length && !closeRe.test(lines[i]!)) {
        body.push(lines[i]!)
        i++
      }
      if (i < lines.length) i++ // consume the closing fence
      const lang = fence[2] ? escapeCode(fence[2]) : ''
      // Closing fence on its own line — the canonical `pre` form Telegram parses.
      out.push('```' + lang + '\n' + escapeCode(body.join('\n')) + '\n```')
      continue
    }

    // Heading → bold (MarkdownV2 has no heading entity).
    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushParagraph()
      const text = heading[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim()
      if (text) out.push('*' + inlineToV2(text) + '*')
      i++
      continue
    }

    // Blockquote — each line needs its own leading `>`.
    if (BLOCKQUOTE_RE.test(line)) {
      flushParagraph()
      const quoted: string[] = []
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(BLOCKQUOTE_RE, ''))
        i++
      }
      out.push(quoted.map((l) => '>' + inlineToV2(l)).join('\n'))
      continue
    }

    // Horizontal rule — no equivalent, drop it.
    if (HR_RE.test(line)) {
      flushParagraph()
      i++
      continue
    }

    // GFM table — no table entity in MarkdownV2, so re-lay it out inside a
    // monospace block where the column alignment actually survives.
    if (line.includes('|') && isTableDelimiter(lines[i + 1])) {
      flushParagraph()
      const align = parseAlignments(lines[i + 1]!)
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|')) {
        if (lines[i]!.trim() === '') break
        rows.push(splitRow(lines[i]!))
        i++
      }
      out.push(renderTable(header, rows, align))
      continue
    }

    // Blank line ends the current block.
    if (line.trim() === '') {
      flushParagraph()
      i++
      continue
    }

    // Task list item — render the checkbox as a glyph.
    const task = TASK_ITEM_RE.exec(line)
    if (task) {
      const indent = task[1]!.replace(/\t/g, '  ')
      const done = task[2]!.toLowerCase() === 'x'
      paragraph.push(indent + (done ? DONE_BOX : TODO_BOX) + ' ' + inlineToV2(task[3]!))
      i++
      continue
    }

    // List item — bullet/number kept as literal text.
    const item = LIST_ITEM_RE.exec(line)
    if (item) {
      const indent = item[1]!.replace(/\t/g, '  ')
      paragraph.push(indent + escapeText(item[2]!) + ' ' + inlineToV2(item[3]!))
      i++
      continue
    }

    paragraph.push(inlineToV2(line))
    i++
  }

  flushParagraph()
  return out.join('\n\n')
}

// ---------------------------------------------------------------------------
// Block-level patterns
// ---------------------------------------------------------------------------

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]*)?[ \t]*$/
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const BLOCKQUOTE_RE = /^ {0,3}>[ \t]?/
const HR_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const TASK_ITEM_RE = /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** Checkbox glyphs — MarkdownV2 has no task-list entity. */
const DONE_BOX = '\u2611' // ☑
const TODO_BOX = '\u2610' // ☐

function closingFenceRe(marker: string): RegExp {
  const ch = marker[0] === '`' ? '`' : '~'
  return new RegExp(`^ {0,3}${ch}{${marker.length},}[ \\t]*$`)
}

// ---------------------------------------------------------------------------
// Tables (GFM → aligned monospace block)
// ---------------------------------------------------------------------------

function isTableDelimiter(line: string | undefined): boolean {
  if (!line || !line.includes('-') || !line.includes('|')) return false
  return TABLE_DELIM_RE.test(line)
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((cell) => plainCell(cell.trim()))
}

/** Drop emphasis markers — they'd only show literally inside the code block. */
function plainCell(cell: string): string {
  return cell
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
}

type CellAlign = 'left' | 'center' | 'right'

function parseAlignments(delimiter: string): CellAlign[] {
  return splitRowRaw(delimiter).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

function splitRowRaw(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((cell) => cell.trim())
}

function renderTable(header: string[], rows: string[][], align: CellAlign[]): string {
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 0)
  if (cols === 0) return ''

  const widths: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = displayWidth(header[c] ?? '')
    for (const row of rows) w = Math.max(w, displayWidth(row[c] ?? ''))
    widths.push(w)
  }

  const layout = (cells: string[]): string => {
    const parts: string[] = []
    for (let c = 0; c < cols; c++) {
      const cell = cells[c] ?? ''
      const fill = Math.max(0, widths[c]! - displayWidth(cell))
      const mode = align[c] ?? 'left'
      if (mode === 'right') parts.push(' '.repeat(fill) + cell)
      else if (mode === 'center') {
        const before = Math.floor(fill / 2)
        parts.push(' '.repeat(before) + cell + ' '.repeat(fill - before))
      } else parts.push(cell + ' '.repeat(fill))
    }
    return parts.join('  ').trimEnd()
  }

  const rule = widths.map((w) => '-'.repeat(Math.max(1, w))).join('  ')
  const body = [layout(header), rule, ...rows.map(layout)]
  return '```\n' + escapeCode(body.join('\n')) + '\n```'
}

/** East-Asian wide characters occupy two monospace cells. */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/

function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += WIDE_CHAR.test(ch) ? 2 : 1
  return width
}

// ---------------------------------------------------------------------------
// Inline conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single inline span to MarkdownV2.
 *
 * Markers are matched left-to-right; anything unbalanced degrades to escaped
 * literal text so the result stays parseable. Styles nest via recursion,
 * which keeps entity open/close order naturally balanced.
 */
function inlineToV2(input: string): string {
  let out = ''
  let i = 0

  while (i < input.length) {
    const ch = input[i]!

    // Markdown escape → literal character (still escaped for Telegram).
    if (ch === '\\' && i + 1 < input.length) {
      out += escapeText(input[i + 1]!)
      i += 2
      continue
    }

    // Inline code — must escape only '`' and '\' inside.
    if (ch === '`') {
      const run = runLength(input, i, '`')
      const close = findRun(input, i + run, '`', run)
      if (close >= 0) {
        const fence = '`'.repeat(run)
        out += fence + escapeCode(input.slice(i + run, close)) + fence
        i = close + run
        continue
      }
      // Unterminated (mid-stream) — emit the rest as literal text.
      out += escapeText(input.slice(i))
      i = input.length
      continue
    }

    // Link: [label](url)
    // The URL matcher tolerates one level of balanced parentheses so Wikipedia
    // links like `.../X_(y)` aren't cut off at the first `)`.
    if (ch === '[') {
      const m = /^\[([^\]\n]*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/.exec(input.slice(i))
      if (m) {
        out += '[' + inlineToV2(m[1]!) + '](' + escapeLinkUrl(m[2]!) + ')'
        i += m[0].length
        continue
      }
    }

    // Spoiler: ||text||
    if (ch === '|' && input[i + 1] === '|') {
      const close = input.indexOf('||', i + 2)
      if (close > i) {
        out += '||' + inlineToV2(input.slice(i + 2, close)) + '||'
        i = close + 2
        continue
      }
    }

    // Bold + italic: ***text*** → *_text_*
    if (ch === '*' && input[i + 1] === '*' && input[i + 2] === '*') {
      const close = input.indexOf('***', i + 3)
      if (close > i) {
        out += '*_' + inlineToV2(input.slice(i + 3, close)) + '_*'
        i = close + 3
        continue
      }
    }

    // Bold: **text** → *text*
    if (ch === '*' && input[i + 1] === '*') {
      const close = input.indexOf('**', i + 2)
      if (close > i + 1) {
        out += '*' + inlineToV2(input.slice(i + 2, close)) + '*'
        i = close + 2
        continue
      }
      // Unbalanced while streaming — literal text from here on.
      out += escapeText(input.slice(i))
      i = input.length
      continue
    }

    // Strikethrough: ~~text~~ → ~text~
    if (ch === '~' && input[i + 1] === '~') {
      const close = input.indexOf('~~', i + 2)
      if (close > i) {
        out += '~' + inlineToV2(input.slice(i + 2, close)) + '~'
        i = close + 2
        continue
      }
    }

    // Italic: *text* or _text_ → _text_
    if (ch === '*' || ch === '_') {
      const prev = i > 0 ? input[i - 1] : undefined
      const next = input[i + 1]
      const canOpen =
        next !== undefined &&
        !/\s/.test(next) &&
        // `_` only opens outside a word, so snake_case stays literal.
        !(ch === '_' && prev !== undefined && /[A-Za-z0-9]/.test(prev))
      if (canOpen) {
        const close = findEmphasisClose(input, i + 1, ch)
        if (close > i) {
          out += '_' + inlineToV2(input.slice(i + 1, close)) + '_'
          i = close + 1
          continue
        }
      }
    }

    out += escapeText(ch)
    i += 1
  }

  return out
}

function escapeText(text: string): string {
  return text.replace(TG_SPECIAL_CHARS, '\\$1')
}

function escapeCode(text: string): string {
  return text.replace(TG_CODE_CHARS, '\\$1')
}

function escapeLinkUrl(url: string): string {
  return url.replace(TG_LINK_URL_CHARS, '\\$1')
}

/** Length of the run of `ch` starting at `from`. */
function runLength(input: string, from: number, ch: string): number {
  let n = 0
  while (input[from + n] === ch) n++
  return n
}

/** Index of the next run of exactly `n` `ch`, or -1. */
function findRun(input: string, from: number, ch: string, n: number): number {
  const needle = ch.repeat(n)
  for (let j = from; j <= input.length - n; j++) {
    if (input.slice(j, j + n) !== needle) continue
    if (input[j + n] === ch) continue // longer run — not our closer
    return j
  }
  return -1
}

/**
 * Find a valid closing emphasis marker. Closing requires a non-space
 * predecessor; `_` additionally may not be followed by a word character so
 * identifiers like `snake_case` aren't swallowed as italic.
 */
function findEmphasisClose(input: string, from: number, marker: string): number {
  for (let j = from; j < input.length; j++) {
    if (input[j] !== marker) continue
    if (input[j + 1] === marker) continue // part of ** / __
    const prev = j > 0 ? input[j - 1] : undefined
    if (prev === undefined || /\s/.test(prev)) continue
    if (marker === '_' && input[j + 1] !== undefined && /[A-Za-z0-9]/.test(input[j + 1]!)) continue
    return j
  }
  return -1
}
