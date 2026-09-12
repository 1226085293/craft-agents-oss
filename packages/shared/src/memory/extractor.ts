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
  MemoryExtractionRecord,
} from './types.ts';
import { addMemoryEntry, recordExtraction } from './store.ts';

// ============================================================================
// Extraction Prompt Builder
// ============================================================================

/**
 * Build the extraction prompt for the LLM.
 * Focuses on extracting structured, reusable knowledge from the conversation.
 */
export function buildExtractionPrompt(input: MemoryExtractionInput): string {
  const { messages, sessionTitle } = input;

  // Build a compact transcript (max ~8000 chars to fit in mini model context)
  const MAX_TRANSCRIPT_CHARS = 8000;
  let transcript = '';
  let accumulatedLength = 0;

  for (const msg of messages) {
    if (!msg.content?.trim()) continue;

    const prefix = msg.role === 'user' ? 'User'
      : msg.role === 'assistant' ? 'Assistant'
      : `Tool(${msg.toolName || 'unknown'})`;

    const line = `${prefix}: ${msg.content}`;
    if (accumulatedLength + line.length > MAX_TRANSCRIPT_CHARS) break;
    transcript += line + '\n\n';
    accumulatedLength += line.length + 2;
  }

  const titleContext = sessionTitle
    ? `Session title: "${sessionTitle}"\n`
    : '';

  return `You are a knowledge extraction specialist. Your task is to analyze a conversation transcript and extract persistent, reusable knowledge that should be remembered across future sessions.

${titleContext}
Conversation transcript:
${transcript}

Extract knowledge in these categories:
1. **fact** — Key decisions, findings, discoveries, important conclusions from the conversation
2. **preference** — User preferences about style, tools, workflows, communication
3. **workflow** — Important multi-step processes, solutions, or procedures discovered
4. **reminder** — Action items, follow-ups, or things the user wants to be reminded about
5. **context** — Background information that will be useful for future conversations (project structure, tech stack, domain knowledge)

Rules:
- Each memory should be self-contained and specific (no "user is working on a project")
- Include concrete details: names, paths, versions, configs, API endpoints
- For workflows, capture the key steps not just the topic
- Confidence: 0.9-1.0 for direct quotes/stated facts, 0.6-0.8 for inferred knowledge
- Skip anything that's already in the existing tags list below (avoid duplicates)
- Skip trivial or obvious information

Existing tags to avoid duplicating: ${(input.existingTags || []).join(', ') || 'none'}

Output ONLY a valid JSON array (no markdown, no explanation). Each entry must have:
{
  "type": "fact" | "preference" | "workflow" | "reminder" | "context",
  "content": "the extracted knowledge",
  "tags": ["tag1", "tag2"],
  "confidence": 0.9
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
      const type = item.type as MemoryType;
      const content = item.content as string;
      const tags = Array.isArray(item.tags)
        ? (item.tags as string[]).map(t => String(t).toLowerCase().replace(/\s+/g, '-'))
        : [];
      const confidence = typeof item.confidence === 'number'
        ? Math.max(0, Math.min(1, item.confidence))
        : 0.7;

      // Validate required fields
      if (!content || !type || !['fact', 'preference', 'workflow', 'reminder', 'context'].includes(type)) {
        discarded++;
        continue;
      }

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
// Main Extraction Pipeline
// ============================================================================

export interface MemoryExtractorOptions {
  /** LLM completion function (uses the same auth as the main agent) */
  runMiniCompletion: (prompt: string) => Promise<string | null>;
  /** Existing memory entries to avoid duplicates */
  existingEntries: MemoryEntry[];
  /** Whether to force extraction even if confidence is low */
  forceExtraction?: boolean;
}

/**
 * Extract memories from a session transcript and add them to the store.
 * Returns the extraction record for logging.
 */
export async function extractMemories(
  input: MemoryExtractionInput,
  store: MemoryStore,
  options: MemoryExtractorOptions,
): Promise<MemoryExtractionRecord> {
  const { runMiniCompletion, existingEntries, forceExtraction = false } = options;

  // Build list of existing tags for deduplication
  const existingTags = [
    ...new Set(existingEntries.flatMap(e => e.tags)),
  ];

  // Check if we already extracted from this session
  const alreadyExtracted = store.extractionHistory.some(
    h => h.sessionId === input.sessionId,
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

  // Build and send extraction prompt
  const prompt = buildExtractionPrompt(input);
  const response = await runMiniCompletion(prompt);

  const { entries, discarded } = parseExtractionResponse(
    response,
    input.sessionId,
    existingTags,
  );

  // Add entries to store
  const newEntryIds: string[] = [];
  for (const entry of entries) {
    const existing = store.entries.find(e =>
      e.content === entry.content && e.sourceSessionId === entry.sourceSessionId,
    );
    if (!existing) {
      const newEntry = addMemoryEntry(store, entry.content, entry.type, entry.sourceSessionId, entry.tags, entry.confidence);
      newEntryIds.push(newEntry.id);
    }
  }

  // Record extraction
  recordExtraction(store, {
    sessionId: input.sessionId,
    factsExtracted: entries.length,
    factsDiscarded: discarded,
    newEntryIds,
  });

  return {
    sessionId: input.sessionId,
    timestamp: new Date().toISOString(),
    factsExtracted: entries.length,
    factsDiscarded: discarded,
    newEntryIds,
  };
}

/**
 * Count estimated tokens in messages (rough approximation).
 */
export function estimateMemoryExtractionTokens(messages: MemoryExtractionInput['messages']): number {
  return messages.reduce((acc, msg) => {
    if (!msg.content) return acc;
    return acc + Math.ceil(msg.content.length / 4);
  }, 0);
}
