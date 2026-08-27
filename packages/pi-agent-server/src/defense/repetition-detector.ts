/**
 * Repetition-loop (degeneration) detector
 *
 * Catches the failure mode where the model's final reply devolves into a
 * degenerate repetition loop — e.g. the 2026-08-28 incident where a session
 * produced a 213,508-char reply whose second half was 874 identical copies of
 * one sentence (115K chars, 54.3% of the whole). Such a reply carries
 * "visible text", so it sails past empty-terminal-response and silent-stop
 * detection and is classified as a normal completion.
 *
 * Detection is deliberately CONSERVATIVE to avoid false positives on healthy
 * long replies (code dumps, tables, verbatim quoting, prose with recurring
 * idioms):
 *  - only substantial outputs (>= MIN_TEXT_LENGTH chars) are judged;
 *  - only repeated units >= MIN_UNIT_LENGTH chars count (short structural
 *    lines like `});` or `- foo` are ignored);
 *  - a loop requires a large fraction (>= REPEAT_RATIO) of the sampled
 *    content to be exact duplicates;
 *  - Strategy A (whole-text line level) is a cheap early exit for pure
 *    newline-delimited loops;
 *  - Strategy B (tail-weighted sliding windows) is the key sensitivity fix:
 *    degeneration is POSITIONAL — models loop at the END of a reply. The
 *    incident's whole-text duplicate share was only 0.559 (healthy first half
 *    diluted it below any sane global threshold), but the last 50% was 0.986
 *    repeats. Judging only the tail catches "half work, half loop" replies
 *    that a whole-text ratio misses, with no extra false-positive surface on
 *    healthy tails (a recurring idiom inside unique prose stays far below the
 *    ratio because the surrounding unique content dominates the sample).
 */

const MIN_TEXT_LENGTH = 1500; // degenerate loops are long; shorter replies are too risky to judge
const MIN_UNIT_LENGTH = 40; // repeated units must be substantial phrases, not 2-3 word fragments
const MIN_SUBSTANTIAL_UNITS = 10; // need enough units to establish a pattern
const REPEAT_RATIO = 0.6; // >60% of sampled content duplicated → loop
const CHUNK_SIZE = 100; // sliding-window size for boundary-agnostic detection
// Stride 1 (every position). A larger fixed stride can be coprime with the
// loop's period (e.g. a 123-char phrase sampled every 20 chars lands on a
// fresh phase each time and looks unique), silently missing a pure loop.
// Stride 1 is O(N) but cheap in practice: a 100K-char tail yields ~100K
// windows that hash to only a handful of unique keys (~35ms), and healthy
// prose still stays far below the ratio.
const TAIL_FRACTION = 0.5; // Strategy B judges only the last half of the reply
const TAIL_MIN_CHARS = 1000; // the tail must itself be substantial

/**
 * Compute the duplicate-character share of an array of units.
 * Returns a ratio in [0, 1]; 1.0 means every substantial unit is a repeat.
 */
function duplicateShare(units: string[]): number {
  const seen = new Set<string>();
  let dupChars = 0;
  let total = 0;
  for (const unit of units) {
    if (unit.length < MIN_UNIT_LENGTH) continue;
    total += unit.length;
    if (seen.has(unit)) dupChars += unit.length;
    else seen.add(unit);
  }
  return total > 0 ? dupChars / total : 0;
}

/**
 * Sample fixed-size sliding windows over `region` and return the share of
 * windows that are exact repeats of an earlier window. Boundary-agnostic —
 * works regardless of line/sentence structure.
 */
function duplicateWindowShare(region: string): number {
  const counts = new Map<string, number>();
  let sampled = 0;
  for (let i = 0; i + CHUNK_SIZE <= region.length; i += 1) {
    const chunk = region.slice(i, i + CHUNK_SIZE);
    counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
    sampled++;
  }
  if (sampled < MIN_SUBSTANTIAL_UNITS) return 0;
  let dupCount = 0;
  for (const c of counts.values()) {
    if (c > 1) dupCount += c;
  }
  return dupCount / sampled;
}

/**
 * Detect whether `text` looks like a degenerate repetition loop.
 * Returns false for anything below the length floor or below the repeat
 * ratio — healthy long outputs must never trip this.
 */
export function detectRepetitionLoop(text: string): boolean {
  if (text.length < MIN_TEXT_LENGTH) return false;

  // Strategy A — line-level over the WHOLE text: pure loops where the model
  // repeats whole lines (the incident's tail, or a reply that is entirely a
  // loop). Only ~3 repeats of a long phrase amid sparse content already
  // exceeds the 0.6 share, so this is not as lenient as it sounds.
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const substantialLines = lines.filter((l) => l.length >= MIN_UNIT_LENGTH);
  if (substantialLines.length >= MIN_SUBSTANTIAL_UNITS) {
    if (duplicateShare(substantialLines) >= REPEAT_RATIO) return true;
  }

  // Strategy B — tail-weighted sliding windows: judge only the LAST half of
  // the reply. Degeneration happens at the end; a healthy prefix must not
  // dilute the signal (the 2026-08-28 incident: whole-text share 0.559
  // missed, tail share 0.986 caught).
  const tail = text.slice(Math.floor(text.length * (1 - TAIL_FRACTION)));
  if (tail.length < TAIL_MIN_CHARS) return false;
  return duplicateWindowShare(tail) >= REPEAT_RATIO;
}

/**
 * Extract the plain text of an assistant message's content blocks.
 * Defensive: handles both the array-of-blocks shape (text/thinking/toolCall)
 * and a raw string fallback. Empty string when there is nothing to extract.
 */
export function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => (c as { type?: string })?.type === 'text')
    .map((c) => String((c as { text?: unknown })?.text ?? ''))
    .join('\n');
}
