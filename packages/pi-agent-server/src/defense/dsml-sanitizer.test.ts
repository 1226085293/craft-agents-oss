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
  it('strips residual DSML text beside native toolCall blocks only', async () => {
    const h = harness();
    const nativeCall = { type: 'toolCall', id: 'call_dsml_1', name: 'read', arguments: { path: 'a.txt' } };
    const original = { role: 'assistant', content: [{ type: 'text', text: `Before\n${leaked}\nAfter` }, nativeCall], stopReason: 'toolUse' };
    const result = await h.fire(original);
    const message = (result as { message: typeof original } | undefined)?.message;
    expect(message).toBeDefined();
    expect((message!.content[0] as { text: string }).text).not.toContain('｜DSML｜');
    expect((message!.content[0] as { text: string }).text).toContain('工具调用 read');
    expect(message!.content[1]).toEqual(nativeCall);
    expect(h.sent).toHaveLength(0);
  });

  it('keeps leaked markup when any leaked call has no matching native call', async () => {
    const h = harness();
    const invalid = '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="arguments" string="false">{not-json}</｜DSML｜parameter></｜DSML｜invoke>';
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: leaked + invalid },
        { type: 'toolCall', id: 'call_dsml_1', name: 'read', arguments: { path: 'a.txt' } },
      ],
    };
    expect(await h.fire(message)).toBeUndefined();
    expect((message.content[0] as { text: string }).text).toContain('｜DSML｜');
    expect(h.sent).toHaveLength(0);
  });

});
