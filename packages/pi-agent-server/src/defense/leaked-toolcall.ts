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
