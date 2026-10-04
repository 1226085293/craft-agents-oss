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
 */

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
): { leaked: boolean; calls: ParsedLeakedCall[] } {
  const t = text ?? '';
  if (t.length === 0 || !/<｜DSML｜(tool_calls|invoke)/.test(t)) {
    return { leaked: false, calls: [] };
  }
  const calls: ParsedLeakedCall[] = [];
  const blockRe = /<｜DSML｜invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜DSML｜invoke\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(t)) !== null) {
    const name = m[1] ?? '';
    if (!name) continue;
    const body = m[2] ?? '';
    const argRe = /<｜DSML｜parameter\s+name="arguments"[^>]*>([\s\S]*?)<\/｜DSML｜parameter\s*>/;
    const am = argRe.exec(body);
    let rawArgs = (am?.[1] ?? '').trim();
    let args: Record<string, unknown> | null = null;
    if (rawArgs) {
      try {
        const parsed: unknown = JSON.parse(rawArgs);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = null;
      }
    }
    // Fallback: some models emit each argument as its own <parameter> tag
    // (e.g. <parameter name="path" string="true">…</parameter>) instead of a
    // single name="arguments" JSON blob. Collect those fields into an args
    // object. Only fires when no `arguments` parameter produced a usable
    // object, so the single-blob form (and its invalid-JSON failure mode)
    // keeps its existing behavior.
    if (args === null) {
      const fieldRe = /<｜DSML｜parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/｜DSML｜parameter\s*>/g;
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
        args = fields;
        rawArgs = JSON.stringify(fields);
      }
    }
    calls.push({ name, args, rawArgs });
  }
  return { leaked: calls.length > 0, calls };
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
