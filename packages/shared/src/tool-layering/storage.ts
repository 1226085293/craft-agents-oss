/**
 * Tool Layering Storage
 *
 * Loads/saves config/tool_layering.json and config/tool_categories.json
 * under a workspace root (same convention as statuses/labels).
 *
 * Loading is lenient: missing files fall back to defaults; present-but-invalid
 * files are rejected (startup abort per spec §4) rather than silently defaulted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type {
  ResolvedToolLayering,
  ToolCategoriesConfig,
  ToolCategory,
  ToolLayeringConfig,
} from './types.ts';
import {
  TOOL_LAYERING_FILE,
  TOOL_CATEGORIES_FILE,
  MISC_CATEGORY_NAME,
} from './types.ts';
import { ALWAYS_FIXED_TOOLS, DEFAULT_TOOL_LAYERING, DEFAULT_TOOL_CATEGORIES } from './defaults.ts';
import { validateToolLayering, ensureMiscBucket } from './validation.ts';

export interface LoadToolLayeringOptions {
  /** All foldable tool names (session + MCP) known at boot. */
  knownTools: string[];
  /** If true, unclassified tools warn and fold into misc; false = hard error. */
  allowMisc?: boolean;
}

/**
 * Load and resolve the tool layering config for a workspace.
 * Missing files → defaults. Invalid (duplicates/orphans/range) → throws.
 *
 * @param workspaceRootPath - Workspace root containing config/
 * @param knownTools - Foldable tool names at boot (session + MCP, no SDK built-ins)
 */
export function loadToolLayering(
  workspaceRootPath: string,
  knownTools: string[],
  allowMisc = true,
): ResolvedToolLayering {
  const layering = readJsonOrDefault<ToolLayeringConfig>(
    join(workspaceRootPath, TOOL_LAYERING_FILE),
    DEFAULT_TOOL_LAYERING,
  );
  const categoriesConfig = readJsonOrDefault<ToolCategoriesConfig>(
    join(workspaceRootPath, TOOL_CATEGORIES_FILE),
    DEFAULT_TOOL_CATEGORIES,
  );

  // Normalize mode enum.
  const mode = normalizeMode(layering.mode);
  // Built-in memory tools are always fixed, regardless of workspace config:
  // they must stay directly callable so explicit memory requests are never
  // folded behind a meta tool. Dedupe keeps config-provided duplicates empty.
  const fixedLayer = [
    ...ALWAYS_FIXED_TOOLS,
    ...(layering.fixedLayer ?? []).filter(t => !ALWAYS_FIXED_TOOLS.includes(t as (typeof ALWAYS_FIXED_TOOLS)[number])),
  ];
  const enterThresholdTokens =
    typeof layering.enterThresholdTokens === 'number' && layering.enterThresholdTokens > 0
      ? layering.enterThresholdTokens
      : DEFAULT_TOOL_LAYERING.enterThresholdTokens;

  // Boot-time validation: duplicates abort; orphans warn→misc (or abort if !allowMisc).
  const result = validateToolLayering(categoriesConfig, fixedLayer, knownTools, allowMisc);
  if (!result.ok) {
    throw new Error(
      `[tool-layering] 启动校验失败：\n` + result.errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
  for (const w of result.warnings) {
    console.warn(`[tool-layering] ${w}`);
  }

  // Fold unclassified tools into misc (bootstrap time, non-destructive).
  const categories = [...(categoriesConfig.categories ?? [])];
  for (const t of knownTools) {
    const bucketed = categories.some((c) => c.tools.includes(t)) || fixedLayer.includes(t);
    if (!bucketed) {
      ensureMiscBucket(categories, t);
    }
  }

  return resolve(categories, mode, fixedLayer, enterThresholdTokens);
}

function resolve(
  categories: ToolCategory[],
  mode: ResolvedToolLayering['mode'],
  fixedLayer: string[],
  enterThresholdTokens: number,
): ResolvedToolLayering {
  const byTool = new Map<string, ToolCategory>();
  for (const cat of categories) {
    for (const t of cat.tools) {
      // First category wins; duplicates already rejected at validation.
      if (!byTool.has(t)) byTool.set(t, cat);
    }
  }
  return { mode, fixedLayer, categories, enterThresholdTokens, byTool };
}

function normalizeMode(m: unknown): ResolvedToolLayering['mode'] {
  if (m === 'flat' || m === 'layered') return m;
  return 'auto';
}

function readJsonOrDefault<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (e) {
    console.error(`[tool-layering] 解析 ${path} 失败:`, e);
    return fallback;
  }
}

/**
 * Save both config files (used by the config authoring tool / tests).
 * Atomic-enough: write categories first, then layering.
 */
export function saveToolLayering(
  workspaceRootPath: string,
  layering: ToolLayeringConfig,
  categories: ToolCategoriesConfig,
): void {
  const dir = join(workspaceRootPath, 'config');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspaceRootPath, TOOL_LAYERING_FILE), JSON.stringify(layering, null, 2) + '\n', 'utf-8');
  writeFileSync(join(workspaceRootPath, TOOL_CATEGORIES_FILE), JSON.stringify(categories, null, 2) + '\n', 'utf-8');
}