/**
 * Parsing for the "add keys" textareas, shared by the provider-create dialog
 * and the add-key dialog on the provider detail page.
 *
 * Line format: `类型|apikey|备注` — all parts after the key are optional, so a
 * bare `sk-...` line is valid and so is `premium|sk-...|备用`. Pipes were
 * chosen over the earlier colon because providers routinely paste keys that
 * already contain colons.
 *
 * Keys are recognised by shape rather than by position: a pasted line often
 * arrives wrapped in prose ("XXX-sk-r4xxxx", "主key：sk-xxx"), and throwing
 * those away loses real keys. Anything that does not parse as delimited fields
 * is scanned for a key-looking substring and used as a bare key.
 *
 * Pure so the rules can be unit tested without a DOM.
 */

export interface ParsedKey {
  /** The API key itself, extracted from the line. */
  key: string
  /** Provider/key type, e.g. "premium". Empty when the line omitted it. */
  preset: string
  note: string
}

/**
 * What counts as a key when scanning *inside* a line.
 *
 * The `sk-` prefix is a strong signal on its own, so it needs no length floor:
 * relays that mirror OpenAI's shape are everywhere, and a local proxy that
 * ignores the key entirely still wants *some* placeholder (`sk-xx`). Requiring
 * 8 characters after the prefix rejected exactly those.
 *
 * A bare run with no prefix is the ambiguous case — it might be a word in a
 * sentence — so it keeps a length floor.
 */
const KEY_PATTERN = /(sk-[A-Za-z0-9._:\-]*[A-Za-z0-9]|[A-Za-z0-9_\-]{16,})/g

/**
 * A line that is nothing but one token: no spaces, no CJK, no punctuation
 * around it.
 */
const SINGLE_TOKEN = /^[A-Za-z0-9_.:\-]{2,128}$/

/**
 * Prefixes that carry no credential: they are the wrapping the user pasted
 * around the key ("主key：sk-xxx", "XXX-sk-r4xxxx"). Stripped before the scan
 * so the match starts at the key, not at the noise in front of it.
 */
const LEADING_NOISE = /^[\s"'`（）()【】\[\]<>：:，,、+=\-*\/\\|]*/

function findKey(part: string): string {
  const trimmed = part.replace(LEADING_NOISE, '')
  if (!trimmed) return ''
  // An `sk-` anywhere in the line marks where the credential starts: the run
  // in front of it ("XXX-") is wrapping, not key material. Without this the
  // bare-token branch matched the whole thing, because "XXX-sk-r4abcdef123456"
  // is itself 22 credential-shaped characters.
  const skAt = trimmed.search(/sk-/i)
  const fromSk = skAt > 0 ? trimmed.slice(skAt) : trimmed
  const hits = fromSk.match(KEY_PATTERN)
  if (!hits || !hits.length) return ''
  const sk = hits.find((h) => /^sk-/i.test(h))
  return (sk ?? hits.reduce((a, b) => (b.length > a.length ? b : a))).trim()
}

export function parseKeyLine(line: string, options: { wholeInput?: boolean } = {}): ParsedKey | null {
  const text = line.trim()
  if (!text) return null

  // `类型|apikey|备注` — at most three fields; a key containing no pipe is
  // handled below, so splitting on "|" here never damages a bare key.
  const parts = text.split('|')
  if (parts.length >= 2) {
    const head = parts[0].trim()
    const rawKey = parts[1].trim()
    const key = findKey(rawKey)
    if (key) {
      return {
        key,
        // A first field is only a type when it carries no key of its own —
        // "XXX-sk-r4xxxx" is one messy key, not a type plus a key.
        preset: findKey(head) ? '' : head,
        note: parts.slice(2).join('|').trim(),
      }
    }
  }

  // No usable delimiter (or the delimiter split produced no key): scan the
  // whole line. "XXX-sk-r4xxxx" lands here and yields the key itself.
  const key = findKey(text)
  if (key) return { key, preset: '', note: '' }

  // Nothing key-shaped. When this line is the *entire* input the user typed
  // into a key box, trust it anyway: a relay that does not authenticate needs
  // a placeholder, and "请粘贴至少一个 key" on a value they typed on purpose
  // is the wrong answer. A multi-line paste does not get this treatment —
  // there, a line that matches nothing really is prose.
  //
  // No length guess here: `local` (5 chars) is a placeholder people genuinely
  // use, and "premium" (7) is a word — length cannot tell them apart, and the
  // single-line context already says the user meant it as a key.
  if (options.wholeInput && SINGLE_TOKEN.test(text)) {
    return { key: text, preset: '', note: '' }
  }
  return null
}

/** Parse a whole textarea. Blank and hopeless lines are dropped. */
export function parseKeyBlock(text: string): ParsedKey[] {
  const lines = text.split(/\r?\n/)
  // The single-line case is the "just let me type a key" case, and it is the
  // only one where a non-key-shaped value is taken at face value.
  const wholeInput = lines.filter((l) => l.trim()).length === 1
  return lines
    .map((l) => parseKeyLine(l, { wholeInput }))
    .filter((p): p is ParsedKey => p !== null && p.key.length > 0)
}
