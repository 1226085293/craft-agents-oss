/**
 * Leaked tool-call markup helpers (DSML bridge)
 *
 * DeepSeek-class models represent tool calls with special markup tokens
 * (the "DSML" format):
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="read">
 *   <｜DSML｜parameter name="arguments" string="false">{"path": "..."}</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * The OpenAI-compatible layer is supposed to convert those into structured
 * `tool_calls` fields. When it does not (observed after a thinking-level
 * switch on the custom endpoint — 2026-10-04 incident, session
 * 261004-tall-nickel: `deepseek-v4-flash` emitted the raw `｜DSML｜` block as
 * plain text), the DSML bridge (dsml-receiver / dsml-sanitizer) parses the
 * leaked blocks and executes the intended calls natively while the live
 * stream is in flight.
 *
 * NOTE (2026-10-06, user decision): the post-stop defense no longer
 * treats leaked markup as a fault-class stop signal — the session
 * auto-continues on the next user message anyway, so the fault-class
 * kill + terminal "Automatic recovery unavailable" card was removed.
 *
 * NOTE (2026-11-10, session 261110-frosty-cove): some relays strip the
 * `｜DSML｜` special-token marker before the text reaches us, leaving a BARE
 * XML envelope (`<tool_calls><invoke name="bash"><parameter …>`). The parser
 * now recognises that shape too, but ONLY through {@link findBareEnvelope} —
 * a bare envelope is ordinary prose until proven otherwise, so it must sit
 * at the very END of the reply, outside fenced code, and carry arguments.
 */

import { DSML_TAG } from '../../../shared/src/utils/dsml-strip.ts';

/** One intended tool call recovered from a leaked ｜DSML｜ block. */
export interface ParsedLeakedCall {
  /** Intended tool name as emitted by the model (e.g. "read", "bash"). */
  name: string;
  /**
   * Parsed JSON-object arguments. `null` when the arguments parameter is
   * missing or is not a valid JSON object (the call is then reported but
   * NOT executed — executing with fabricated args would be worse).
   */
  args: Record<string, unknown> | null;
  /** Raw arguments text (diagnostics / error reporting). */
  rawArgs: string;
}

export interface ParseLeakedToolCallsOptions {
  /**
   * Also accept the MARKER-LESS variant (2026-11-10). See the note in the
   * module header: this only widens recognition for callers that also apply
   * the end-of-message safety rules ({@link findBareEnvelope}); parsing alone
   * never converts anything.
   */
  allowBare?: boolean;
}

/**
 * Full parser for leaked provider tool-call markup (the DSML format).
 *
 * Extracts each `<｜DSML｜invoke name="X">` block and its `arguments` parameter so the
 * network receiver can synthesize native `tool_calls` when the channel's
 * OpenAI-compatible layer leaked the markup into assistant text; the
 * sanitizer removes only residual markup beside those native calls.
 */
export function parseLeakedToolCalls(
  text: string | null | undefined,
  options?: ParseLeakedToolCallsOptions,
): { leaked: boolean; calls: ParsedLeakedCall[] } {
  const t = text ?? '';
  // Tolerant mode (2026-10-13): providers also emit ASYMMETRIC variants —
  // open tags without the ｜DSML｜ prefix while close tags carry it, or vice
  // versa. When the text contains at least one marker, the prefix on both
  // open and close tags becomes optional; without any marker the strict
  // forms are required, so ordinary XML-like prose is never misparsed.
  const tolerant = t.includes(DSML_TAG);
  const pre = (): string => (tolerant ? '(?:｜DSML｜)?' : '｜DSML｜');
  if (t.length !== 0 && new RegExp(`<${pre()}(tool_calls|invoke)`).test(t)) {
    const calls: ParsedLeakedCall[] = [];
    const blockRe = new RegExp('<' + pre() + 'invoke\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/' + pre() + 'invoke\\s*>', 'g');
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(t)) !== null) {
      const name = m[1] ?? '';
      if (!name) continue;
      const body = m[2] ?? '';
      const argRe = new RegExp('<' + pre() + 'parameter\\s+name="arguments"[^>]*>([\\s\\S]*?)<\\/' + pre() + 'parameter\\s*>');
      const fieldRe = new RegExp('<' + pre() + 'parameter\\s+name="([^"]+)"([^>]*)>([\\s\\S]*?)<\\/' + pre() + 'parameter\\s*>', 'g');
      const am = argRe.exec(body);
      // Clone into fresh regexes: the originals carry `lastIndex` state that
      // must not leak between invokes.
      const { args, rawArgs } = extractArgsFromParams(body, () => new RegExp(fieldRe.source, fieldRe.flags), () => new RegExp(argRe.source, argRe.flags));
      calls.push({ name, args, rawArgs });
    }
    if (calls.length > 0) return { leaked: true, calls };
  }
  if (!options?.allowBare) return { leaked: false, calls: [] };
  // Bare (marker-less) form — separate, strictly-guarded path.
  const bare = findBareEnvelope(t);
  if (!bare || bare.calls.length === 0) return { leaked: false, calls: [] };
  return { leaked: true, calls: bare.calls };
}

/**
 * Collect `name -> value` parameters of one invoke body.
 *
 * Two shapes are supported, matching what providers actually emit:
 *   1. a single `name="arguments"` param holding a JSON object blob;
 *   2. one param per argument (`<parameter name="path" string="true">…`).
 * Shape 2 only fires when shape 1 produced nothing usable, so the single-blob
 * form (and its invalid-JSON failure mode) keeps its existing behavior.
 *
 * `am` is the already-executed match for the `arguments` blob (may be an
 * empty capture group, i.e. present-but-blank → treated as no blob).
 */
function extractArgsFromParams(
  body: string,
  fieldReFactory: () => RegExp,
  argReFactory: () => RegExp,
): { args: Record<string, unknown> | null; rawArgs: string } {
  const rawBlob = (argReFactory().exec(body)?.[1] ?? '').trim();
  let args: Record<string, unknown> | null = null;
  if (rawBlob) {
    try {
      const parsed: unknown = JSON.parse(rawBlob);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = null;
    }
  }
  if (args !== null) return { args, rawArgs: rawBlob };

  // Fallback: per-field params. Note this ALSO collects a non-json `arguments`
  // field verbatim — kept deliberately identical to the original logic.
  const fieldRe = fieldReFactory();
  const fields: Record<string, unknown> = {};
  let fm: RegExpExecArray | null;
  let sawField = false;
  while ((fm = fieldRe.exec(body)) !== null) {
    const fieldName = fm[1] ?? '';
    if (!fieldName) continue;
    sawField = true;
    const attrs = fm[2] ?? '';
    const rawValue = (fm[3] ?? '').trim();
    const isJson = /string\s*=\s*["']false["']/.test(attrs);
    if (isJson) {
      try {
        fields[fieldName] = JSON.parse(rawValue);
      } catch {
        fields[fieldName] = rawValue;
      }
    } else {
      fields[fieldName] = rawValue;
    }
  }
  if (sawField && Object.keys(fields).length > 0) {
    return { args: fields, rawArgs: JSON.stringify(fields) };
  }
  return { args: null, rawArgs: rawBlob };
}

// ============================================================================
// BARE (MARKER-LESS) ENVELOPE
// ============================================================================

/** Where a bare envelope sits in the text and the calls it carries. */
export interface BareEnvelopeMatch {
  /** Start index of the opening tag inside the full text. */
  index: number;
  /** End index (exclusive) of the closing tag + trailing whitespace. */
  end: number;
  calls: ParsedLeakedCall[];
}

/**
 * Locate a bare `<tool_calls>…</tool_calls>` (or `<calls>…</calls>`) envelope
 * at the END of `text`, and parse the invokes inside it.
 *
 * Safety rules (this is the whole point of the guard — a bare XML block is
 * perfectly normal in prose, e.g. docs about this very format):
 *   1. The envelope must CLOSE at the very end of the reply (only whitespace
 *      may follow). A leak is always terminal; a documented example is
 *      usually followed by more explanation.
 *   2. It must not sit inside a fenced code block (``` ... ```), which is how
 *      a model shows such markup as an example rather than intent.
 *   3. Every invoke needs a name and at least one parameter.
 * Callers add further gating (known-tool-name check, dedupe) before executing.
 */
export function findBareEnvelope(text: string): BareEnvelopeMatch | null {
  if (!text) return null;
  const openRe = /<\s*(?:tool_calls|calls)\b[^>\n]*>/gi;
  const closeRe = /<\s*\/\s*(?:tool_calls|calls)\s*>/gi;
  let lastOpen: { index: number; length: number } | null = null;
  let lastClose: { index: number; length: number } | null = null;
  for (const m of text.matchAll(openRe)) {
    if (typeof m.index === 'number') lastOpen = { index: m.index, length: m[0].length };
  }
  for (const m of text.matchAll(closeRe)) {
    if (typeof m.index === 'number') lastClose = { index: m.index, length: m[0].length };
  }
  if (!lastOpen || !lastClose || lastClose.index <= lastOpen.index) return null;
  // Rule 1: tail-anchored (nothing but whitespace after the closer).
  const after = text.slice(lastClose.index + lastClose.length);
  if (after.trim().length > 0) return null;
  const innerStart = lastOpen.index + lastOpen.length;
  const inner = text.slice(innerStart, lastClose.index);
  // Rule 2: not inside a fenced code block.
  const fencesBefore = (text.slice(0, lastOpen.index).match(/```/g) ?? []).length;
  if (fencesBefore % 2 === 1) return null;
  if (inner.includes('```')) return null;
  // Rule 3: parse invokes; every invoke must have ≥1 parameter.
  const invokeRe = /<\s*invoke\b[^>]*?name\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\s*\/\s*invoke\s*>/gi;
  const calls: ParsedLeakedCall[] = [];
  for (const im of inner.matchAll(invokeRe)) {
    const name = im[1] ?? '';
    if (!name) continue;
    const body = im[2] ?? '';
    const paramRe = /<\s*parameter\b[^>]*?name\s*=\s*["']?([^"'\s>]+)["']?([^>]*)>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
    let seenParam = false;
    for (const pm of body.matchAll(new RegExp(paramRe.source, paramRe.flags))) {
      seenParam = true;
      break;
    }
    if (!seenParam) continue;
    const { args, rawArgs } = extractArgsFromParams(body, () => new RegExp(paramRe.source, paramRe.flags), () => new RegExp(paramRe.source, paramRe.flags));
    calls.push({ name, args, rawArgs });
  }
  if (calls.length === 0) return null;
  return { index: lastOpen.index, end: lastClose.index + lastClose.length, calls };
}

/**
 * Remove a bare envelope found by {@link findBareEnvelope} from `text`.
 * Used by the sanitizer once the receiver has actually executed the same
 * calls, so the raw markup never lands in the transcript.
 */
export function stripBareEnvelope(text: string): string {
  const found = findBareEnvelope(text);
  if (!found) return text;
  const head = text.slice(0, found.index);
  const tail = text.slice(found.end);
  return (head.replace(/[\n\r]+$/, '') + (tail.trim().length > 0 ? '\n' + tail.trim() : '')).trim();
}

/**
 * Replace every leaked ｜DSML｜ invoke block in `text` with the given marker
 * strings (aligned in block order; blocks beyond `markers.length` are
 * stripped bare) and drop the wrapping ｜DSML｜tool_calls markers, leaving
 * the surrounding prose intact. Used by the DSML bridge to keep user-facing
 * assistant bubbles free of raw provider markup after executing the calls.
 */
export function cleanLeakedBlocks(text: string, markers: string[]): string {
  if (text.length === 0 || !/<｜DSML｜/.test(text)) return text;
  let out = text;
  let mi = 0;
  out = out.replace(
    /<｜DSML｜invoke\s+name="([^"]+)"[^>]*>[\s\S]*?<\/｜DSML｜invoke\s*>/g,
    () => {
      const m = markers[mi] ?? '';
      mi++;
      return m;
    },
  );
  out = out.replace(/<\/?｜DSML｜tool_calls\s*>/g, '');
  return out.replace(/[\n\r]+$/, '');
}
