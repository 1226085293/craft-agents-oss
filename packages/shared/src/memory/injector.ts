/**
 * Memory Injector — Injects relevant memories into session context.
 *
 * Selects memories based on topical relevance and injects them into
 * the system prompt for enhanced cross-session continuity.
 *
 * Retrieval design (mechanism-level, not tuned to any single incident):
 * - Multilingual keyword extraction: English tokens AND Chinese words (via
 *   Intl.Segmenter) both become search keywords, so CJK-only phrasing can
 *   recall CJK memories.
 * - Message-authority weighting: user-message keywords outrank assistant/tool
 *   noise, so the current request's intent is never squeezed out by a long
 *   assistant reply even when the keyword budget is tight.
 * - Hierarchical tag matching: exact/prefix tag hits score more than loose
 *   substring hits, so broad labels (e.g. `craft-agent`) don't dominate.
 * - Behavioral quota: user-intent memories (preference/workflow/reminder)
 *   keep reserved slots so high-scoring background knowledge can't crowd
 *   out instruction-like memories.
 */

import type {
  MemoryEntry,
  MemoryStore,
  SessionMemoryStore,
  MemoryInjectionConfig,
} from './types.ts';
import { DEFAULT_MEMORY_INJECTION_CONFIG, isBehavioralMemoryType } from './types.ts';
import { markMemoryInjected } from './store.ts';

// ============================================================================
// Keyword Extraction (multilingual + message-authority weighted)
// ============================================================================

/** A single extracted keyword with its authority weight. */
export interface WeightedKeyword {
  term: string;
  weight: number;
}

// Stop words — English (>=3 chars) and Chinese common filler. Keep minimal so
// we never accidentally drop real technical terms.
const STOP_WORDS_EN = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'from', 'that', 'this',
  'have', 'has', 'had', 'not', 'but', 'you', 'your', 'our', 'will', 'would',
  'can', 'could', 'should', 'should', 'been', 'being', 'they', 'them', 'their',
  'there', 'here', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'how', 'why', 'all', 'any', 'some', 'more', 'most', 'new', 'old', 'one',
  'two', 'use', 'used', 'using', 'get', 'got', 'make', 'made', 'like', 'just',
  'very', 'also', 'can', 'then', 'than', 'into', 'out', 'off', 'over', 'under',
  'again', 'once', 'after', 'before', 'other', 'only', 'very', 'both', 'well',
  'will', 'did', 'does', 'doing', 'about', 'above', 'down', 'up', 'back',
  'still', 'even', 'much', 'many', 'same', 'such', 'no', 'nor', 'not', 'too',
  'way', 'need', 'want', 'goes', 'going', 'been', 'come', 'came', 'get',
]);

const STOP_WORDS_ZH = new Set([
  '一个', '一些', '我们', '你们', '他们', '这个', '那个', '这些', '那些',
  '可以', '应该', '需要', '进行', '然后', '已经', '没有', '因为', '所以',
  '如果', '自己', '就是', '一个', '两个', '这次', '下次', '现在', '以后',
  '之前', '之后', '时候', '东西', '事情', '工作', '进行', '出来', '过去',
  '通过', '对于', '关于', '还有', '其他', '如此', '这样', '那样',
]);

/** Shared Intl.Segmenter for CJK word splitting (created lazily once). */
let zhSegmenter: Intl.Segmenter | null = null;
function getZhSegmenter(): Intl.Segmenter | null {
  try {
    if (!zhSegmenter) zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    return zhSegmenter;
  } catch {
    return null; // Older runtimes: fall back to English-only extraction.
  }
}

/** Split a single message into lowercase terms (EN words + CJK words). */
function tokenizeText(text: string): string[] {
  const terms: string[] = [];
  const seg = getZhSegmenter();
  if (seg) {
    // `Intl.Segmenter('zh', {granularity:'word'})` splits vocabulary words
    // (更新/版本) as whole tokens but unknown words into single characters
    // (发版 → 发+版). Buffer consecutive single CJK chars and emit bigrams
    // so such words still surface as searchable terms.
    const singletonBuffer: string[] = [];
    const flushBuffer = () => {
      if (singletonBuffer.length >= 2) {
        for (let i = 0; i + 1 < singletonBuffer.length; i++) {
          const a = singletonBuffer[i];
          const b = singletonBuffer[i + 1];
          if (a === undefined || b === undefined) continue;
          const bigram = a + b;
          if (bigram.length === 2 && !STOP_WORDS_ZH.has(bigram)) terms.push(bigram);
        }
      }
      singletonBuffer.length = 0;
    };

    for (const part of seg.segment(text)) {
      const w = part.segment?.trim() ?? '';
      if (!w) continue;
      // English/numeric words: >= 3 chars
      if (/^[a-z0-9][a-z0-9._-]*$/i.test(w) && w.length >= 3) {
        flushBuffer();
        if (!STOP_WORDS_EN.has(w.toLowerCase())) terms.push(w.toLowerCase());
        continue;
      }
      // CJK: known multi-char words pass through; single chars are buffered
      if (/^[\u4e00-\u9fff]+$/u.test(w)) {
        if (w.length >= 2) {
          flushBuffer();
          if (!STOP_WORDS_ZH.has(w)) terms.push(w);
        } else {
          singletonBuffer.push(w);
        }
        continue;
      }
      // Other (punctuation/whitespace/digits): reset buffer
      flushBuffer();
    }
    flushBuffer();
  } else {
    // Fallback: plain ASCII keywords
    for (const w of (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])) {
      if (!STOP_WORDS_EN.has(w)) terms.push(w);
    }
  }
  return terms;
}

/**
 * Extract weighted keywords from recent conversation messages.
 *
 * Weights reflect message authority (user > assistant > tool) and recency:
 * the newest user message is the strongest intent signal. The final list is
 * sorted by weight so budget truncation (`maxKeywords`) drops the least
 * authoritative terms first — a long assistant reply can never displace the
 * user's own request keywords.
 */
export function extractWeightedKeywords(
  recentMessages: Array<{ role: string; content?: string }>,
  maxKeywords: number = 24,
): WeightedKeyword[] {
  const weights = new Map<string, number>();
  const n = recentMessages.length;

  const addTerms = (terms: string[], baseWeight: number) => {
    for (const term of terms) {
      if (term.length < 2) continue;
      weights.set(term, Math.max(weights.get(term) ?? 0, baseWeight));
    }
  };

  for (let i = 0; i < n; i++) {
    const msg = recentMessages[i];
    if (!msg?.content) continue;
    const recencyBoost = 0.8 + (0.2 * (i + 1)) / Math.max(1, n); // later = fresher
    let base: number;
    switch (msg.role) {
      case 'user': base = 2.0; break;
      case 'assistant': base = 1.0; break;
      default: base = 0.4; // tool content is noisy
    }
    addTerms(tokenizeText(String(msg.content)), base * recencyBoost);
  }

  return Array.from(weights.entries())
    .map(([term, weight]) => ({ term, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxKeywords);
}

/**
 * Extract keywords from recent conversation messages for relevance scoring.
 * Returns just the terms (ordered by authority). Kept for API compatibility.
 */
export function extractContextKeywords(
  recentMessages: Array<{ role: string; content?: string }>,
  maxKeywords: number = 15,
): string[] {
  return extractWeightedKeywords(recentMessages, maxKeywords).map(k => k.term);
}

// ============================================================================
// Relevance Scoring (weighted keywords + hierarchical tag match)
// ============================================================================

/**
 * Score a memory's relevance to the current conversation context.
 * Higher score = more relevant.
 *
 * Returns:
 * - `topical` — the keyword/tag signal ONLY (gated by minRelevanceScore).
 * - `total`   — ranking score: topical + confidence + recency floor −
 *   freshness penalty for heavily-injected memories.
 *
 * Score rules:
 * - Keyword hit in content: +2 × kw.weight (weight ∝ message authority)
 * - Tag EXACT or PREFIX match with keyword/priority tag: +3 (strong signal)
 * - Tag substring match: +1 (weak — broad labels like `craft-agent` match
 *   many keywords, so they must not dominate)
 * - Priority tag (explicit config): +5
 */
function scoreMemoryRelevance(
  entry: MemoryEntry,
  keywords: WeightedKeyword[],
  priorityTags: string[],
  idf: Map<string, number> = new Map(),
): { total: number; topical: number } {
  let topical = 0;
  const contentLower = entry.content.toLowerCase();

  const isExactTagHit = (tag: string, term: string): boolean =>
    tag === term || tag.startsWith(term + '-') || tag.startsWith(term + '_') ||
    term.startsWith(tag + '-') || term.startsWith(tag + '_');

  for (const kw of keywords) {
    const term = kw.term.toLowerCase();
    const idfW = Math.max(0.25, idf.get(term) ?? 1.2); // clamp so rare terms boost but common terms don't vanish
    if (contentLower.includes(term)) {
      topical += 2 * kw.weight * idfW;
    }
  }

  for (const tagRaw of entry.tags) {
    const tag = tagRaw.toLowerCase();
    if (priorityTags.includes(tag)) {
      topical += 5;
      continue;
    }
    for (const kw of keywords) {
      const term = kw.term.toLowerCase();
      const idfW = idf.get(term) ?? 1.0;
      if (isExactTagHit(tag, term)) {
        topical += 4 * kw.weight * idfW;
        break;
      }
      if (tag.includes(term) || term.includes(tag)) {
        topical += 1 * kw.weight * idfW;
      }
    }
  }

  const daysSinceCreated = (Date.now() - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const total =
    topical
    + entry.confidence * 2
    + Math.max(0, 2 - daysSinceCreated / 30) // Recency bonus, decays over 30 days
    - Math.min(entry.injectedCount * 0.3, 2); // Freshness penalty

  return { total, topical };
}

// ============================================================================
// Memory Selection (behavioral quota + token budget)
// ============================================================================

interface ScoredEntry {
  entry: MemoryEntry;
  total: number;
  topical: number;
}

/** Filter the store's entries to the eligible pool (excluded tags, expiry). */
function poolEntries(store: MemoryStore, excludedTags: string[]): MemoryEntry[] {
  return store.entries.filter(entry => {
    if (excludedTags.some(tag => entry.tags.includes(tag))) return false;
    if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) return false;
    return true;
  });
}

/**
 * Compute an inverse-document-frequency multiplier per keyword across the
 * candidate memory pool. Terms that appear in many memories (e.g. a product
 * name like `craft`, or generic words like `问题`) carry less discriminating
 * power, so their effective contribution is damped. Rare distinctive terms
 * (e.g. `更新`, `docs`, `decrypt`) are amplified.
 *
 * idf = 1 + ln((N+1) / (df+1)); N = pool size, df = docs containing the term.
 * Pool size 0 or missing terms are treated as df=0 (full weight).
 */
function computeKeywordIdf(keywords: WeightedKeyword[], entries: MemoryEntry[]): Map<string, number> {
  const df = new Map<string, number>();
  const n = entries.length;
  if (n === 0) return new Map();

  const seen = new Set<string>();
  for (const entry of entries) {
    seen.clear();
    const hay = [entry.content.toLowerCase(), ...entry.tags.map(t => t.toLowerCase())].join('\u0001');
    for (const kw of keywords) {
      const term = kw.term.toLowerCase();
      if (seen.has(term)) continue;
      if (hay.includes(term)) {
        seen.add(term);
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }
  }

  const idf = new Map<string, number>();
  for (const kw of keywords) {
    const dfv = df.get(kw.term.toLowerCase()) ?? 0;
    idf.set(kw.term.toLowerCase(), 1 + Math.log((n + 1) / (dfv + 1)));
  }
  return idf;
}

/**
 * Select relevant memories for injection into the current session.
 *
 * Selection is two-tier:
 * 1. Behavioral memories (preference/workflow/reminder) pass a relaxed gate
 *    (`minBehavioralRelevanceScore`) and get up to `behavioralQuota` reserved
 *    seats — instruction-like memories are never flooded out entirely.
 * 2. Remaining seats are filled from knowledge memories (fact/context) that
 *    pass the stricter gate (`minRelevanceScore`), ordered by score.
 * If one tier has no qualifying memories, its seats roll over to the other.
 */
export function selectRelevantMemoriesFromScopes(
  globalStore: MemoryStore,
  sessionStore: SessionMemoryStore,
  recentMessages: Array<{ role: string; content?: string }>,
  config: MemoryInjectionConfig = DEFAULT_MEMORY_INJECTION_CONFIG,
): MemoryEntry[] {
  const sessionEntries = sessionStore.entries.filter(entry => entry.sourceSessionId === sessionStore.sessionId);
  const combined: MemoryStore = { ...globalStore, entries: [...globalStore.entries, ...sessionEntries] };
  return selectRelevantMemories(combined, recentMessages, config);
}

export function selectRelevantMemories(
  store: MemoryStore,
  recentMessages: Array<{ role: string; content?: string }>,
  config: MemoryInjectionConfig = DEFAULT_MEMORY_INJECTION_CONFIG,
): MemoryEntry[] {
  const {
    maxMemories,
    maxTokens,
    priorityTags,
    excludedTags,
    minRelevanceScore,
    minBehavioralRelevanceScore,
    behavioralQuota,
  } = config;

  const keywords = extractWeightedKeywords(recentMessages, 30);
  const pool = poolEntries(store, excludedTags);

  // IDF: dampen generic/high-frequency terms so they don't dominate scoring
  const idf = computeKeywordIdf(keywords, pool);

  // Score all entries
  const scored: ScoredEntry[] = pool
    .map(entry => {
      const { total, topical } = scoreMemoryRelevance(entry, keywords, priorityTags, idf);
      return { entry, total, topical };
    });

  // Tier split with per-tier gates
  const behavioral: ScoredEntry[] = scored
    .filter(({ entry, topical }) => isBehavioralMemoryType(entry.type) && topical >= minBehavioralRelevanceScore)
    .sort((a, b) => b.total - a.total);
  const knowledge: ScoredEntry[] = scored
    .filter(({ entry, topical }) => !isBehavioralMemoryType(entry.type) && topical >= minRelevanceScore)
    .sort((a, b) => b.total - a.total);

  const selected: MemoryEntry[] = [];
  let totalTokens = 0;

  const tryAdd = (item: ScoredEntry): boolean => {
    const entryTokens = Math.ceil(item.entry.content.length / 4) + item.entry.tags.length * 2;
    if (totalTokens + entryTokens > maxTokens) return false;
    if (selected.length >= maxMemories) return false;
    selected.push(item.entry);
    totalTokens += entryTokens;
    return true;
  };

  // Step 1: reserved behavioral seats (only as many as qualify)
  let added = 0;
  for (const item of behavioral) {
    if (added >= behavioralQuota) break;
    if (tryAdd(item)) added++;
  }

  // Step 2: fill remaining seats with knowledge (highest score first)
  for (const item of knowledge) {
    if (selected.length >= maxMemories) break;
    tryAdd(item);
  }

  // Step 3: if seats remain (e.g. knowledge tier exhausted), take the rest of
  // the behavioral tier that passed the gate.
  for (const item of behavioral) {
    if (selected.length >= maxMemories) break;
    if (selected.includes(item.entry)) continue;
    tryAdd(item);
  }

  // Mark selected as injected (persisted separately)
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
    lines.push('');
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