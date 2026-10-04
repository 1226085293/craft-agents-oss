/**
 * DSML sanitizer: remove residual leaked markup when the network receiver
 * has already converted the same calls into native SDK toolCall blocks.
 * This extension never executes tools and never queues follow-up messages.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  MessageEndEvent,
} from '@earendil-works/pi-coding-agent';
import { cleanLeakedBlocks, parseLeakedToolCalls } from './leaked-toolcall.ts';

type MessageEndResult = { message: unknown };

export interface DsmlSanitizerDeps {
  debugLog: (message: string) => void;
}

export function createDsmlSanitizerExtension(deps: DsmlSanitizerDeps): InlineExtension {
  return {
    name: 'craft-dsml-sanitizer',
    hidden: true,
    factory: (api: ExtensionAPI) => {
      const handler = (event: MessageEndEvent, _ctx: ExtensionContext) => {
        try {
          const result = sanitizeNativeMessage(event, deps);
          return result as MessageEndResult | undefined;
        } catch (error) {
          deps.debugLog(`[dsml-sanitizer] failed: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      };
      api.on('message_end', handler as unknown as never);
    },
  };
}

function sanitizeNativeMessage(
  event: MessageEndEvent,
  deps: DsmlSanitizerDeps,
): MessageEndResult | undefined {
  const message = event.message as unknown as {
    role?: string;
    content?: Array<Record<string, unknown>>;
  };
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
  const nativeCalls = message.content
    .filter((block) => block?.type === 'toolCall')
    .map((block) => block as { id?: unknown; name?: unknown; arguments?: unknown })
    .filter((block) => typeof block.id === 'string' && block.id.startsWith('call_dsml_') && String(Number(block.id.slice(10))) === block.id.slice(10));
  if (nativeCalls.length === 0) return undefined;

  let changed = false;
  let callIndex = 0;
  const content = message.content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block;
    const parsed = parseLeakedToolCalls(block.text);
    if (!parsed.leaked || parsed.calls.length === 0) return block;
    const calls = parsed.calls;
    const matched = calls.map((call) => {
      const native = nativeCalls[callIndex++];
      return native && native.name === call.name && call.args !== null &&
        JSON.stringify(native.arguments) === JSON.stringify(call.args);
    });
    if (matched.some((value) => !value)) {
      callIndex -= calls.length;
      return block;
    }
    changed = true;
    const markers = calls.map((call) => `(工具调用 ${call.name}：已识别为工具调用)`);
    return { ...block, text: cleanLeakedBlocks(block.text, markers) };
  });
  if (!changed) return undefined;

  deps.debugLog('[dsml-sanitizer] stripped residual DSML text beside native toolCall blocks');
  return {
    message: {
      ...(event.message as unknown as Record<string, unknown>),
      content,
    },
  };
}
