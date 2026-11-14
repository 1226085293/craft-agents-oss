import { describe, expect, it, beforeAll } from 'bun:test';

/**
 * Wire-format contract for Craft's tool metadata fields.
 *
 * 2026-11-10: `_displayName` / `_intent` were renamed to `appDisplayName` /
 * `appIntent`. The leading underscore was imitated by models (they underscored
 * real parameter names -> `_command`, and tool names -> `_bash`, which the SDK
 * rejects as `Tool _bash not found`). These tests pin the two properties that
 * matter:
 *
 *   1. No underscore-prefixed key is ever injected into a tool schema.
 *   2. Legacy keys are still *stripped* — old sessions replay them from stored
 *      history, and an unstripped key reaches the tool and fails validation.
 */

let ic: typeof import('../unified-network-interceptor.ts');

describe('tool metadata wire keys', () => {
  beforeAll(async () => {
    process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    ic = await import('../unified-network-interceptor.ts');
  });

  it('injects appDisplayName/appIntent with no underscore-prefixed keys', () => {
    const schema = ic.injectMetadataIntoToolSchema({
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    });

    expect(Object.keys(schema.properties)).toEqual(['command', 'appDisplayName', 'appIntent']);
    expect(schema.required).toEqual(['command', 'appDisplayName', 'appIntent']);

    const underscoreKeys = Object.keys(schema.properties).filter((key) => key.startsWith('_'));
    expect(underscoreKeys).toEqual([]);
  });

  it('keeps upstream-defined metadata properties instead of overwriting them', () => {
    const upstream = { type: 'string', description: 'upstream-owned' };
    const schema = ic.injectMetadataIntoToolSchema({
      type: 'object',
      properties: { appDisplayName: upstream },
    });

    expect(schema.properties.appDisplayName).toEqual(upstream);
  });

  it('moves metadata keys to the end so real parameters read first', () => {
    const schema = ic.injectMetadataIntoToolSchema({
      type: 'object',
      properties: { alpha: {}, appIntent: {}, beta: {} },
      required: ['alpha'],
    });

    expect(Object.keys(schema.properties)).toEqual(['alpha', 'beta', 'appDisplayName', 'appIntent']);
  });

  it('strips both current and legacy keys from raw JSON', () => {
    const raw = '{"command":"ls","appIntent":"a","appDisplayName":"b","_intent":"c","_displayName":"d"}';
    expect(ic.stripMetadataFieldsFromRawJson(raw)).toBe('{"command":"ls"}');
  });

  it('deleteMetadataKeys clears all four wire keys in place', () => {
    const input: Record<string, unknown> = {
      appDisplayName: 1,
      appIntent: 2,
      _displayName: 3,
      _intent: 4,
      keep: 5,
    };
    ic.deleteMetadataKeys(input);
    expect(input).toEqual({ keep: 5 });
  });
});
