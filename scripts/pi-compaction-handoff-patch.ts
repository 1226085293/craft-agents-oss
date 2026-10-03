export const COMPACTION_HANDOFF_MARKER = 'PATCH: pi-coding-agent compaction handoff (automatic + split-turn summaries + dynamic context)';
const LEGACY_HANDOFF_MARKER = 'PATCH: pi-coding-agent compaction handoff (automatic + split-turn summaries)';

const TURN_PREFIX_BASE =
  'const promptText = `<conversation>\\n${conversationText}\\n</conversation>\\n\\n${TURN_PREFIX_SUMMARIZATION_PROMPT}';
const TURN_PREFIX_CALL =
  'generateTurnPrefixSummaryResilient(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId);';
const TURN_PREFIX_CALL_CURRENT = TURN_PREFIX_CALL.replace('sessionId);', 'sessionId, customInstructions);');
const TURN_PREFIX_WRAPPER_SIGNATURE =
  'async function generateTurnPrefixSummaryResilient(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, depth = 0) {';
const TURN_PREFIX_WRAPPER_SIGNATURE_CURRENT = TURN_PREFIX_WRAPPER_SIGNATURE.replace('sessionId, depth = 0)', 'sessionId, customInstructions, depth = 0)');
const TURN_PREFIX_SIGNATURE =
  'async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId) {';
const TURN_PREFIX_SIGNATURE_CURRENT = TURN_PREFIX_SIGNATURE.replace('callbacks, sessionId)', 'callbacks, sessionId, customInstructions)');

const TURN_PREFIX_HANDOFF = [
  'COMPACTION HANDOFF CONTRACT',
  'Preserve the current user request verbatim; Completed (with results), In progress, and Blocked task checklist; confirmed facts and conclusions; Rejected paths and reasons; next actions; and exact key file paths and IDs.',
  'Do not drop previously completed items or rejected-path reasons while merging earlier summaries with new evidence.',
  'The full conversation is persisted in the session transcript (session.jsonl); if a needed detail is missing, instruct the resumed agent to search/read it before repeating work.',
].join('\n\n');

/** Patch the pinned Pi SDK split-turn prefix prompt; also migrates the legacy static variant. */
export function patchSplitTurnHandoff(source: string): { source: string; changed: boolean; warning?: string } {
  const promptIsCurrent = source.includes(COMPACTION_HANDOFF_MARKER) &&
    source.includes('Additional focus: ');
  const hasLegacyMarker = source.includes(LEGACY_HANDOFF_MARKER);
  const promptBaseExists = source.includes(TURN_PREFIX_BASE);
  const promptStart = promptBaseExists
    ? source.lastIndexOf('const promptText =', source.indexOf(TURN_PREFIX_BASE))
    : hasLegacyMarker
      ? source.lastIndexOf('const promptText =', source.indexOf(LEGACY_HANDOFF_MARKER))
      : -1;

  const missingAnchors = [
    [TURN_PREFIX_CALL, TURN_PREFIX_CALL_CURRENT, 'split-turn call'],
    [TURN_PREFIX_WRAPPER_SIGNATURE, TURN_PREFIX_WRAPPER_SIGNATURE_CURRENT, 'turn-prefix wrapper signature'],
    [TURN_PREFIX_SIGNATURE, TURN_PREFIX_SIGNATURE_CURRENT, 'turn-prefix signature'],
  ] as const;
  for (const [legacy, current, label] of missingAnchors) {
    if (!source.includes(legacy) && !source.includes(current)) {
      return { source, changed: false, warning: `Pi SDK ${label} anchor not found; split-turn handoff was not installed.` };
    }
  }
  if (promptStart < 0) {
    return { source, changed: false, warning: 'Pi SDK turn-prefix prompt anchor not found; split-turn handoff was not installed.' };
  }

  let result = source;
  let changed = false;
  if (!promptIsCurrent) {
    const end = result.indexOf('`;', promptStart);
    if (end < 0) return { source, changed: false, warning: 'Pi SDK turn-prefix prompt boundary not found; handoff upgrade was skipped.' };

    const handoffExpression = `(${JSON.stringify(TURN_PREFIX_HANDOFF)} + (customInstructions ? "\\n\\nAdditional focus: " + customInstructions : ""))`;
    const promptTemplate = `${TURN_PREFIX_BASE}\\n\\n${COMPACTION_HANDOFF_MARKER}\\n\${${handoffExpression}}\`;`;
    result = result.slice(0, promptStart) + promptTemplate + result.slice(end + 2);
    changed = true;
  }

  const replacements: Array<[string, string]> = [
    [TURN_PREFIX_CALL, TURN_PREFIX_CALL_CURRENT],
    [TURN_PREFIX_WRAPPER_SIGNATURE, TURN_PREFIX_WRAPPER_SIGNATURE_CURRENT],
    [TURN_PREFIX_SIGNATURE, TURN_PREFIX_SIGNATURE_CURRENT],
    [
      'generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId);',
      'generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, customInstructions);',
    ],
    [
      'generateTurnPrefixSummaryResilient(halves[0], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, depth + 1);',
      'generateTurnPrefixSummaryResilient(halves[0], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, customInstructions, depth + 1);',
    ],
    [
      'generateTurnPrefixSummaryResilient(halves[1], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, depth + 1);',
      'generateTurnPrefixSummaryResilient(halves[1], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, customInstructions, depth + 1);',
    ],
  ];
  for (const [from, to] of replacements) {
    if (result.includes(from)) {
      result = result.replaceAll(from, to);
      changed = true;
    }
  }

  const required = [
    COMPACTION_HANDOFF_MARKER,
    'Additional focus: ',
    'sessionId, customInstructions);',
    'callbacks, sessionId, customInstructions, depth = 0',
    'halves[0], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, customInstructions, depth + 1',
    'halves[1], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, customInstructions, depth + 1',
  ];
  const missing = required.find((anchor) => !result.includes(anchor));
  if (missing) return { source, changed: false, warning: `Pi SDK split-turn handoff incomplete; missing ${missing}.` };
  return { source: result, changed };
}
