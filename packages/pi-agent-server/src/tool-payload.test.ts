import { describe, expect, it } from 'bun:test';
import {
  PROMPT_SNIPPET_MAX_CHARS,
  TOOL_PAYLOAD_WARN_TOKENS,
  buildPromptSnippet,
  measurePromptSnippetChars,
  measureToolPayload,
} from './tool-payload.ts';

const tool = (name: string, description: string, params: unknown = { type: 'object' }) => ({
  name,
  description,
  parameters: params,
  promptSnippet: description,
});

describe('measureToolPayload', () => {
  it('is zero for an empty tool list', () => {
    expect(measureToolPayload([])).toEqual({ toolCount: 0, chars: 0, approxTokens: 0 });
  });

  it('counts name + description + serialised parameters', () => {
    const m = measureToolPayload([tool('ab', 'cd', { type: 'object' })]);
    expect(m.toolCount).toBe(1);
    // 'ab' (2) + 'cd' (2) + JSON.stringify({type:'object'}) (18) = 22
    expect(m.chars).toBe(2 + 2 + JSON.stringify({ type: 'object' }).length);
    expect(m.approxTokens).toBe(Math.ceil(m.chars / 4));
  });

  it('tolerates tools with missing fields', () => {
    expect(() => measureToolPayload([{}])).not.toThrow();
    expect(measureToolPayload([{}]).chars).toBe(0);
  });

  it('scales with tool count (the per-turn fixed cost)', () => {
    const few = measureToolPayload([tool('a', 'desc')]);
    const many = measureToolPayload(Array.from({ length: 38 }, (_, i) => tool(`t${i}`, 'desc')));
    expect(many.toolCount).toBe(38);
    expect(many.chars).toBeGreaterThan(few.chars * 30);
  });

  it('measures a realistic 38-tool MCP session in the low thousands', () => {
    // 7 builtin + 2 web + 29 proxy, ~200-char descriptions, small schemas.
    // Recorded deliberately: the preamble is real but it is NOT the dominant
    // cost of a long session — an early estimate of "10-20k tokens/turn" was
    // roughly 4x too high. Conversation history dominates.
    const typical = measureToolPayload(
      Array.from({ length: 38 }, (_, i) =>
        tool(`tool_${i}`, 'x'.repeat(200), {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'number' } },
        }),
      ),
    );
    expect(typical.approxTokens).toBeGreaterThan(1_000);
    expect(typical.approxTokens).toBeLessThan(6_000);
  });

  it('flags a genuinely heavy preamble that alone fills a small channel budget', () => {
    // Large MCP schemas (~800 chars each) plus long descriptions: at this size
    // tools, not conversation, are the binding constraint on an 8K channel.
    const heavy = measureToolPayload(
      Array.from({ length: 38 }, (_, i) =>
        tool(`tool_${i}`, 'd'.repeat(2_000), { type: 'object', properties: { p: { type: 'object', description: 's'.repeat(800) } } }),
      ),
    );
    expect(heavy.approxTokens).toBeGreaterThan(TOOL_PAYLOAD_WARN_TOKENS);
  });
});

describe('measurePromptSnippetChars', () => {
  it('sums the system-prompt listing text', () => {
    expect(measurePromptSnippetChars([{ promptSnippet: 'abc' }, { promptSnippet: 'de' }])).toBe(5);
    expect(measurePromptSnippetChars([{}])).toBe(0);
  });

  it('shrinks when snippets are shortened', () => {
    const long = 'word '.repeat(60).trim(); // ~300 chars
    const before = measurePromptSnippetChars([{ promptSnippet: long }]);
    const after = measurePromptSnippetChars([{ promptSnippet: buildPromptSnippet(long) }]);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThanOrEqual(PROMPT_SNIPPET_MAX_CHARS + 1);
  });
});

describe('buildPromptSnippet', () => {
  it('returns short descriptions unchanged', () => {
    expect(buildPromptSnippet('Read a file')).toBe('Read a file');
  });

  it('prefers the first sentence when the full text exceeds the cap', () => {
    // Must exceed PROMPT_SNIPPET_MAX_CHARS, otherwise it is returned as-is.
    const text = `Read a file from disk. ${'Supports offsets, limits and more. '.repeat(5)}`;
    expect(text.length).toBeGreaterThan(PROMPT_SNIPPET_MAX_CHARS);
    expect(buildPromptSnippet(text)).toBe('Read a file from disk.');
  });

  it('returns text shorter than the cap unchanged, even with several sentences', () => {
    expect(buildPromptSnippet('Read a file from disk. Supports offsets and limits.')).toBe(
      'Read a file from disk. Supports offsets and limits.',
    );
  });

  it('cuts at a word boundary when there is no early sentence end', () => {
    const text = 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' ' + 'c'.repeat(40);
    const out = buildPromptSnippet(text);
    expect(out.length).toBeLessThanOrEqual(PROMPT_SNIPPET_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('respects a custom max length', () => {
    const text = 'First sentence here. Second sentence here.';
    expect(buildPromptSnippet(text, 15).length).toBeLessThanOrEqual(16);
  });

  it('never returns an empty snippet for a non-empty description', () => {
    // The SDK hides tools with no snippet, so this must stay non-empty.
    expect(buildPromptSnippet('x'.repeat(500)).length).toBeGreaterThan(0);
  });

  it('handles empty and missing input', () => {
    expect(buildPromptSnippet('')).toBe('');
    expect(buildPromptSnippet(null)).toBe('');
    expect(buildPromptSnippet(undefined)).toBe('');
  });
});
