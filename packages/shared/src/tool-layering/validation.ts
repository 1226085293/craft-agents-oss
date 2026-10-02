/**
 * Tool Layering Validation
 *
 * Startup validation (spec §4): every foldable tool must belong to exactly one
 * bucket (fixed layer or a category); orphan/duplicate tools abort startup.
 *
 * Mid-session tools without a category fold into a lazily-created 'misc' bucket.
 * Category descriptions must stay within 80 tokens.
 */

import type {
  ToolCategoriesConfig,
  ToolCategory,
  ToolLayerValidationResult,
} from './types.ts';
import { MISC_CATEGORY_NAME } from './types.ts';

const MAX_CATEGORY_DESCRIPTION_TOKENS = 80;
export const MIN_CATEGORY_COUNT = 4;
export const MAX_CATEGORY_COUNT = 6;

/** Rough token count for a description (spec: Chinese ~1.7 chars/tok, else /4). */
function descTokens(desc: string): number {
  const zh = (desc.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(zh / 1.7 + (desc.length - zh) / 4);
}

/**
 * Validate categories config and bucket coverage.
 *
 * @param categories - Parsed categories config (undefined → defaults assumed ok,
 *                     caller resolves defaults first)
 * @param fixedLayer - Tool names in the fixed layer (always top-level)
 * @param knownTools - All foldable tool names (session + MCP) at boot
 * @param allowMisc  - If true, unclassified tools warn + fold to misc instead of error
 */
export function validateToolLayering(
  categories: ToolCategoriesConfig | undefined,
  fixedLayer: string[],
  knownTools: string[],
  allowMisc = true,
): ToolLayerValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cats = categories?.categories ?? [];
  const catNames = new Set<string>();
  const seenTools = new Map<string, string>(); // tool → category

  if (cats.length < MIN_CATEGORY_COUNT || cats.length > MAX_CATEGORY_COUNT) {
    errors.push(
      `分类数 ${cats.length} 不在 [${MIN_CATEGORY_COUNT}, ${MAX_CATEGORY_COUNT}] 范围`,
    );
  }

  for (const cat of cats) {
    if (catNames.has(cat.name)) {
      errors.push(`分类 "${cat.name}" 重复定义`);
    }
    catNames.add(cat.name);

    if (descTokens(cat.description) > MAX_CATEGORY_DESCRIPTION_TOKENS) {
      warnings.push(
        `分类 "${cat.name}" description ${descTokens(cat.description)} tok ` +
          `超过上限 ${MAX_CATEGORY_DESCRIPTION_TOKENS} tok`,
      );
    }
    for (const t of cat.tools) {
      const prev = seenTools.get(t);
      if (prev) {
        errors.push(`工具 "${t}" 同时属于 "${prev}" 与 "${cat.name}"（重复）`);
      } else {
        seenTools.set(t, cat.name);
      }
    }
  }

  const known = new Set(knownTools);
  const orphans: string[] = [];
  for (const t of knownTools) {
    if (!seenTools.has(t) && !fixedLayer.includes(t)) {
      if (allowMisc) {
        warnings.push(`工具 "${t}" 未分类，将归入自动创建的 misc 分类`);
      } else {
        orphans.push(t);
      }
    }
  }
  if (orphans.length > 0) {
    errors.push(`孤儿工具（无分类且不在固定层）: ${orphans.join(', ')}`);
  }

  // Stale category references (tool removed from runtime but still in config) —
  // warning only: removal is mid-session legal.
  for (const t of seenTools.keys()) {
    if (!known.has(t)) {
      warnings.push(`分类引用了已不存在的工具 "${t}"`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Ensure a tool lands in the misc bucket (lazily created). Mutates and returns.
 * Spec §4: tools added mid-session without a category fold into auto-created misc.
 */
export function ensureMiscBucket(
  categories: ToolCategory[],
  toolName: string,
): ToolCategory[] {
  let misc = categories.find((c) => c.name === MISC_CATEGORY_NAME);
  if (!misc) {
    misc = {
      name: MISC_CATEGORY_NAME,
      metaToolName: `tools_${MISC_CATEGORY_NAME}`,
      description: '会话中途新增、未指定分类的工具。',
      tools: [],
    };
    categories.push(misc);
  }
  if (!misc.tools.includes(toolName)) {
    misc.tools.push(toolName);
  }
  return categories;
}