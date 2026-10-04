/**
 * DSML bridge — execute leaked provider tool-calls on the model's behalf
 *
 * Some OpenAI-compatible channels (observed: deepseek-v4-flash via
 * discovery-api.intern-ai.org.cn, 2026-10-04) return provider-native
 * `｜DSML｜` tool-call markup INSIDE the content field instead of structured
 * `tool_calls`. The model's intended calls never execute, and asking it to
 * "re-issue them as real tool calls" (the plain defense-resume path) just
 * re-leaks — the channel keeps producing the literal markup, the resume cap
 * burns, and the session ends in `state=failed` with the task unfinished.
 *
 * The bridge runs inside the Pi SDK extension runtime (`message_end` hook,
 * one ctx per emit). When an assistant message carries a leaked ｜DSML｜
 * block AND no structured toolCall content, it:
 *
 *   1. parses the intended calls (parseLeakedToolCalls),
 *   2. EXECUTES each one through the same wrapped tool definitions the
 *      agent loop uses — so the full guard stack still applies (loop
 *      guard, empty-args guard, pre-tool-use approval, metadata strip),
 *   3. queues a result report as a followUp user message so the
 *      continuation turn receives the evidence and continues from it.
 *
 * The post-stop defense layer deduplicates against `bridgeHandledSig()`:
 * when the bridge handled a stop's leaked text, its resume note points at
 * the executed results instead of demanding another (re-leaking) re-issue.
 *
 * Safety limits:
 *   - at most MAX_CALLS_PER_MESSAGE executions per message,
 *   - calls with unparseable arguments are reported, never guessed,
 *   - unknown tool names are skipped,
 *   - the whole handler is fault-isolated: any error logs and leaves the
 *     plain defense path (followUp resume) intact as fallback.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  MessageEndEvent,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { parseLeakedToolCalls, cleanLeakedBlocks } from './leaked-toolcall.ts';

/** Structural stand-in for the SDK's MessageEndEventResult (not re-exported
 * from the package root). `message` carries the replacement AgentMessage. */
type MessageEndResult = { message: unknown };

export const MAX_CALLS_PER_MESSAGE = 4;
const MAX_RESULT_CHARS = 1500;

export interface DsmlBridgeDeps {
  /** Current session's wrapped tool definitions (the ones with the full
   *  Craft guard stack — same objects passed to the SDK as customTools). */
  getToolDefinitions: () => ToolDefinition<any, any>[];
  debugLog: (msg: string) => void;
}

// --- Bridge state (session-scoped: pi-agent-server is one session per
// process; reset between sessions) --------------------------------------

let lastHandledSig: string | null = null;
let seq = 0;

/** Cheap deterministic signature of a final text (length + tail). */
export function finalTextSig(text: string | null | undefined): string {
  const t = text ?? '';
  return `${t.length}:${t.slice(-160)}`;
}

/** Signature of the last message whose leaked calls the bridge executed. */
export function bridgeHandledSig(): string | null {
  return lastHandledSig;
}

/** Test helper. */
export function resetBridgeStateForTest(): void {
  lastHandledSig = null;
  seq = 0;
}

// --- Extension ----------------------------------------------------------

export function createDsmlBridgeExtension(deps: DsmlBridgeDeps): InlineExtension {
  return {
    name: 'craft-dsml-bridge',
    hidden: true,
    factory: (api: ExtensionAPI) => {
      const handler = async (event: MessageEndEvent, ctx: ExtensionContext) => {
        try {
          const r = await handleMessageEnd(event, ctx, api, deps);
          return r as MessageEndResult | undefined;
        } catch (e) {
          // Fault isolation: the plain defense-resume path remains the fallback.
          deps.debugLog(
            `[dsml-bridge] handler error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`,
          );
          return undefined;
        }
      };
      // The SDK's MessageEndEventResult (replacement message) type is not
      // re-exported from the package root; `never` is assignable to the
      // expected handler type, so the cast is checked at the factory boundary.
      api.on('message_end', handler as unknown as never);
    },
  };
}

interface BridgeResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

async function handleMessageEnd(
  event: MessageEndEvent,
  ctx: ExtensionContext,
  api: ExtensionAPI,
  deps: DsmlBridgeDeps,
): Promise<MessageEndResult | undefined> {
  const msg = event.message as unknown as {
    role?: string;
    content?: Array<Record<string, unknown>>;
  };
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return;

  // Healthy channel: structured toolCall blocks exist — any ｜DSML｜ text in
  // the message is cosmetic; never second-guess a real tool-call stream.
  if (msg.content.some((b) => b && b.type === 'toolCall')) return;

  const text = msg.content
    .filter((b) => b && b.type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? ''))
    .join('');

  const { calls } = parseLeakedToolCalls(text);
  if (calls.length === 0) return;

  // Resolve intended names against the session's own tool definitions.
  const defs = deps.getToolDefinitions();
  const byName = new Map<string, ToolDefinition<any, any>>();
  for (const d of defs) {
    byName.set(String(d.name).toLowerCase(), d);
    const label = (d as unknown as { label?: string }).label;
    if (label) byName.set(String(label).toLowerCase(), d);
  }

  const results: string[] = [];
  const markers: string[] = [];
  let executed = 0;
  const capped = calls.slice(0, MAX_CALLS_PER_MESSAGE);
  for (const call of capped) {
    const def = byName.get(call.name.toLowerCase());
    if (!def) {
      results.push(`• ${call.name} — skipped (unknown tool in this session)`);
      markers.push(`(工具调用 ${call.name}：未知工具，已跳过)`);
      continue;
    }
    const callId = `dsml-bridge-${++seq}`;
    try {
      const r = await (
        def.execute as unknown as (
          toolCallId: string,
          params: Record<string, unknown>,
          signal: AbortSignal | undefined,
          onUpdate: undefined,
          ctx: ExtensionContext,
        ) => Promise<BridgeResult>
      )(callId, call.args ?? {}, ctx?.signal ?? undefined, undefined, ctx);
      executed++;
      const txt = (r?.content ?? [])
        .filter((c) => c?.type === 'text')
        .map((c) => String(c?.text ?? ''))
        .join('');
      results.push(
        `• ${call.name} — ${r?.isError ? 'ERROR: ' : ''}${(txt || '(no output)').slice(0, MAX_RESULT_CHARS)}`,
      );
      markers.push(
        r?.isError
          ? `(工具调用 ${call.name}：Craft 已代执行，返回错误，结果见后续消息)`
          : `(工具调用 ${call.name}：Craft 已代执行，结果见后续消息)`,
      );
    } catch (e) {
      executed++;
      results.push(
        `• ${call.name} — ERROR: ${String((e as Error)?.message ?? e).slice(0, 500)}`,
      );
      markers.push(`(工具调用 ${call.name}：Craft 代执行失败，结果见后续消息)`);
    }
  }
  if (calls.length > capped.length) {
    results.push(
      `• … ${calls.length - capped.length} more call(s) not executed (cap ${MAX_CALLS_PER_MESSAGE} per message)`,
    );
  }

  if (executed === 0) {
    // Nothing resolvable/executable — leave delivery to the plain defense
    // resume path (it names the intended calls for the model to re-issue).
    deps.debugLog(
      `[dsml-bridge] ${calls.length} leaked call(s) found but none executable; leaving delivery to defense resume`,
    );
    return;
  }

  lastHandledSig = finalTextSig(text);
  const report = [
    '[DSML Bridge] The tool calls in the model reply above were emitted as literal ｜DSML｜ text because this channel does not return structured tool_calls. Craft executed them for you:',
    ...results,
    'Continue the task from these execution results. Do NOT re-emit ｜DSML｜ literal blocks.',
  ].join('\n');
  await api.sendUserMessage(report, { deliverAs: 'followUp' });
  deps.debugLog(
    `[dsml-bridge] executed ${executed}/${capped.length} leaked call(s) (${calls.length} found); result report queued as followUp; final message sanitized`,
  );

  // Replace the finalized message IN PLACE (the SDK normalizes this into
  // agent state + session history + all downstream subscribers), so the UI
  // shows the surrounding prose with a short execution note instead of the
  // raw provider markup. Only when something was actually executed — the
  // nothing-executable case keeps the raw text so the defense layer's leak
  // fault class still fires as the fallback.
  let cursor = 0; // position of this block's calls within the global `calls` order
  const cleanContent = msg.content.map((b) => {
    if (!b || b.type !== 'text') return b;
    const t = String((b as { text?: unknown }).text ?? '');
    if (!/<｜DSML｜/.test(t)) return b;
    const local = parseLeakedToolCalls(t);
    const localMarkers = local.calls.map((c, i) => {
      const gi = cursor + i;
      if (gi < markers.length) return markers[gi] ?? `(工具调用 ${c.name}：结果见后续消息)`;
      return `(工具调用 ${c.name}：超出代执行上限，未自动执行)`;
    });
    cursor += local.calls.length;
    return { ...b, text: cleanLeakedBlocks(t, localMarkers) };
  });
  return {
    message: {
      ...(event.message as unknown as Record<string, unknown>),
      content: cleanContent,
    },
  };
}
