import { describe, expect, it, beforeEach } from 'bun:test';

/**
 * Regression tests for the two zero-cache-cost fixes to the 2026-11 "Tool _xxx
 * not found" incidents:
 *
 *  - repairToolName: `_bash` (valid args, mangled name) is mapped back onto the
 *    advertised `bash` so the command actually runs.
 *  - enrichUnknownToolResult: a phantom metadata-field call gets an explanation
 *    instead of the bare SDK error, so the model can correct itself.
 */

process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';

const {
  repairToolName,
  rememberRequestToolNames,
  _resetRequestToolNamesForTesting,
} = await import('../../shared/src/unified-network-interceptor.ts');

const { enrichUnknownToolResult, CRAFT_METADATA_FIELD_NAMES } = await import('./unknown-tool-result.ts');

describe('repairToolName', () => {
  beforeEach(() => {
    _resetRequestToolNamesForTesting();
  });

  it('maps an underscore-prefixed tool name back onto the advertised tool', () => {
    const known = ['bash', 'read', 'grep'];
    expect(repairToolName('_bash', known)).toBe('bash');
    expect(repairToolName('__bash', known)).toBe('bash');
    expect(repairToolName('_read', known)).toBe('read');
  });

  it('leaves an already-valid name alone (null = no change)', () => {
    expect(repairToolName('bash', ['bash'])).toBeNull();
  });

  it('never invents a tool that was not advertised', () => {
    // `_displayName` is a metadata field, not a tool — nothing to map onto.
    expect(repairToolName('_displayName', ['bash', 'read'])).toBeNull();
    expect(repairToolName('bsh', ['bash'])).toBeNull();
    expect(repairToolName('_nonexistent', ['bash'])).toBeNull();
  });

  it('fixes case-only mismatches onto the canonical name', () => {
    expect(repairToolName('Bash', ['bash'])).toBe('bash');
    expect(repairToolName('_BASH', ['bash'])).toBe('bash');
  });

  it('works with the names captured from the current request', () => {
    rememberRequestToolNames(['bash', 'web_fetch']);
    expect(repairToolName('_bash')).toBe('bash');
    expect(repairToolName('_web_fetch')).toBe('web_fetch');
    // Not advertised in this request.
    expect(repairToolName('_grep')).toBeNull();
  });

  it('does nothing when no tool names were captured (e.g. compaction request)', () => {
    expect(repairToolName('_bash')).toBeNull();
    expect(repairToolName('_bash', [])).toBeNull();
  });
});

describe('enrichUnknownToolResult', () => {
  const result = () => ({ content: [{ type: 'text', text: 'Tool _displayName not found' }] });

  it('explains that the name is a metadata field', () => {
    const r = result();
    expect(enrichUnknownToolResult(r, '_displayName')).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('is a Craft UI metadata field');
    expect(text).toContain('not a tool name');
  });

  it('covers the current wire keys as well as the legacy underscore keys', () => {
    for (const name of ['appDisplayName', 'appIntent', '_displayName', '_intent']) {
      expect(CRAFT_METADATA_FIELD_NAMES.has(name)).toBe(true);
      const r = { content: [{ type: 'text', text: `Tool ${name} not found` }] };
      expect(enrichUnknownToolResult(r, name)).toBe(true);
    }
  });

  it('leaves a genuinely misspelled tool name untouched', () => {
    const r = { content: [{ type: 'text', text: 'Tool bsh not found' }] };
    expect(enrichUnknownToolResult(r, 'bsh')).toBe(false);
    expect((r.content[0] as { text: string }).text).toBe('Tool bsh not found');
  });

  it('does not touch a metadata name when the error is about a different tool', () => {
    // Defends the exact-match gate: the result text must name the same tool.
    const r = { content: [{ type: 'text', text: 'Tool other_tool not found' }] };
    expect(enrichUnknownToolResult(r, '_displayName')).toBe(false);
  });

  it('does not touch successful results or non-error shapes', () => {
    const r = { content: [{ type: 'text', text: 'ok' }] };
    expect(enrichUnknownToolResult(r, '_displayName')).toBe(false);
    expect(enrichUnknownToolResult('Tool _displayName not found', '_displayName')).toBe(false);
    expect(enrichUnknownToolResult(null, '_displayName')).toBe(false);
  });

  it('rewrites string-content results too', () => {
    const r: Record<string, unknown> = { content: 'Tool _intent not found' };
    expect(enrichUnknownToolResult(r, '_intent')).toBe(true);
    expect(String(r.content)).toContain('is a Craft UI metadata field');
  });
});
