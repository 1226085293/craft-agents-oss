/**
 * Local embedding engine — bge-small-zh-v1.5 (ONNX, bundled) via
 * transformers.js. Single-track semantic retrieval for memory:
 *
 *   - Lazy singleton pipeline: first encode() pays ~340ms model load, then
 *     3–4ms per query. Model path resolved from config (user override ??
 *     bundled resources/models/bge-small-zh-v1.5).
 *   - Encode is L2-normalized so cosine similarity == dot product.
 *   - Memory entries carry `embedding: number[]` (512-dim). Legacy entries
 *     without one are backfilled on demand (read-path fallback) or in bulk
 *     at startup (backfillStoreEmbeddings).
 *
 * Ships with the pi-agent-server bundle via dynamic import so the dependency
 * stays external (@huggingface/transformers resolved from node_modules at
 * runtime, packaged through electron-builder extraResources).
 */

type ExtractorFn = (text: string, opts?: { pooling?: string; normalize?: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

let pipelinePromise: Promise<unknown> | null = null;
let extractor: ExtractorFn | null = null;
let resolvedModelDir: string | null = null;

const EMBEDDING_DIM = 512;

/** Resolve the embedding model directory (user override ?? bundled default). */
function resolveModelDir(): string | undefined {
  // Env override first — tests / packaged builds can point anywhere.
  const envPath = process.env.MEMORY_EMBEDDING_MODEL_PATH;
  if (envPath) return envPath;
  // Lazy import to avoid a hard dependency on config/storage at module load
  // (session-tools-core must stay free of @craft-agent/shared runtime deps).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEmbeddingModelPath } = require('../config/storage.ts') as { getEmbeddingModelPath?: () => string | undefined };
    return getEmbeddingModelPath?.() ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load the pipeline once (idempotent). Returns the extractor callable.
 * Model dir is resolved lazily on first call so a config change (Settings →
 * AI → embedding path) is picked up after a restart without stale cache.
 */
async function getExtractor(): Promise<ExtractorFn> {
  if (extractor) return extractor;
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const modelDir = resolveModelDir();
      if (!modelDir) throw new Error('[memory/embedding] No embedding model path resolved');
      const { pipeline } = await import('@huggingface/transformers');
      // dtype q8 = int8 quantization (matches bundled model_quantized.onnx);
      // pooling mean + normalize so cosine == dot product.
      const extractor = await pipeline('feature-extraction', modelDir, { dtype: 'q8' });
      resolvedModelDir = modelDir;
      return extractor as unknown;
    })();
  }
  try {
    extractor = (await pipelinePromise) as ExtractorFn;
    return extractor;
  } catch (error) {
    pipelinePromise = null; // allow retry on next call (e.g. path fixed)
    throw error;
  }
}

/** Convert Float32Array (or any array) to a plain number[] for JSON storage. */
function toNumberArray(data: Float32Array): number[] {
  return Array.from(data);
}

/**
 * Encode a single text as an L2-normalized embedding vector.
 * Returns number[] (plain) for JSON store-compatibility.
 */
export async function encodeText(text: string): Promise<number[]> {
  const run = await getExtractor();
  const out = await run(text, { pooling: 'mean', normalize: true });
  const vec = toNumberArray(out.data);
  // Safety: ensure dimension matches expected (bge-small-zh-v1.5 = 512).
  // transformer.js q8 preserves dims; pad/trim defensively to EMBEDDING_DIM.
  if (vec.length !== EMBEDDING_DIM) {
    const fixed = new Array<number>(EMBEDDING_DIM).fill(0);
    for (let i = 0; i < Math.min(vec.length, EMBEDDING_DIM); i++) fixed[i] = vec[i] ?? 0;
    return fixed;
  }
  return vec;
}

/** Cosine similarity between two vectors (assumes L2-normalized = dot). */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * Select top-k entries by semantic similarity to the query vector.
 * Entries without an embedding are encoded on demand (read-path fallback)
 * and their vector is written back into the entry object (caller persists).
 */
export async function semanticTopK<T extends { embedding?: number[] }>(
  queryVector: number[],
  items: T[],
  k: number,
  opts?: { onDemandEncode?: (item: T) => Promise<number[]> },
): Promise<Array<{ item: T; score: number }>> {
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    let vec = item.embedding;
    if (!vec && opts?.onDemandEncode) {
      vec = await opts.onDemandEncode(item);
      item.embedding = vec;
    }
    if (!vec) continue;
    scored.push({ item, score: cosine(queryVector, vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Backfill missing embeddings for all entries in a store (bulk startup). */
export async function backfillStoreEmbeddings(
  store: { entries: Array<{ content: string; embedding?: number[] }> },
  concurrency: number = 3,
): Promise<number> {
  const missing = store.entries.filter(e => !e.embedding || e.embedding.length === 0);
  if (missing.length === 0) return 0;
  let done = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < missing.length) {
      const idx = cursor++;
      const entry = missing[idx];
      if (!entry) continue;
      try {
        entry.embedding = await encodeText(entry.content);
        done++;
      } catch {
        // Model unavailable — leave absent; read path will retry on demand.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, () => worker()));
  return done;
}
