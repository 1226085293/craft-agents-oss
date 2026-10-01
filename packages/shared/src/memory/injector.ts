/**
 * Memory Injector — Injects relevant memories into session context.
 *
 * Selects memories based on topic relevance and injects them into
 * the system prompt for enhanced cross-session continuity.
 */

import type {
  MemoryEntry,
  MemoryStore,
  MemoryInjectionConfig,
} from './types.ts';
import { DEFAULT_MEMORY_INJECTION_CONFIG } from './types.ts';
import { markMemoryInjected } from './store.ts';
import { getMemoryStats } from './store.ts';

// ============================================================================
// Relevance Scoring
// ============================================================================

/**
 * Score a memory's relevance to the current conversation context.
 * Higher score = more relevant.
 *
 * Returns both:
 * - `topical` — the keyword/tag signal ONLY (how well the memory's content/tags
 *   match the conversation). This is what actually measures relevance and is what
 *   the `minRelevanceScore` gate applies to.
 * - `total`   — the ranking score used to order eligible memories. It adds a
 *   confidence + recency "freshness" floor on top of `topical`; that floor is
 *   deliberately NOT used for the gate, otherwise off-topic but fresh entries
 *   would always crowd in.
 */
function scoreMemoryRelevance(
  entry: MemoryEntry,
  contextKeywords: string[],
  priorityTags: string[],
): { total: number; topical: number } {
  let topical = 0;
  const contentLower = entry.content.toLowerCase();
  const allTags = [...entry.tags];

  // Topical signal: keyword matches in content
  for (const keyword of contextKeywords) {
    if (contentLower.includes(keyword.toLowerCase())) {
      topical += 2;
    }
  }

  // Topical signal: tag matches with priority boost
  for (const tag of allTags) {
    if (priorityTags.includes(tag)) {
      topical += 5;
    } else if (contextKeywords.some(kw => tag.includes(kw.toLowerCase()) || kw.toLowerCase().includes(tag))) {
      topical += 2;
    }
  }

  // Ranking total = topical signal + confidence + recency floor - freshness penalty
  const daysSinceCreated = (Date.now() - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const total =
    topical
    + entry.confidence * 2
    + Math.max(0, 2 - daysSinceCreated / 30) // Recency bonus, decays over 30 days
    - Math.min(entry.injectedCount * 0.3, 2); // Freshness penalty for heavily-injected memories

  return { total, topical };
}

// ============================================================================
// Context Keyword Extraction
// ============================================================================

/**
 * Extract keywords from recent conversation messages for relevance scoring.
 * Uses simple heuristic: nouns and key phrases from user/assistant messages.
 */
export function extractContextKeywords(
  recentMessages: Array<{ role: string; content?: string }>,
  maxKeywords: number = 15,
): string[] {
  const keywords = new Set<string>();

  for (const msg of recentMessages.slice(-20)) {
    if (!msg.content) continue;
    const text = msg.content.toLowerCase();

    // Extract potential keywords: camelCase, UPPER_SNAKE, and multi-word phrases
    const candidates = text.match(/[a-z][a-z0-9]{3,}/g) || [];
    for (const word of candidates) {
      // Skip common stop words
      if (word.length < 4) continue;
      keywords.add(word);
    }
  }

  // Also extract from message roles/tools for context
  for (const msg of recentMessages.slice(-10)) {
    if (msg.role === 'tool' && msg.content) {
      const toolMatches = msg.content.match(/["'][\w.]+["']/g) || [];
      for (const match of toolMatches) {
        keywords.add(match.replace(/"/g, '').replace(/'/g, ''));
      }
    }
  }

  return Array.from(keywords).slice(0, maxKeywords);
}

// ============================================================================
// Memory Selection
// ============================================================================

/**
 * Select relevant memories for injection into the current session.
 */
export function selectRelevantMemories(
  store: MemoryStore,
  recentMessages: Array<{ role: string; content?: string }>,
  config: MemoryInjectionConfig = DEFAULT_MEMORY_INJECTION_CONFIG,
): MemoryEntry[] {
  const { maxMemories, maxTokens, priorityTags, excludedTags, minRelevanceScore } = config;

  const contextKeywords = extractContextKeywords(recentMessages);

  // Score all entries
  const scored = store.entries
    .filter(entry => {
      // Exclude tagged entries
      if (excludedTags.some(tag => entry.tags.includes(tag))) return false;
      // Skip expired entries
      if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) return false;
      return true;
    })
    .map(entry => {
      const { total, topical } = scoreMemoryRelevance(entry, contextKeywords, priorityTags);
      return { entry, total, topical };
    })
    // Gate on TOPICAL relevance: an entry with no keyword/tag signal to the
    // current conversation is not injected, even if fresh or high-confidence.
    .filter(item => item.topical >= minRelevanceScore)
    .sort((a, b) => b.total - a.total);

  // Select top entries within token budget
  const selected: MemoryEntry[] = [];
  let totalTokens = 0;

  for (const { entry } of scored) {
    if (selected.length >= maxMemories) break;

    // Estimate tokens for this entry
    const entryTokens = Math.ceil(entry.content.length / 4) + entry.tags.length * 2;
    if (totalTokens + entryTokens > maxTokens) continue;

    selected.push(entry);
    totalTokens += entryTokens;
  }

  // Mark selected as injected (will be persisted separately)
  for (const entry of selected) {
    markMemoryInjected(store, entry.id);
  }

  return selected;
}

// ============================================================================
// Context Building
// ============================================================================

/**
 * Build the memory context string to inject into the system prompt.
 */
export function buildMemoryContext(
  memories: MemoryEntry[],
  includeMeta: boolean = true,
): string {
  if (memories.length === 0) return '';

  const lines: string[] = [];

  if (includeMeta) {
    lines.push('<cross_session_memory>');
    lines.push('The following memories from previous conversations may be relevant:');
    lines.push('');
  }

  // Group by type for better organization
  const grouped: Record<string, MemoryEntry[]> = {
    fact: [],
    preference: [],
    workflow: [],
    reminder: [],
    context: [],
  };

  for (const entry of memories) {
    if (grouped[entry.type]) {
      grouped[entry.type]?.push(entry);
    }
  }

  const typeLabels: Record<string, string> = {
    fact: '📋 Facts',
    preference: '💡 Preferences',
    workflow: '⚙️ Workflows',
    reminder: '🔔 Reminders',
    context: '📌 Context',
  };

  for (const [type, entries] of Object.entries(grouped)) {
    if (entries.length === 0) continue;

    lines.push(`[${typeLabels[type] || type}]`);
    for (const entry of entries) {
      const tagStr = entry.tags.length > 0 ? ` #${entry.tags.join(' #')}` : '';
      lines.push(`  • ${entry.content}${tagStr}`);
    }
    lines.push('');
  }

  if (includeMeta) {
    lines.push('</cross_session_memory>');
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Integration Helpers
// ============================================================================

/**
 * Format memories for the system prompt (compact version).
 */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';

  return memories.map(m => `[${m.type}] ${m.content}`).join('\n');
}

/**
 * Check if there are any memories available for injection.
 */
export function hasMemories(store: MemoryStore): boolean {
  const now = new Date().toISOString();
  return store.entries.some(e => !e.expiresAt || e.expiresAt > now);
}

/**
 * Get a preview of what memories would be injected (for debugging/UI).
 */
export function previewMemoryInjection(
  store: MemoryStore,
  recentMessages: Array<{ role: string; content?: string }>,
  config?: MemoryInjectionConfig,
): {
  selected: MemoryEntry[];
  estimatedTokens: number;
  contextSnippet: string;
} {
  const selected = selectRelevantMemories(store, recentMessages, config ?? DEFAULT_MEMORY_INJECTION_CONFIG);
  const context = buildMemoryContext(selected, false);
  const estimatedTokens = Math.ceil(context.length / 4);

  return {
    selected,
    estimatedTokens,
    contextSnippet: context.slice(0, 200) + (context.length > 200 ? '...' : ''),
  };
}
