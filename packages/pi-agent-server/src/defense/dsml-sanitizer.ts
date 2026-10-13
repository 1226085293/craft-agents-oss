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
import { containsDsmlMarkup, stripDsmlResidue } from '../../../shared/src/utils/dsml-strip.ts';

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
    .filter((block) => {
      if (typeof block.id !== 'string' || !block.id.startsWith('call_dsml_')) return false;
      const suffix = block.id.slice('call_dsml_'.length);
      const separator = suffix.lastIndexOf('_');
      const namespace = suffix.slice(0, separator);
      const sequence = suffix.slice(separator + 1);
      return separator > 0 && namespace.length === 32 && /^[a-f0-9]+$/.test(namespace) &&
        sequence.length > 0 && [...sequence].every((digit) => digit >= '0' && digit <= '9');
    });
  // No native call filter needed before scrubbing (2026-10-13): the receiver
  // may have injected nothing at all (malformed/asymmetric leaks defeat its
  // parser too) — marker-bearing text is then PURE residue and must be
  // scrubbed outright. `matchesNative` below simply never matches, so every
  // marker-bearing block falls through to stripDsmlResidue.

  // A leaked block may only be stripped when the receiver actually executed a
  // call with the same name+arguments (existence match — the receiver dedups
  // identical calls, so N identical leaked blocks may map to one native call).
  const matchesNative = (call: { name: string; args: Record<string, unknown> | null }): boolean =>
    call.args !== null && nativeCalls.some((native) =>
      native.name === call.name && JSON.stringify(native.arguments) === JSON.stringify(call.args));

  let changed = false;
  const content = message.content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block;
    // Fast gate: no DSML marker at all → nothing to do.
    if (!containsDsmlMarkup(block.text)) return block;
    const parsed = parseLeakedToolCalls(block.text);
    if (!parsed.leaked || parsed.calls.length === 0) {
      // 2026-10-13: malformed/asymmetric leak variants defeat the parser
      // (no recoverable invoke structure) — scrub ANY residual ＼DSML＼
      // markup here so it can never reach the user as raw text.
      const stripped = stripDsmlResidue(block.text);
      if (stripped !== block.text) {
        changed = true;
        return { ...block, text: stripped };
      }
      return block;
    }
    if (!parsed.calls.every(matchesNative)) {
      const stripped = stripDsmlResidue(block.text);
      if (stripped !== block.text) {
        changed = true;
        return { ...block, text: stripped };
      }
      return block;
    }
    // Replace leaked blocks with nothing: the executed toolCall blocks already
    // render as their own process items, and a VISIBLE placeholder here was
    // persisted into the transcript and re-fed to the model, which began
    // echoing the placeholder verbatim (up to 1542x in one response — see
    // session 261005-azure-stream). Stripping silently keeps the transcript
    // clean of both raw markup and its echo bait.
    changed = true;
    return { ...block, text: cleanLeakedBlocks(block.text, []) };
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
