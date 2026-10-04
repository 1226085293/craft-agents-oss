import { describe, expect, it, beforeAll, beforeEach } from 'bun:test';
import type {
  ExtensionAPI,
  InlineExtension,
  MessageEndEvent,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  createDsmlBridgeExtension,
  finalTextSig,
  bridgeHandledSig,
  resetBridgeStateForTest,
} from './dsml-bridge.ts';
import { parseLeakedToolCalls, cleanLeakedBlocks } from './leaked-toolcall.ts';

// The exact shape observed in the 2026-10-04 incidents (tall-nickel /
// polished-canyon): deepseek-v4-flash leaked the DSML tool-call block as
// literal text on a custom endpoint.
const INCIDENT_TEXT =
  '继续分析。\n\n' +
  '<｜DSML｜tool_calls>\n' +
  '<｜DSML｜invoke name="bash">' +
  '<｜DSML｜parameter name="arguments" string="false">{"_displayName": "查看状态", "command": "git status"}</｜DSML｜parameter>' +
  '</｜DSML｜invoke>\n' +
  '</｜DSML｜tool_calls>';

function fakeDef(
  name: string,
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean },
  shouldThrow?: string,
): { def: ToolDefinition<any, any>; calls: Array<{ id: string; args: unknown }> } {
  const calls: Array<{ id: string; args: unknown }> = [];
  const def = {
    name,
    description: '',
    parameters: {},
    execute: async (id: string, args: unknown) => {
      calls.push({ id, args });
      if (shouldThrow) throw new Error(shouldThrow);
      return result ?? { content: [{ type: 'text', text: `ok-${name}` }] };
    },
  } as unknown as ToolDefinition<any, any>;
  return { def, calls };
}

function harness(toolDefs: ToolDefinition<any, any>[]) {
  const logs: string[] = [];
  const ext = createDsmlBridgeExtension({
    getToolDefinitions: () => toolDefs,
    debugLog: (m) => logs.push(m),
  }) as InlineExtension & { factory: (api: ExtensionAPI) => void };
  const sent: Array<{ content: string; options?: unknown }> = [];
  let handler: ((event: MessageEndEvent, ctx: unknown) => unknown) | null = null;
  const api = {
    on: (_event: string, h: (event: MessageEndEvent, ctx: unknown) => unknown) => {
      handler = h;
    },
    sendUserMessage: async (content: string, options?: unknown) => {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  ext.factory(api);
  expect(handler, 'message_end handler must be registered').not.toBeNull();
  const ctxStub = { signal: undefined } as unknown;
  const fire = (message: Record<string, unknown>) =>
    Promise.resolve(handler!({ type: 'message_end', message } as unknown as MessageEndEvent, ctxStub));
  return { fire, sent, logs };
}

describe('parseLeakedToolCalls', () => {
  it('extracts the intended call and JSON arguments from the incident text', () => {
    const { leaked, calls } = parseLeakedToolCalls(INCIDENT_TEXT);
    expect(leaked).toBe(true);
    expect(calls).toEqual([
      {
        name: 'bash',
        args: { _displayName: '查看状态', command: 'git status' },
        rawArgs: '{"_displayName": "查看状态", "command": "git status"}',
      },
    ]);
  });

  it('extracts multiple invokes in order', () => {
    const text =
      '<｜DSML｜tool_calls>\n' +
      '<｜DSML｜invoke name="read"><｜DSML｜parameter name="arguments" string="false">{"path":"a.txt"}</｜DSML｜parameter></｜DSML｜invoke>\n' +
      '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="arguments" string="false">{"command":"ls"}</｜DSML｜parameter></｜DSML｜invoke>\n' +
      '</｜DSML｜tool_calls>';
    expect(parseLeakedToolCalls(text).calls.map((c) => c.name)).toEqual(['read', 'bash']);
  });

  it('keeps the raw args when the JSON is malformed (reported, never guessed)', () => {
    const text =
      '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="arguments" string="false">{not json</｜DSML｜parameter></｜DSML｜invoke>';
    const { calls } = parseLeakedToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toBeNull();
    expect(calls[0].rawArgs).toBe('{not json');
  });

  it('returns no calls for healthy text', () => {
    expect(parseLeakedToolCalls('plain answer with no markup').leaked).toBe(false);
    expect(parseLeakedToolCalls('').calls).toEqual([]);
  });
});

describe('cleanLeakedBlocks', () => {
  it('replaces invoke blocks with markers and strips the wrappers', () => {
    const text =
      '继续分析。\n' +
      '<｜DSML｜tool_calls>\n' +
      '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="arguments" string="false">{"command":"git status"}</｜DSML｜parameter></｜DSML｜invoke>\n' +
      '</｜DSML｜tool_calls>\n后续说明。';
    const out = cleanLeakedBlocks(text, ['(工具调用 bash：Craft 已代执行，结果见后续消息)']);
    expect(out).not.toContain('｜DSML｜');
    expect(out).toContain('工具调用 bash：Craft 已代执行');
    expect(out).toContain('继续分析。');
    expect(out).toContain('后续说明。');
  });

  it('returns healthy text unchanged', () => {
    expect(cleanLeakedBlocks('plain answer', ['x'])).toBe('plain answer');
  });

  it('strips blocks without markers (never invents)', () => {
    const text =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="a">{}</｜DSML｜invoke><｜DSML｜invoke name="b">{}</｜DSML｜invoke></｜DSML｜tool_calls>';
    expect(cleanLeakedBlocks(text, ['only-a'])).not.toContain('｜DSML｜');
    expect(cleanLeakedBlocks(text, ['only-a'])).toContain('only-a');
  });
});

describe('DSML bridge extension (2026-10-04 polished-canyon incident)', () => {
  beforeAll(() => {});
  beforeEach(() => resetBridgeStateForTest());

  it('executes a leaked call through the wrapped tool, queues the result report, and sanitizes the final message', async () => {
    const { def, calls } = fakeDef('bash');
    const h = harness([def]);
    const res = await h.fire({
      role: 'assistant',
      content: [{ type: 'text', text: INCIDENT_TEXT }],
      stopReason: 'stop',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('dsml-bridge-1');
    expect(calls[0].args).toEqual({ _displayName: '查看状态', command: 'git status' });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].content).toContain('[DSML Bridge]');
    expect(h.sent[0].content).toContain('ok-bash');
    expect(JSON.stringify(calls[0].args)).toContain('git status');
    expect(h.sent[0].options).toEqual({ deliverAs: 'followUp' });
    expect(bridgeHandledSig()).toBe(finalTextSig(INCIDENT_TEXT));
    // The finalized message is replaced in place: prose kept, raw markup gone.
    expect(res?.message).toBeDefined();
    const clean = (res!.message as unknown as { content: Array<{ type?: string; text?: string }> }).content;
    expect(clean[0].text).not.toContain('｜DSML｜');
    expect(clean[0].text).toContain('工具调用 bash：Craft 已代执行');
    expect(clean[0].text).toContain('继续分析。');
    expect((res!.message as unknown as { role: string }).role).toBe('assistant');
  });

  it('never interferes with a healthy structured tool-call stream', async () => {
    const { def, calls } = fakeDef('bash');
    const h = harness([def]);
    await h.fire({
      role: 'assistant',
      content: [
        { type: 'text', text: '运行一下。' },
        { type: 'toolCall', id: 'x', name: 'bash', arguments: { command: 'ls' } },
      ],
      stopReason: 'toolUse',
    });
    expect(calls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(bridgeHandledSig()).toBeNull();
  });

  it('skips unknown tools, only reports, and does NOT sanitize (defense fallback keeps the raw text)', async () => {
    const { def } = fakeDef('bash');
    const h = harness([def]);
    const res = await h.fire({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text:
            '<｜DSML｜tool_calls>\n' +
            '<｜DSML｜invoke name="frobnicate"><｜DSML｜parameter name="arguments" string="false">{"x":1}</｜DSML｜parameter></｜DSML｜invoke>\n' +
            '</｜DSML｜tool_calls>',
        },
      ],
      stopReason: 'stop',
    });
    expect(h.sent).toHaveLength(0);
    expect(h.logs.join(' ')).toContain('none executable');
    expect(res).toBeUndefined(); // raw text preserved so the leak fault class still fires
  });

  it('reports execution errors, still queues the report, and sanitizes with a failure note', async () => {
    const { def } = fakeDef('bash', undefined, 'permission denied');
    const h = harness([def]);
    const res = await h.fire({
      role: 'assistant',
      content: [{ type: 'text', text: INCIDENT_TEXT }],
      stopReason: 'stop',
    });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].content).toContain('ERROR: permission denied');
    expect(res?.message).toBeDefined();
    const clean = (res!.message as unknown as { content: Array<{ type?: string; text?: string }> }).content;
    expect(clean[0].text).not.toContain('｜DSML｜');
    expect(clean[0].text).toContain('Craft 代执行失败');
  });

  it('caps executions per message and notes the remainder', async () => {
    const defs: ToolDefinition<any, any>[] = ['a', 'b', 'c', 'd', 'e'].map((n) => fakeDef(n).def);
    const h = harness(defs);
    const text =
      '<｜DSML｜tool_calls>\n' +
      [...'abcde']
        .map((n) => `<｜DSML｜invoke name="${n}"><｜DSML｜parameter name="arguments" string="false">{"k":"${n}"}</｜DSML｜parameter></｜DSML｜invoke>`)
        .join('\n') +
      '\n</｜DSML｜tool_calls>';
    await h.fire({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].content).toContain('1 more call(s) not executed (cap 4 per message)');
  });

  it('ignores non-assistant messages', async () => {
    const { def, calls } = fakeDef('bash');
    const h = harness([def]);
    await h.fire({ role: 'user', content: [{ type: 'text', text: INCIDENT_TEXT }] });
    expect(calls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });
});
