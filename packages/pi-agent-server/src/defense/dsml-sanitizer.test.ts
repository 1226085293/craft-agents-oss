import { describe, expect, it } from 'bun:test';
import type { ExtensionAPI, InlineExtension, MessageEndEvent } from '@earendil-works/pi-coding-agent';
import { createDsmlSanitizerExtension } from './dsml-sanitizer.ts';

// DSML marker primitive (U+FF5C + "DSML" + U+FF5C) — use escapes here so the
// source stays ASCII-safe.
const M = '\uFF5CDSML\uFF5C';

const leaked =
  '<' + M + 'tool_calls>\n' +
  '<' + M + 'invoke name="read"><' + M + 'parameter name="arguments" string="false">{"path":"a.txt"}</' + M + 'parameter></' + M + 'invoke>\n' +
  '</' + M + 'tool_calls>';

function harness() {
  let handler: ((event: MessageEndEvent, ctx: unknown) => unknown) | undefined;
  const logs: string[] = [];
  const extension = createDsmlSanitizerExtension({ debugLog: (line) => logs.push(line) }) as InlineExtension & { factory: (api: ExtensionAPI) => void };
  const sent: unknown[] = [];
  extension.factory({
    on: (_name: string, callback: (event: MessageEndEvent, ctx: unknown) => unknown) => { handler = callback; },
    sendUserMessage: async (...args: unknown[]) => { sent.push(args); },
  } as unknown as ExtensionAPI);
  return { fire: (message: Record<string, unknown>) => handler!({ type: 'message_end', message } as unknown as MessageEndEvent, {}), sent, logs };
}

describe('DSML sanitizer extension', () => {
  it('strips residual DSML text beside native toolCall blocks only (invisible, no marker)', async () => {
    const h = harness();
    const nativeCall = { type: 'toolCall', id: 'call_dsml_00000000000000000000000000000000_1', name: 'read', arguments: { path: 'a.txt' } };
    const original = { role: 'assistant', content: [{ type: 'text', text: `Before\n${leaked}\nAfter` }, nativeCall], stopReason: 'toolUse' };
    const result = await h.fire(original);
    const message = (result as { message: typeof original } | undefined)?.message;
    expect(message).toBeDefined();
    const text = (message!.content[0] as { text: string }).text;
    expect(text).not.toContain('parameter');
    // No visible placeholder: a user-facing marker was persisted into the
    // transcript and re-fed to the model, which began echoing it verbatim.
    expect(text).not.toContain('工具调用');
    expect(text).toContain('Before');
    expect(text).toContain('After');
    expect(message!.content[1]).toEqual(nativeCall);
    expect(h.sent).toHaveLength(0);
  });

  it('strips N identical leaked calls mapped to one deduped native call', async () => {
    const h = harness();
    // Receiver dedups: 6 IDENTICAL leaked blocks execute ONCE.
    const repeated = '<' + M + 'tool_calls>\n' + Array.from({ length: 6 }, () =>
      `<${M}invoke name="bash"><${M}parameter name="arguments" string="false">{"command":"echo 0"}</${M}parameter></${M}invoke>`).join('\n') + '\n</' + M + 'tool_calls>';
    const nativeCall = { type: 'toolCall', id: 'call_dsml_00000000000000000000000000000000_1', name: 'bash', arguments: { command: 'echo 0' } };
    // Distinct calls: only the matching one is strippable; since 2026-10-13 the
    // residual markup of unmatched calls is SCRUBBED too (marker present) — it
    // must never reach the user as raw text.
    const mixed = '<' + M + 'invoke name="bash"><' + M + 'parameter name="arguments" string="false">{"command":"echo 0"}</' + M + 'parameter></' + M + 'invoke>\n<' + M + 'invoke name="bash"><' + M + 'parameter name="arguments" string="false">{"command":"echo 1"}</' + M + 'parameter></' + M + 'invoke>';

    const single = { role: 'assistant', content: [{ type: 'text', text: repeated }, nativeCall] };
    const result = await h.fire(single);
    const message = (result as { message: unknown } | undefined)?.message as typeof single;
    expect((message.content[0] as { text: string }).text).not.toContain('parameter');

    const h2 = harness();
    const both = { role: 'assistant', content: [{ type: 'text', text: mixed }, nativeCall] };
    const result2 = await h2.fire(both);
    const message2 = (result2 as { message: unknown } | undefined)?.message as typeof both;
    expect(message2).toBeDefined();
    expect((message2.content[0] as { text: string }).text).not.toContain('parameter');
  });

  it('scrubs malformed/asymmetric variants that defeat the parser (2026-10-13)', async () => {
    const h = harness();
    // 261008-plain-stag shape: parameter OPEN tags without the marker, CLOSE
    // tags with it, missing <M>invoke opener, stray closers at the end.
    const malformed =
      '<parameter name="_displayName">查看剩余 diff</' + M + 'parameter>\n' +
      '<parameter name="command" string="true">cd "E:/craft-agents-oss" && git diff | head -80</' + M + 'parameter>\n' +
      '<parameter name="timeout" string="false">30</' + M + 'parameter>\n' +
      '</' + M + 'invoke>\n' +
      '</' + M + 'tool_calls>';
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: `前文\n${malformed}\n后文` }],
    };
    const result = await h.fire(message);
    const cleaned = (result as { message: typeof message } | undefined)?.message;
    expect(cleaned).toBeDefined();
    const text = (cleaned!.content[0] as { text: string }).text;
    expect(text).not.toContain('\uFF5C');
    expect(text).not.toContain('parameter');
    expect(text).toContain('前文');
    expect(text).toContain('后文');
  });

  it('keeps leaked markup when any leaked call has no matching native call', async () => {
    const h = harness();
    const invalid = '<' + M + 'invoke name="bash"><' + M + 'parameter name="arguments" string="false">{not-json}</' + M + 'parameter></' + M + 'invoke>';
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: leaked + invalid },
        { type: 'toolCall', id: 'call_dsml_00000000000000000000000000000000_1', name: 'read', arguments: { path: 'a.txt' } },
      ],
    };
    // 2026-10-13: marker-bearing text is scrubbed regardless of native match.
    const result = await h.fire(message);
    const cleaned = (result as { message: typeof message } | undefined)?.message;
    expect(cleaned).toBeDefined();
    const text = (cleaned.content[0] as { text: string }).text;
    expect(text).not.toContain('\uFF5C');
    expect(h.sent).toHaveLength(0);
  });

});
