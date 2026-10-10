/**
 * Memory Extractor — Extracts persistent facts from session transcripts.
 *
 * Uses LLM-based extraction to identify key facts, preferences, workflows,
 * and reminders from completed sessions. Results are stored in the workspace
 * memory store for future session injection.
 */

import type {
  MemoryEntry,
  MemoryExtractionInput,
  MemoryType,
  MemoryStore,
  SessionMemoryStore,
  MemoryExtractionRecord,
} from './types.ts';
import { foldLegacyMemoryType, memoryConfig, equalTag } from './types.ts';
import { addMemoryEntry, recordExtraction } from './store.ts';
import { adjudicateCandidates } from './adjudicator.ts';

// ============================================================================
// Semantic Deduplication
// ============================================================================

/**
 * Tokenize content into lowercase alphanumeric word tokens (length >= 2 to
 * drop stopwords) plus CJK character bigrams (contiguous runs split into
 * overlapping two-character shingles, which keeps Chinese similarity
 * meaningful without a word segmenter).
 */
export function tokenizeMemoryContent(content: string): string[] {
  const tokens: string[] = [];

  const ascii = content.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const w of ascii) if (w.length >= 2) tokens.push(w);

  const runs = content.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/** Jaccard similarity between two token multisets (0..1). */
export function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / union.size;
}

/**
 * Decide whether `candidate` is a near-duplicate of any existing entry.
 * Strong signal: high content overlap AND tag overlap. Weak signal (content
 * alone) only counts if the tags also intersect, so unrelated entries with
 * similar boilerplate don't get dropped.
 */
export function isSemanticDuplicate(
  candidate: { content: string; tags: string[] },
  existingEntries: Array<{ content: string; tags: string[] }>,
): boolean {
  const cTokens = tokenizeMemoryContent(candidate.content);

  for (const e of existingEntries) {
    const eTags = e.tags ?? [];
    // §3.1: tag intersection uses normalized equality (trim/lowercase/
    // plural-fold) instead of exact matching everywhere, incl. L1 AND here.
    const tagOverlap = eTags.some(t => candidate.tags.some(ct => equalTag(t, ct)));
    const similarity = tokenOverlap(cTokens, tokenizeMemoryContent(e.content));

    if (similarity >= 0.75 && tagOverlap) return true;          // near-identical + same topic
    if (similarity >= 0.85 && cTokens.length >= 4) return true; // essentially identical content
  }
  return false;
}

// ============================================================================
// Extraction Prompt Builder
// ============================================================================

/**
 * Build the extraction prompt for the LLM.
 * Focuses on extracting structured, reusable knowledge from the conversation.
 *
 * @param options.language - Preferred output language (native name, e.g.
 *   "简体中文"); extracted content and tags are written in this language so
 *   memories follow the app's UI language setting.
 */
export function buildExtractionPrompt(input: MemoryExtractionInput, options?: { language?: string; tagVocabulary?: string[] }): string {
  const { messages, sessionTitle } = input;

  // Build a compact transcript (max ~8000 chars to fit in mini model context).
  // Budget is counted per full message (§5.2): a message that fits is kept
  // whole; a single over-budget message takes its head and marks truncation.
  const MAX_TRANSCRIPT_CHARS = 8000;
  let transcript = '';
  let accumulatedLength = 0;
  let truncated = false;

  for (const msg of messages) {
    if (!msg.content?.trim()) continue;

    const prefix = msg.role === 'user' ? 'User'
      : msg.role === 'assistant' ? 'Assistant'
      : `Tool(${msg.toolName || 'unknown'})`;

    const line = `${prefix}: ${msg.content}`;
    if (accumulatedLength + line.length > MAX_TRANSCRIPT_CHARS) {
      if (!truncated) {
        // Single message over budget: take its head, then stop.
        const head = line.slice(0, MAX_TRANSCRIPT_CHARS - accumulatedLength);
        if (head.trim()) {
          transcript += head + '…\n\n';
          accumulatedLength += head.length + 2;
        }
        transcript += '[Note: transcript truncated at 8000 chars]\n\n';
        truncated = true;
      }
      break;
    }
    transcript += line + '\n\n';
    accumulatedLength += line.length + 2;
  }

  const titleContext = sessionTitle
    ? `Session title: "${sessionTitle}"\n`
    : '';

  const languageInstruction = options?.language
    ? `\nLanguage: Write ALL extracted knowledge in ${options.language} — content and tags must be in ${options.language}.`
    : '';

  const vocabInstruction = options?.tagVocabulary?.length
    ? `\nTag vocabulary (prefer tags from this list; only add a NEW tag when a genuinely new topic appears, at most ONE new tag per extraction, short and generic): ${options.tagVocabulary.slice(0, 80).join(', ')}`
    : '';

  return `You are a knowledge extraction specialist. Your task is to analyze a conversation transcript and extract persistent, reusable knowledge that should be remembered across future sessions.

${titleContext}${languageInstruction}${vocabInstruction}
Conversation transcript:
${transcript}

Extract knowledge in these categories:
1. **fact** — Key decisions, findings, discoveries, important conclusions from the conversation
2. **preference** — User preferences about style, tools, workflows, communication
3. **workflow** — Important multi-step processes, solutions, or procedures discovered
4. **reminder** — Action items, follow-ups, or things the user wants to be reminded about
5. **context** — Long-lived background that stays useful across many future sessions (the user's role, teams, long-term goals) — NOT per-session background like one project's current structure

NOTE: these five categories map internally to three storage types — fact/context → factual, preference/workflow → behavioral, reminder → reminder. Output the five-class type above; storage folds it automatically.

Rules:
- Each memory should be self-contained and specific (no "user is working on a project")
- **Write every memory from a third-person observer perspective and always name its subject and context** — the project, tool, error source, or domain it applies to (e.g. "While debugging the retry policy for the XYZ pipeline, the user confirmed ..."). Never write fragments that rely on this conversation to be understood (e.g. "用户已确认三个决策点" without saying what was confirmed and in which context/codebase).
- Include concrete details: names, paths, versions, configs, API endpoints
- For workflows, capture the key steps not just the topic
- Confidence: 0.9-1.0 for direct quotes/stated facts, 0.6-0.8 for inferred knowledge
- Skip anything that's already in the existing tags list below (avoid duplicates)
- Skip trivial or obvious information
- Extract at most 6 memories per extraction window. Fewer is better; an empty array is acceptable.
- Relevance test: "Would this change how I assist in a FUTURE session?" If no, skip.
- Do not extract snapshots of code or files (paths, function behavior, regexes, module structure) — the codebase is its own durable record. Extract the decision, rationale, preference, or trap behind them, not the implementation.
- Never extract session-specific transient state (what a named session did, pending calls, current error states).
- For reminders with a time meaning, output "dueAt" as an ISO 8601 timestamp (e.g. "2026-10-16T09:00:00.000Z"); otherwise omit dueAt.

Existing tags to avoid duplicating: ${(input.existingTags || []).join(', ') || 'none'}

Output ONLY a valid JSON array (no markdown, no explanation). Each entry must have:
{
  "type": "fact" | "preference" | "workflow" | "reminder" | "context",
  "content": "the extracted knowledge",
  "tags": ["tag1", "tag2"],
  "confidence": 0.9,
  "dueAt": "ISO 8601 (reminders only, optional)"
}

If nothing worth extracting is found, output an empty array: []`;
}

// ============================================================================
// Response Parser
// ============================================================================

/**
 * Parse the LLM response into structured memory entries.
 * Handles malformed responses gracefully.
 */
export function parseExtractionResponse(
  response: string | null,
  sourceSessionId: string,
  existingTags: string[] = [],
): { entries: MemoryEntry[]; discarded: number } {
  if (!response) return { entries: [], discarded: 0 };

  // Extract JSON from potential markdown code blocks
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn('[Memory/Extractor] No JSON array found in extraction response');
    return { entries: [], discarded: 1 };
  }

  try {
    const items = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
    const entries: MemoryEntry[] = [];
    let discarded = 0;

    for (const item of items) {
      let type = item.type as MemoryType;
      const content = item.content as string;
      const tags = Array.isArray(item.tags)
        ? (item.tags as string[]).map(t => String(t).toLowerCase().replace(/\s+/g, '-'))
        : [];
      const confidence = typeof item.confidence === 'number'
        ? Math.max(0, Math.min(1, item.confidence))
        : 0.7;
      const dueAt = typeof item.dueAt === 'string' && !Number.isNaN(Date.parse(item.dueAt))
        ? item.dueAt
        : undefined;

      // Validate required fields (prompt emits five-class semantics;  schema
      // accepts both five-class and already-folded three-class values).
      if (!content || !type || !['fact', 'preference', 'workflow', 'reminder', 'context', 'factual', 'behavioral'].includes(type)) {
        discarded++;
        continue;
      }
      // : fold five-class prompt output into the three-class schema before storage.
      type = foldLegacyMemoryType(type);

      // Filter out low-confidence items unless explicitly requested
      if (confidence < 0.4) {
        discarded++;
        continue;
      }

      // Deduplicate against existing tags
      const hasOverlap = existingTags.length > 0 &&
        tags.some(t => existingTags.includes(t));
      if (hasOverlap && confidence < 0.8) {
        discarded++;
        continue;
      }

      const entry: MemoryEntry = {
        id: crypto.randomUUID(),
        type,
        content,
        sourceSessionId,
        tags,
        confidence,
        createdAt: new Date().toISOString(),
        injectedCount: 0,
        ...(dueAt ? { dueAt } : {}),
      };

      entries.push(entry);
    }

    return { entries, discarded };
  } catch (error) {
    console.error('[Memory/Extractor] Failed to parse extraction response:', error);
    return { entries: [], discarded: 1 };
  }
}

// ============================================================================
// Secret redaction gate (§5.2 safety.redact)
// ============================================================================

const SECRET_PATTERN = new RegExp(
  [
    // Known credential prefixes with ≥10 remaining chars
    '\\b(?:sk-|ghp_|gho_|ghu_|xoxb-|xoxp-|AKIA|AIza)[A-Za-z0-9_-]{10,}\\b',
    // key=value / key: value adjacent after credential-ish labels
    '(?:api[_-]?key|apikey|secret|token|password|passwd|auth[_-]?token)\\s*[:=]\\s*[A-Za-z0-9._-]{10,}',
    // high-entropy base64/hex runs (32+ chars) not preceded by a word char
    '(?<!\\w)[A-Za-z0-9+/]{32,}={0,2}(?!\\w)',
  ].join('|'),
  'gi',
);

/**
 * True when the content looks like it carries a secret (credential prefix,
 * labelled key/value, or high-entropy run). Used by the redaction gate.
 */
export function containsSecret(content: string): boolean {
  SECRET_PATTERN.lastIndex = 0;
  return SECRET_PATTERN.test(content);
}

/** Replace secret-looking slices with [REDACTED] (audit-safe content). */
export function redactContent(content: string): string {
  SECRET_PATTERN.lastIndex = 0;
  return content.replace(SECRET_PATTERN, (part) => {
    // Keep label context in `(?:label): ...` matches but mask the value.
    return part.replace(/[:=]\s*\S+$/, ': [REDACTED]').replace(/^\S+$/, '[REDACTED]');
  });
}

// ============================================================================
// Main Extraction Pipeline
// ============================================================================

export interface MemoryExtractorOptions {
  /** LLM completion function (uses the same auth as the main agent) */
  runMiniCompletion: (prompt: string) => Promise<string | null>;
  /** Existing memory entries to avoid duplicates */
  existingEntries: MemoryEntry[];
  /** Whether to force extraction even if confidence is low */
  forceExtraction?: boolean;
  /** Whether to drop near-duplicates against the whole store */
  semanticDedup?: boolean;
  /** Global memory entries used for cross-store adjudication (§4). */
  globalEntries?: MemoryEntry[];
  /**
   *  controlled tag vocabulary (top-N injected into the prompt).
   * Tags from this list are preferred; new tags limited to one per pass.
   */
  tagVocabulary?: string[];
  /** Called once per candidate blocked (persistent counter / audit). */
  onDedupBlocked?: () => void;
  /** Audit callback: record a BlockedRecord (verdict already folded). */
  onBlocked?: (record: {
    candidateContent: string;
    candidateType: MemoryType;
    sourceSessionId: string;
    sourceMessageId?: string;
    matchedGlobalId?: string;
    matchedContent?: string;
    verdict: 'duplicate' | 'conflict' | 'update' | 'unrelated-shadow' | 'l1-fallback' | 'sensitive';
    reason: string;
    shadow: boolean;
  }) => void;
  /** Preferred output language (native name, e.g. "简体中文") for extracted knowledge. */
  language?: string;
  /** Override adjudication shadow mode for this pass (default: memoryConfig config). */
  adjudicationShadow?: boolean;
  /**  provenance: prompt version stamped on new entries. */
  promptVersion?: string;
  /**  provenance: source transcript message id (poisoning audit). */
  sourceMessageId?: string;
  /**
   * Which strategy triggered this pass. Keys the one-shot guard per
   * (sessionId, strategy) so an early compaction pass doesn't consume the
   * session-end slot (or vice versa). Omitted for legacy callers, which
   * keep the old "any extraction from this session" behavior.
   */
  strategy?: 'compaction' | 'session_end';
}

/**
 * Extract memories from a session transcript and add them to the store.
 * Returns the extraction record for logging.
 */
export async function extractMemories(
  input: MemoryExtractionInput,
  store: MemoryStore | SessionMemoryStore,
  options: MemoryExtractorOptions,
): Promise<MemoryExtractionRecord> {
  const { runMiniCompletion, existingEntries, forceExtraction = false, semanticDedup = false, globalEntries } = options;

  // Build list of existing tags for deduplication
  const existingTags = [
    ...new Set(existingEntries.flatMap(e => e.tags)),
  ];

  // Check if we already extracted from this session via the SAME strategy.
  // When no strategy is passed (legacy callers), fall back to the original
  // "any extraction from this session" guard so old behavior is preserved.
  const strategy = options.strategy;
  const extractionHistory = store.extractionHistory;
  const isSessionStore = !('totalInjectionTokens' in store);
  const alreadyExtracted = !isSessionStore && extractionHistory.some(
    h => h.sessionId === input.sessionId
      && (strategy === undefined ? true : h.strategy === strategy),
  );
  if (alreadyExtracted && !forceExtraction) {
    return {
      sessionId: input.sessionId,
      timestamp: new Date().toISOString(),
      factsExtracted: 0,
      factsDiscarded: 0,
      newEntryIds: [],
    };
  }

  // Build and send extraction prompt (with  vocabulary guidance)
  const prompt = buildExtractionPrompt(input, { language: options.language, tagVocabulary: options.tagVocabulary });
  const response = await runMiniCompletion(prompt);
  if (response === null) throw new Error('Memory extraction returned an empty response');

  const { entries, discarded } = parseExtractionResponse(
    response,
    input.sessionId,
    existingTags,
  );

  // redaction gate (§5.2): secrets never reach storage; record as 'sensitive'.
  const redacted = entries.filter(e => {
    if (!memoryConfig.safety.redact || !containsSecret(e.content)) return true;
    options.onBlocked?.({
      candidateContent: redactContent(e.content),
      candidateType: e.type,
      sourceSessionId: e.sourceSessionId,
      sourceMessageId: options.sourceMessageId,
      verdict: 'sensitive',
      reason: 'secret pattern detected',
      shadow: false,
    });
    return false;
  });
  const discardedTotal = discarded + (entries.length - redacted.length);

  // adjudication pipeline (§4.1-4.4, left column): cross-store verdicts
  // replace the P0-4 blind-steering for the NEW candidates (session-internal
  // dedup stays untouched below). When adjudication is disabled, the old
  // P0-4 blind drop (isSemanticDuplicate vs global pool) remains as fallback.
  const verdicts = memoryConfig.adjudication.enabled && globalEntries?.length
    ? await adjudicateCandidates(redacted, globalEntries, {
        runMiniCompletion,
        shadow: options.adjudicationShadow ?? memoryConfig.adjudication.shadow,
      })
    : null;

  // Markings produced at extraction time (consumed only at promotion, §架构原则).
  const conflictMark = new Map<string, string[]>();
  const mergeMark = new Map<string, string[]>();
  if (verdicts) {
    for (const entry of redacted) {
      const r = verdicts.get(entry.id);
      if (!r) continue;
      if (r.verdict === 'conflict' && r.targetId) conflictMark.set(entry.id, [r.targetId]);
      if (r.verdict === 'update' && r.targetId) mergeMark.set(entry.id, [r.targetId]);
    }
  }

  // Add entries to store
  const newEntryIds: string[] = [];
  for (const entry of redacted) {
    const existing = store.entries.find(e =>
      e.content === entry.content && e.sourceSessionId === entry.sourceSessionId,
    );
    if (existing) continue;

    if (verdicts) {
      const r = verdicts.get(entry.id);
      if (r && r.verdict !== 'unrelated') {
        const target = r.target;
        const record = (reason: string) => options.onBlocked?.({
          candidateContent: entry.content,
          candidateType: entry.type,
          sourceSessionId: entry.sourceSessionId,
          sourceMessageId: options.sourceMessageId ?? undefined,
          matchedGlobalId: target?.id,
          matchedContent: target?.content,
          verdict: (r.verdict === 'duplicate'
            ? (r.fallback === 'l1-fallback' ? 'l1-fallback' : 'duplicate')
            : r.verdict === 'unrelated' ? 'unrelated-shadow' : r.verdict) as 'duplicate' | 'conflict' | 'update' | 'unrelated-shadow' | 'l1-fallback',
          reason,
          shadow: r.shadow,
        });
        if (r.verdict === 'duplicate') {
          record(r.fallback === 'l1-fallback' ? 'L3 exhausted l1-fallback' : r.reason)
          options.onDedupBlocked?.()
          // l1-fallback 降级：P0-4 语义不受 shadow 影响，总是丢弃高置信命中
          if (r.fallback === 'l1-fallback') continue
          if (!r.shadow) continue   // 真实模式丢弃
          // shadow → observe only, write through
        } else if (r.verdict === 'conflict') {
          record(r.reason)
        } else if (r.verdict === 'update') {
          record(r.reason)
        } else {
          record(r.reason)
        }
      }
      // unrelated → write through (no audit record needed)
    } else {
      // P0-4 fallback: blind cross-store dedup against global + session pool.
      const dedupPool = globalEntries?.length
        ? [...store.entries, ...globalEntries]
        : store.entries;
      if (semanticDedup && isSemanticDuplicate(entry, dedupPool)) {
        console.debug(`[Memory/Extractor] Cross-store duplicate blocked: ${entry.content.slice(0, 80)}`)
        options.onDedupBlocked?.()
        continue
      }
    }

    const newEntry = addMemoryEntry(store, entry.content, entry.type, entry.sourceSessionId, entry.tags, entry.confidence, {
      promptVersion: options.promptVersion ?? 'extract-v3',
      sourceMessageId: options.sourceMessageId ?? undefined,
      dueAt: entry.dueAt ?? undefined,
      conflictWith: conflictMark.get(entry.id),
      mergeWith: mergeMark.get(entry.id),
    });
    newEntryIds.push(newEntry.id);
  }

  // Record extraction
  const extractionRecord: MemoryExtractionRecord = {
    sessionId: input.sessionId,
    timestamp: new Date().toISOString(),
    factsExtracted: entries.length,
    factsDiscarded: discardedTotal,
    newEntryIds,
    ...(strategy !== undefined ? { strategy } : {}),
  };
  if ('totalInjectionTokens' in store) {
    recordExtraction(store as MemoryStore, extractionRecord);
  } else {
    const sessionStore = store as SessionMemoryStore;
    sessionStore.extractionHistory.push(extractionRecord);
    sessionStore.extractionHistory = sessionStore.extractionHistory.slice(-100);
  }

  return {
    sessionId: input.sessionId,
    timestamp: new Date().toISOString(),
    factsExtracted: entries.length,
    factsDiscarded: discarded,
    newEntryIds,
  };
}
