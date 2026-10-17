/**
 * Judge verdict parser (pure).
 *
 * Parses the single-line contract from buildVerificationJudgePrompt:
 *
 *   PASS
 *   FAIL|<type>|<reason>
 *
 * Deliberately not JSON. A flash-grade model that emits malformed JSON would
 * (under the old `^PASS` check) be indistinguishable from the judge being
 * down — every malformed verdict looked like a FAIL. The pipe format is one
 * regex away from parseable, and an unknown type degrades to `other` WITH the
 * raw text preserved as the reason, so nothing is silently lost.
 *
 * i18n: `type` is a stable slug; the renderer maps it through the locale
 * table. `reason` is model-produced text shown verbatim on the detail view.
 */

import { JUDGE_FAIL_TYPE, JUDGE_REASON_MAX_CHARS, type JudgeFailType } from './judge-prompt.ts'

export type JudgeVerdict =
  | { pass: true }
  | { pass: false; type: JudgeFailType; reason: string }

/** Known slugs, for validating an unrecognised one back to `other`. */
const KNOWN_TYPES = new Set<string>(Object.values(JUDGE_FAIL_TYPE))

/**
 * Parse one judge reply.
 *
 * - Whitespace/prose padding is tolerated (first PASS/FAIL line wins).
 * - `FAIL` with no pipe → type `other`, empty reason (structure unknown).
 * - Unknown type → `other`, and the original type text is folded into the
 *   reason so the operator can still see what the model said.
 * - Reason is trimmed to the budget; the full text is persisted separately.
 */
export function parseJudgeVerdict(raw: string | null | undefined): JudgeVerdict {
  const text = (raw ?? '').trim()
  if (!text) return { pass: false, type: JUDGE_FAIL_TYPE.OTHER, reason: '' }

  // Take the first line that CONTAINS a leading-ish PASS/FAIL token —
  // models sometimes prepend filler ("The verdict is: PASS").
  const line = text
    .split('\n')
    .map(l => l.trim())
    .find(l => /(^|\b)(PASS|FAIL)\b/i.test(l) && /\b(PASS|FAIL)\b/.test(l))
    ?? text

  // Isolate from the first PASS/FAIL token onward so filler before it is gone.
  const tokenMatch = /\b(PASS|FAIL)\b(.*)$/is.exec(line)
  const token = tokenMatch ? tokenMatch[1]!.toUpperCase() : ''
  const rest = tokenMatch ? tokenMatch[2]! : line
  if (token === 'PASS') return { pass: true }
  if (token !== 'FAIL') {
    // No recognizable verdict at all — treat as a FAIL with the raw text.
    return { pass: false, type: JUDGE_FAIL_TYPE.OTHER, reason: line.slice(0, JUDGE_REASON_MAX_CHARS) }
  }

  // FAIL|<type>|<reason...> — reason may itself contain pipes.
  const body = rest.replace(/^\s*\|?\s*/, '').trim()
  if (!body) return { pass: false, type: JUDGE_FAIL_TYPE.OTHER, reason: '' }

  const pipe = body.indexOf('|')
  if (pipe < 0) {
    // "FAIL" alone or "FAIL <text>" without the pipe structure.
    return { pass: false, type: JUDGE_FAIL_TYPE.OTHER, reason: body.slice(0, JUDGE_REASON_MAX_CHARS) }
  }

  const rawType = body.slice(0, pipe).trim()
  const reason = body.slice(pipe + 1).trim()
  if (KNOWN_TYPES.has(rawType)) {
    return { pass: false, type: rawType as JudgeFailType, reason }
  }
  // Unknown slug: keep the model's words, classify as `other`.
  return { pass: false, type: JUDGE_FAIL_TYPE.OTHER, reason: reason || rawType }
}
