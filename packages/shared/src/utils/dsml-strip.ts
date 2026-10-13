/**
 * dsml-strip.ts
 *
 * Final-mile DSML leakage scrubber (2026-10-13).
 *
 * The DSML bridge (dsml-receiver / dsml-sanitizer, pi-agent-server) assumes
 * leaked blocks have a COMPLETE structure (`<＼DSML＼invoke name="...">`),
 * but providers (DeepSeek-family via openai-completions channels) also emit
 * MALFORMED variants — asymmetric tags (open tag without the ＼DSML＼ prefix,
 * closing tag with it), missing `<＼DSML＼invoke>` openers, stray
 * `<parameter>` clusters. Those variants defeat every regex in the bridge
 * and reach the user as raw markup.
 *
 * This module is the last line of defense: it strips residual DSML markup
 * from ANY text that carries the marker, regardless of structure, so a
 * delivered reply can never contain leaked tool-call markup. It lives in
 * shared because the main-process delivery path (pi-agent.ts verification
 * replay) needs it — pi-agent-server (which imports shared, not vice
 * versa) also uses it for the sanitizer fallback.
 *
 * Safety: scrubbing only fires when the text contains the full marker
 * sequence `＼DSML＼` (U+FF5C + "DSML" + U+FF5C). That sequence does not
 * occur in normal prose, so non-leaked text is never touched.
 */

/** The full DSML tag-prefix marker as emitted by leaking providers. */
export const DSML_TAG = '\uFF5CDSML\uFF5C';

/** True when the text carries the DSML leak marker (U+FF5C-wrapped "DSML"). */
export function containsDsmlMarkup(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.includes(DSML_TAG);
}

/**
 * Strip residual DSML leak markup from `text`. Idempotent; returns the
 * input unchanged when no marker is present.
 *
 * Steps (order matters):
 * 1. Normalize: drop every `＼DSML＼` prefix so `</＼DSML＼parameter>` becomes
 *    `</parameter>` — both prefixed and unprefixed tag shapes now match.
 * 2. Drop `<parameter ...>...</parameter>` argument clusters (may span lines).
 * 3. Drop stray `<invoke>` / `<tool_calls>` open/close tags.
 * 4. Collapse the leftover blank lines and trim.
 */
export function stripDsmlResidue(text: string): string {
  if (!containsDsmlMarkup(text)) return text;
  let out = text.split(DSML_TAG).join('');
  // Argument clusters: `<parameter name="...">value</parameter>` (non-greedy, may span lines).
  out = out.replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter\s*>/g, '');
  // Stray invoke / tool_calls wrappers left after normalization.
  out = out.replace(/<\/?(?:invoke|tool_calls)\b[^>]*>/g, '');
  // Collapse blank lines left by the removals, then trim.
  out = out.replace(/[ \t]*\n{2,}/g, '\n').trim();
  return out;
}