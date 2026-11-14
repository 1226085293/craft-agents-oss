import { describe, expect, it } from 'bun:test';
import { createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import { allowCraftMetadataProperties, normalizeUnderscorePrefixedArgs, stripCraftMetadata } from './craft-metadata-schema.ts';

describe('Craft metadata schema compatibility for Pi tools', () => {
  it('widens a strict Edit-like schema with optional Craft metadata properties', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path', 'edits'],
    };

    const widened = allowCraftMetadataProperties(schema);

    expect(widened).not.toBe(schema);
    expect(widened.additionalProperties).toBe(false);
    expect(widened.required).toEqual(schema.required);
    expect(widened.required).not.toContain('appDisplayName');
    expect(widened.required).not.toContain('appIntent');
    expect(widened.properties.appDisplayName).toBeDefined();
    expect(widened.properties.appIntent).toBeDefined();
    expect(widened.properties.path).toBe(schema.properties.path);
    expect(widened.properties.edits).toBe(schema.properties.edits);
  });

  it('widens the actual Pi Edit tool schema without making metadata required', () => {
    const editTool = createEditToolDefinition('/tmp');
    const widened = allowCraftMetadataProperties(editTool.parameters);
    const widenedSchema = widened as {
      additionalProperties?: unknown;
      properties: Record<string, unknown>;
      required?: string[];
    };

    // Preserve upstream additionalProperties as-is (pi 0.80.6 stopped setting
    // `false`; the synthetic-schema test above covers preservation when set).
    const upstream = editTool.parameters as { additionalProperties?: unknown };
    expect(widenedSchema.additionalProperties).toBe(upstream.additionalProperties);
    expect(widenedSchema.properties.appDisplayName).toBeDefined();
    expect(widenedSchema.properties.appIntent).toBeDefined();
    expect(widenedSchema.required ?? []).not.toContain('appDisplayName');
    expect(widenedSchema.required ?? []).not.toContain('appIntent');
  });

  it('preserves upstream metadata properties if Pi defines them later', () => {
    const upstreamDisplayName = { type: 'string', description: 'upstream display name' };
    const upstreamIntent = { type: 'string', description: 'upstream intent' };
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        appDisplayName: upstreamDisplayName,
        appIntent: upstreamIntent,
        path: { type: 'string' },
      },
      required: ['path'],
    };

    const widened = allowCraftMetadataProperties(schema);

    expect(widened.properties.appDisplayName).toBe(upstreamDisplayName);
    expect(widened.properties.appIntent).toBe(upstreamIntent);
  });

  it('returns unknown schema shapes unchanged', () => {
    expect(allowCraftMetadataProperties(undefined)).toBeUndefined();
    expect(allowCraftMetadataProperties('schema')).toBe('schema');

    const noProperties = { type: 'string' };
    expect(allowCraftMetadataProperties(noProperties)).toBe(noProperties);
  });

  it('strips Craft metadata before upstream Pi tool execution', () => {
    const input = {
      appDisplayName: 'Edit Lines',
      appIntent: 'Add punctuation',
      path: 'random',
      edits: [{ oldText: 'a', newText: 'b' }],
    };

    const clean = stripCraftMetadata(input);

    expect(clean).toEqual({
      path: 'random',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(clean).not.toHaveProperty('appDisplayName');
    expect(clean).not.toHaveProperty('appIntent');
    expect(input).toHaveProperty('appDisplayName', 'Edit Lines');
    expect(input).toHaveProperty('appIntent', 'Add punctuation');
  });

  it('normalizes underscore-prefixed real params (command -> _command) before validation', () => {
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['command'],
    };

    const args = { _command: 'ls -la', appDisplayName: 'List', appIntent: 'List files', timeout: 5 };
    const normalized = normalizeUnderscorePrefixedArgs(
      args as unknown as Record<string, unknown>,
      schema as { properties: Record<string, unknown> },
    );

    expect(normalized).toEqual({
      command: 'ls -la',
      appDisplayName: 'List',
      appIntent: 'List files',
      timeout: 5,
    });
  });

  it('leaves args untouched when there is no underscore-prefixed param', () => {
    const schema = { properties: { command: { type: 'string' } } };
    const args = { command: 'ls -la', appDisplayName: 'List', appIntent: 'List' };
    const normalized = normalizeUnderscorePrefixedArgs(args as unknown as Record<string, unknown>, schema as { properties: Record<string, unknown> });
    expect(normalized).toBe(args);
  });

  it('does not map underscores for keys not in the schema (unknown noise)', () => {
    const schema = { properties: { path: { type: 'string' } } };
    const args = { _command: 'ls', path: 'x' };
    const normalized = normalizeUnderscorePrefixedArgs(args as unknown as Record<string, unknown>, schema as { properties: Record<string, unknown> });
    expect(normalized).toEqual({ _command: 'ls', path: 'x' });
  });

  it('returns the same input object when no metadata is present', () => {
    const input = { path: 'random' };
    expect(stripCraftMetadata(input)).toBe(input);
  });

  it('does not clobber an existing bare key if both `_x` and `x` are present', () => {
    const schema = { properties: { command: { type: 'string' } } };
    const args = { _command: 'bad', command: 'good' };
    const normalized = normalizeUnderscorePrefixedArgs(args as unknown as Record<string, unknown>, schema as { properties: Record<string, unknown> });
    expect(normalized).toEqual({ _command: 'bad', command: 'good' });
  });
});
