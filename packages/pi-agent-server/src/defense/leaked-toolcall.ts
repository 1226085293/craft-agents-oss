/**
 * Leaked tool-call detection
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
 * plain text), the intended tool call never executes and the assistant
 * "final reply" is just the leaked markup. The post-stop defense layer must
 * recognize that shape: it is a fault-class signal (no valid final reply
 * exists to verify) whose resume instructs the model to re-issue the call.
 */

/**
 * Scan an assistant text reply for leaked provider tool-call markup.
 *
 * Returns `leaked: true` when the text contains a DSML tool-call block
 * (`｜DSML｜invoke` / `｜DSML｜tool_calls`). Plain text that merely MENTIONS
 * the markers without an invoke/tool_calls block is not treated as a leak.
 * `callNames` lists the intended tool names (e.g. ["read"]) so the resume
 * message can name them.
 */
export function detectLeakedToolCall(text: string): { leaked: boolean; callNames: string[] } {
  const t = text ?? '';
  if (t.length === 0) return { leaked: false, callNames: [] };

  const hasMarker = /｜DSML｜/.test(t);
  const hasBlock = /<｜DSML｜(tool_calls|invoke)/.test(t);
  if (!hasMarker || !hasBlock) return { leaked: false, callNames: [] };

  const callNames: string[] = [];
  const invokeRe = /<｜DSML｜invoke name="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(t)) !== null) {
    const name = m[1] ?? '';
    if (name && !callNames.includes(name)) callNames.push(name);
  }
  return { leaked: true, callNames };
}

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
 * `detectLeakedToolCall` is the cheap detector; this extracts each
 * `<｜DSML｜invoke name="X">` block and its `arguments` parameter so the DSML
 * bridge (dsml-bridge.ts) can EXECUTE the intended calls when the channel's
 * OpenAI-compat layer failed to emit structured `tool_calls`.
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
    const rawArgs = (am?.[1] ?? '').trim();
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
    calls.push({ name, args, rawArgs });
  }
  return { leaked: calls.length > 0, calls };
}
