import { describe, expect, it } from 'bun:test';

import { LISTENER_SPEC, PLUGIN_SPEC, parseManifest } from '../manifest.ts';

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { spec: PLUGIN_SPEC, id: 'qq', name: 'QQ', version: '1.0.0', ...overrides };
}

describe('plugin manifest', () => {
  it('still accepts a listener manifest written before the rename', () => {
    // Installed plugins must keep loading: the rename cannot orphan a user's
    // working listener just because the spec string moved on.
    const result = parseManifest(base({ spec: LISTENER_SPEC }));
    expect(result.ok).toBe(true);
    expect(result.manifest?.spec).toBe(LISTENER_SPEC);
    expect(result.manifest?.actions).toBeUndefined();
  });

  it('parses outbound actions with their schemas', () => {
    const result = parseManifest(
      base({
        actions: [
          {
            name: 'send_message',
            description: '往指定会话发一条文本消息',
            input: {
              type: 'object',
              properties: {
                channelId: { type: 'string', description: '群为 group:<id>' },
                text: { type: 'string' },
              },
              required: ['channelId', 'text'],
            },
          },
          {
            name: 'reply',
            description: '回复触发本次判断的消息',
            repliesToOrigin: true,
            input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    const actions = result.manifest?.actions ?? [];
    expect(actions.map((a) => a.name)).toEqual(['send_message', 'reply']);
    expect(actions[0]?.input.required).toEqual(['channelId', 'text']);
    expect(actions[0]?.input.properties?.channelId?.description).toContain('group:');
    expect(actions[1]?.repliesToOrigin).toBe(true);
    // A plain "send" is not a reply: the caller must name the destination.
    expect(actions[0]?.repliesToOrigin).toBeUndefined();
  });

  it('rejects an action the tool table could not name', () => {
    const result = parseManifest(
      base({
        actions: [{ name: 'Send Message', description: 'x', input: { type: 'object' } }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('actions[0].name');
  });

  it('rejects an action without a description', () => {
    // The description is the only documentation the model gets for the
    // parameters, so silence here is a defect rather than a style choice.
    const result = parseManifest(
      base({ actions: [{ name: 'send_message', input: { type: 'object' } }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('description is required');
  });

  it('rejects duplicate action names', () => {
    const result = parseManifest(
      base({
        actions: [
          { name: 'reply', description: 'a', input: { type: 'object' } },
          { name: 'reply', description: 'b', input: { type: 'object' } },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('declared twice');
  });
});
