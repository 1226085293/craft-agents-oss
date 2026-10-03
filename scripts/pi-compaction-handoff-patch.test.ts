import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { patchSplitTurnHandoff, COMPACTION_HANDOFF_MARKER } from './pi-compaction-handoff-patch.ts';

const SDK_SOURCE = new URL('../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js', import.meta.url);
const TURN_PREFIX_PROMPT_ANCHOR = 'const promptText = `<conversation>\\n${conversationText}\\n</conversation>\\n\\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;';
const PATCH_FIXTURE = [
  TURN_PREFIX_PROMPT_ANCHOR,
  'const turnPrefixResult = await generateTurnPrefixSummaryResilient(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId);',
  'async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId) {',
  'async function generateTurnPrefixSummaryResilient(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, depth = 0) {',
  'return await generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId);',
  'const left = await generateTurnPrefixSummaryResilient(halves[0], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, depth + 1);',
  'const right = await generateTurnPrefixSummaryResilient(halves[1], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, depth + 1);',
].join('\\n');

describe('Pi SDK split-turn compaction handoff patch', () => {
  it('injects the required handoff sections and transcript pointer into the real pinned SDK source', () => {
    const source = readFileSync(SDK_SOURCE, 'utf8');
    const result = patchSplitTurnHandoff(source);
    expect(result.warning).toBeUndefined();
    expect(result.source).toContain(COMPACTION_HANDOFF_MARKER);
    expect(result.source).toContain('Rejected paths and reasons');
    expect(result.source).toContain('session.jsonl');
    expect(result.source).toContain('${conversationText}');
    expect(result.source).toContain('TURN_PREFIX_SUMMARIZATION_PROMPT');
    expect(result.source).toContain('sessionId, customInstructions);');
    expect(result.source).toContain('callbacks, sessionId, customInstructions, depth = 0');
    expect(result.source).toContain('halves[0], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, customInstructions, depth + 1');
    expect(result.source).toContain('halves[1], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, customInstructions, depth + 1');
    expect(result.source).toContain('Additional focus: ${customInstructions}');
  });

  it('is idempotent', () => {
    const once = patchSplitTurnHandoff(`prefix\n${PATCH_FIXTURE}\nsuffix`);
    const twice = patchSplitTurnHandoff(once.source);
    expect(once.changed).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
  });

  it('warns and leaves source unchanged when SDK internals drift', () => {
    const source = 'const promptText = buildPrompt(messages);';
    const result = patchSplitTurnHandoff(source);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
    expect(result.warning).toContain('anchor not found');
  });
});
