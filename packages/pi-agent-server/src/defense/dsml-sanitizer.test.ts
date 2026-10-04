import { describe, expect, it } from 'bun:test';
import type { ExtensionAPI, InlineExtension, MessageEndEvent } from '@earendil-works/pi-coding-agent';
import { createDsmlSanitizerExtension } from './dsml-sanitizer.ts';

const leaked =
  '<｜DSML｜tool_calls>\n' +
  '<｜DSML｜invoke name="read"><｜DSML｜parameter name="arguments" string="false">{"path":"a.txt"}</｜DSML｜parameter></｜DSML｜invoke>\n' +
  '</｜DSML｜tool_calls>';

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
    expect(text).not.toContain('｜DSML｜');
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
    const repeated = '<｜DSML｜tool_calls>\n' + Array.from({ length: 6 }, () =>
      `<｜DSML｜invoke name="bash"><｜DSML｜parameter name="arguments" string="false">{"command":"echo 0"}</｜DSML｜parameter></｜DSML｜invoke>`).join('\n') + '\n</｜DSML｜tool_calls>'
    const nativeCall = { type: 'toolCall', id: 'call_dsml_00000000000000000000000000000000_1', name: 'bash', arguments: { command: 'echo 0' } };
    // Distinct calls: only the matching one is strippable, so mixed text keeps its markup.
    const mixed = '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="arguments" string="false">{"command":"echo 0"}</｜DSML｜parameter></｜DSML｜invoke>\n<｜DSML｜invoke name="bash"><｜DSML｜parameter name="arguments" string="false">{"command":"echo 1"}</｜DSML｜parameter></｜DSML｜invoke>';

    const single = { role: 'assistant', content: [{ type: 'text', text: repeated }, nativeCall] };
    const result = await h.fire(single);
    const message = (result as { message: unknown } | undefined)?.message as typeof single;
    expect((message.content[0] as { text: string }).text).not.toContain('｜DSML｜');

    const h2 = harness();
    const both = { role: 'assistant', content: [{ type: 'text', text: mixed }, nativeCall] };
    expect(await h2.fire(both)).toBeUndefined();
    expect((both.content[0] as { text: string }).text).toContain('｜DSML｜');
  });

  it('keeps leaked markup when any leaked call has no matching native call', async () => {
    const h = harness();
    const invalid = '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="arguments" string="false">{not-json}</｜DSML｜parameter></｜DSML｜invoke>';
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: leaked + invalid },
        { type: 'toolCall', id: 'call_dsml_00000000000000000000000000000000_1', name: 'read', arguments: { path: 'a.txt' } },
      ],
    };
    expect(await h.fire(message)).toBeUndefined();
    expect((message.content[0] as { text: string }).text).toContain('｜DSML｜');
    expect(h.sent).toHaveLength(0);
  });

});
