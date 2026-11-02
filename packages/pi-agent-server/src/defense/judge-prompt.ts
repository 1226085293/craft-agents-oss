/**
 * Program-side verification judge prompt (pure builder, no side effects).
 *
 * Output contract (user-confirmed 2026-10-17): the judge must give a
 * MACHINE-READABLE verdict plus a human reason, so the process block can
 * show `校验失败（<类型>）— 继续执行` and the full reason is one click away.
 *
 *   PASS                                  → reply delivers
 *   FAIL|<类型>|<原因，一句，<=200字>       → follow up + show reason
 *
 * Single-line `|` format (not JSON): a flash-grade model emitting invalid
 * JSON is common, and our FAIL-safe parser then treats every malformed
 * verdict as FAIL — indistinguishable from the judge being down. A single
 * line is far more robust and one regex parses it.
 *
 * Input model (user spec 2026-11-01, quiet-jasmine incident):
 * - CURRENT TURN user message + its mid-turn guidance = the ONLY requirement.
 * - Up to three PREVIOUS turns, explicitly labelled reference-only. They exist
 *   so the judge can resolve back-references ("那个方案", "继续", "上一轮说的")
 *   without ever demanding a previous turn's item again. Pre-2026-11-01 the
 *   judge was fed a single flat string read from the rolling progress ledger;
 *   when that ledger rotated away the current turn's request it silently fell
 *   back to the previous turn's and rejected two correct replies for "not
 *   covering" an item that had already been delivered a turn earlier.
 * - The candidate FINAL REPLY.
 *
 * History:
 * - 2026-10-14 (261013-mild-stream second layer): the single-paragraph
 *   instruction let a reply whose MAIN BODY was meta-narration about its own
 *   delivery ("我上一轮的最终回复已经完整交付了原请求……现在补充……") sail
 *   through; it was replayed verbatim as THE final reply, so the user
 *   received a reply ABOUT the previous reply. The RULE list fixed that
 *   incident (measured 50% → 100% on incident text).
 * - 2026-10-17: user removed meta-narration as a FAILURE TYPE — delivering
 *   the answer IS the job, and a "here is what I did" summary is a legitimate
 *   delivery. RULE 1 now only rejects a reply that is *about* a previous
 *   reply rather than being the answer itself (the 261013 incident shape),
 *   never a summary that contains results.
 * - 2026-11-01: RULE 0 added — only the current turn is a requirement; the
 *   history block is reference material and must never seat a "missing item"
 *   verdict.
 *
 * Types are stable slugs; the UI maps them to i18n text, so do not rename
 * without updating the locale table.
 */

/** Machine-readable failure types. Slugs are stable — i18n maps these. */
export const JUDGE_FAIL_TYPE = {
  /** Multi-step request partially completed then stopped to ask. */
  INCOMPLETE: 'incomplete',
  /** Answer does not address the user's request. */
  OFF_TOPIC: 'off-topic',
  /** Reply cut off / stops mid-sentence. */
  TRUNCATED: 'truncated',
  /** Anything else worth recording verbatim. */
  OTHER: 'other',
} as const

export type JudgeFailType = (typeof JUDGE_FAIL_TYPE)[keyof typeof JUDGE_FAIL_TYPE]

/** Reason budget — keeps the on-screen line readable, full text goes to disk. */
export const JUDGE_REASON_MAX_CHARS = 200

/** A previous turn, included for reference only. */
export interface JudgeHistoryTurn {
  /** The turn's user messages in order (opening request, then mid-turn guidance). */
  messages: JudgeTurnEntry[]
  /** The reply that turn delivered. */
  reply?: JudgeTurnEntry
}

/** One rendered line of user-side or assistant-side text. */
export interface JudgeTurnEntry {
  /** ISO timestamp of the message; rendered in local time when present. */
  at?: string
  text: string
  /** True for mid-turn guidance (a steer inside the same turn). */
  guidance?: boolean
}

/** Everything the judge may treat as "what the user wants". */
export interface JudgeTurnContext {
  /**
   * CURRENT turn: the opening user message followed by every mid-turn
   * guidance message, in order. This list — and only this list — defines what
   * must be delivered.
   */
  current: JudgeTurnEntry[]
  /** PREVIOUS turns, oldest → newest. Reference only. */
  history?: JudgeHistoryTurn[]
}

/**
 * Budgets.
 *
 * The CURRENT turn is the ground truth, so it is protected differently from
 * the reference history: entries are never dropped (a dropped mid-turn steer
 * can be exactly the requirement the judge would then call "missing"), and a
 * per-entry cap only applies when the whole turn exceeds a total budget.
 * Measured on 3,059 real user messages: p99 = 3,748 chars, max = 16,513, so
 * 8k/entry keeps ~99.9% of messages intact; the total budget then bounds a
 * pathological turn without ever losing a whole line.
 * The candidate reply is never truncated (a cut reply reads as "truncated" —
 * the 2026-10-26 vital-crane incident).
 */
const MAX_CURRENT_ENTRY_CHARS = 8_000
const MIN_CURRENT_ENTRY_CHARS = 400
const MAX_CURRENT_TOTAL_CHARS = 24_000
const MAX_CURRENT_ENTRIES = 40
const MAX_HISTORY_ENTRY_CHARS = 600
const MAX_HISTORY_ENTRIES = 4
const MAX_HISTORY_REPLY_CHARS = 800

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…(truncated)`
}

/** Local wall-clock stamp, e.g. `2026-11-01 03:11:27`. */
function formatStamp(at: string | undefined): string {
  if (!at) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** Render one entry as `2026-11-01 03:11:27 · text` (stamp omitted when absent). */
function renderEntry(entry: JudgeTurnEntry, max: number): string {
  const stamp = formatStamp(entry.at)
  const body = truncate(entry.text ?? '', max)
  const lines = stamp ? body.split('\n').map((line, index) => (index === 0 ? `${stamp} · ${line}` : `  ${line}`)) : body.split('\n')
  return lines.join('\n')
}

function renderEntries(entries: JudgeTurnEntry[] | undefined, maxChars: number, maxEntries: number): string[] {
  if (!entries || entries.length === 0) return []
  const kept = entries.length <= maxEntries
    ? entries
    : [entries[0]!, ...entries.slice(entries.length - (maxEntries - 1))]
  return kept.map((entry) => renderEntry(entry, maxChars))
}

/**
 * Render the current turn without ever dropping a message.
 *
 * `truncated` is true when any line was cut, so the caller can tell the judge
 * that a cut is a rendering limit rather than the user retracting something.
 */
function renderCurrentEntries(entries: JudgeTurnEntry[] | undefined): { lines: string[]; truncated: boolean } {
  if (!entries || entries.length === 0) return { lines: [], truncated: false }
  const kept = entries.length <= MAX_CURRENT_ENTRIES
    ? entries
    : [entries[0]!, ...entries.slice(entries.length - (MAX_CURRENT_ENTRIES - 1))]
  const totalChars = kept.reduce((sum, entry) => sum + (entry.text?.length ?? 0), 0)
  const perEntry = totalChars > MAX_CURRENT_TOTAL_CHARS
    ? Math.max(MIN_CURRENT_ENTRY_CHARS, Math.floor(MAX_CURRENT_TOTAL_CHARS / kept.length))
    : MAX_CURRENT_ENTRY_CHARS
  const truncated = kept.some((entry) => (entry.text?.length ?? 0) > perEntry) || kept.length < entries.length
  return { lines: kept.map((entry) => renderEntry(entry, perEntry)), truncated }
}

function renderHistory(history: JudgeHistoryTurn[] | undefined): string[] {
  if (!history || history.length === 0) return []
  const blocks: string[] = []
  let truncated = false
  history.forEach((turn, index) => {
    const offset = index - history.length // -1 = immediately previous turn
    const messages = turn.messages ?? []
    if (messages.length > MAX_HISTORY_ENTRIES) truncated = true
    if (messages.some((entry) => (entry.text?.length ?? 0) > MAX_HISTORY_ENTRY_CHARS)) truncated = true
    if ((turn.reply?.text.length ?? 0) > MAX_HISTORY_REPLY_CHARS) truncated = true
    blocks.push(`<turn n="${offset}">`)
    blocks.push('<user>')
    blocks.push(...renderEntries(messages, MAX_HISTORY_ENTRY_CHARS, MAX_HISTORY_ENTRIES))
    blocks.push('</user>')
    if (turn.reply && turn.reply.text.trim()) {
      blocks.push('<result>')
      blocks.push(renderEntry(turn.reply, MAX_HISTORY_REPLY_CHARS))
      blocks.push('</result>')
    }
    blocks.push('</turn>')
  })
  // Reference-only material: a short marker is enough, it can never be a
  // requirement (RULE 0).
  if (truncated) blocks.push('<note>History above is abbreviated for length; it is reference only.</note>')
  return blocks
}

function normalizeContext(context: string | JudgeTurnContext): JudgeTurnContext {
  // Backwards-compatible: a bare string is a current turn with no extras.
  return typeof context === 'string' ? { current: [{ text: context }] } : context
}

export function buildVerificationJudgePrompt(
  context: string | JudgeTurnContext,
  candidate: string,
  candidateAt?: string,
): string {
  const ctx = normalizeContext(context)
  const current = renderCurrentEntries(ctx.current)
  const currentLines = current.lines
  const historyLines = renderHistory(ctx.history)
  const replyText = renderEntry({ at: candidateAt, text: candidate }, Number.MAX_SAFE_INTEGER)
  const truncationNote = current.truncated
    ? `\n<note>Some CURRENT TURN text above is marked "(truncated)" — that is a rendering limit of the judge, NOT the user withdrawing a requirement. Judge only what is visible, and if you cannot tell whether a cut-off part was addressed, PASS.</note>`
    : ''

  return `[Defense verification] Judge whether the assistant's FINAL REPLY is a valid, complete answer to the CURRENT TURN's user messages. This judgment gates program-side verification delivery.

ANSWER FORMAT — exactly one line, no prose around it:
- If the reply is valid:  PASS
- If it is not:            FAIL|<type>|<one short reason>

<type> MUST be one of: incomplete, off-topic, truncated, other
Rules for the reason: at most ${JUDGE_REASON_MAX_CHARS} characters, concrete and specific (name the step that is missing or what the reply fails to address), no filler.

JUDGING RULES:
RULE 0 — ONLY the CURRENT TURN states what must be delivered. Its user messages are listed in order: the first line is the opening request, later lines are mid-turn guidance the user added while the turn was running — guidance refines, corrects or overrides the earlier lines, and every line is part of this turn's requirement. PREVIOUS TURNS are reference material, NOT requirements: never return FAIL because the reply does not (re-)cover an item raised in a previous turn, and never treat a previous turn's open question as this turn's task. History is there for ONE purpose — understanding what the user is referring to ("那个方案", "continue", "上一轮说的那两处") when the current message is a follow-up. An item moves into scope ONLY when a current-turn line asks about it (continues, re-opens, or names it).
RULE 1 — The reply must BE the answer, not a message about a previous reply. INVALID only when the reply refers to earlier delivery instead of answering now (e.g. "我上一轮的回复已经交付，现在仅作补充", "my previous reply already delivered this; this only adds ...", "其余内容维持原样", "上一版已给出"). A reply that reports what IT did in this turn — including a plain "done, here is what I did" summary with concrete results — is a valid answer and MUST PASS.
RULE 2 — When the CURRENT TURN asked for MULTIPLE things (numbered steps, a list, "do X, Y and Z", or mid-turn guidance adding items), the reply is INVALID (type: incomplete) if it finishes only some and then stops to ask whether to continue. EXCEPTION: the remaining items are explicitly blocked (missing permission, missing information, upstream failure) AND the reply says so — that is a valid stop, PASS.
RULE 3 — INVALID (type: off-topic) if the reply does not address the current turn's request, is a clear refusal, or is factually empty.
RULE 4 — INVALID (type: truncated) if the reply stops mid-sentence or is otherwise incomplete.

When in doubt, PASS — a wrongly blocked reply costs the user a round trip, a wrongly delivered one costs the same.

CURRENT TURN — WHAT THE USER ASKED NOW (the only requirement for this judgment; one line per user message, in order, later lines being mid-turn guidance):
<user>
${currentLines.join('\n')}
</user>${truncationNote}${historyLines.length > 0 ? `

PREVIOUS TURNS — REFERENCE ONLY (context for what the user is referring to, NOT requirements; see RULE 0):\n<history>\n${historyLines.join('\n')}\n</history>` : ''}

FINAL REPLY (assistant, last message in the current turn — the candidate being judged):
<reply>
${replyText}
</reply>

Answer with exactly one line (PASS or FAIL|<type>|<reason>).`;
}

/** Test/verification helper: the exact single-line format we expect back. */
export const JUDGE_PASS_TOKEN = 'PASS' as const
