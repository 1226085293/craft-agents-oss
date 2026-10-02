/**
 * Tool Layering Types
 *
 * Session tool layering configuration (会话级二态工具分层).
 *
 * Data files follow the workspace config convention:
 * - {workspaceRootPath}/config/tool_layering.json
 * - {workspaceRootPath}/config/tool_categories.json
 *
 * Mode determination (spec §3):
 *   foldable = session_tools + mcp_tools (SDK built-ins excluded)
 *   est = sum(len(serialize_for_request(t)) / ESTIMATOR_DIVISOR for t in foldable)
 *   mode = forced (flat|layered) if present, else est >= enterThresholdTokens ? layered : flat
 *
 * The divisor was calibrated once against a real API request and is now fixed:
 * measured 3.636 vs. the original /4.
 */

/** Layering mode. 'auto' decides via the token estimator at session start. */
export type ToolLayerMode = 'auto' | 'flat' | 'layered';

/** Top-level tool layering config (config/tool_layering.json). */
export interface ToolLayeringConfig {
  /** 'auto' | 'flat' | 'layered'. 'flat' also serves as the rollback switch (spec §12). */
  mode: ToolLayerMode;
  /** Token threshold at which auto mode turns layered (spec §3: 8000). */
  enterThresholdTokens: number;
  /** Tools that stay top-level in BOTH modes. */
  fixedLayer: string[];
}

/** One category bucket (config/tool_categories.json). */
export interface ToolCategory {
  /** Category id, used in meta tool name and expand results. */
  name: string;
  /** Meta tool name exposed to the model, e.g. 'tools_browser'. */
  metaToolName: string;
  /** Prose description (≤ 80 tokens per spec §4). */
  description: string;
  /** Foldable tool names bucketed into this category. */
  tools: string[];
}

/** Full categories file shape. */
export interface ToolCategoriesConfig {
  categories: ToolCategory[];
}

/** Validated layering config with resolved category lookup (runtime view). */
export interface ResolvedToolLayering {
  mode: ToolLayerMode;
  enterThresholdTokens: number;
  fixedLayer: string[];
  categories: ToolCategory[];
  /** [toolName, category] inverted index for O(1) lookups. */
  byTool: Map<string, ToolCategory>;
}

/** Result of a layering bootstrap validation. */
export interface ToolLayerValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Calibrated estimate divisor: Σlen(serialize(t)) / measured API input tokens. */
export const ESTIMATOR_DIVISOR = 3.636;

/** Default enter threshold per spec §3. */
export const DEFAULT_ENTER_THRESHOLD_TOKENS = 8000;

/** Auto-created bucket for tools added mid-session without a category (spec §4). */
export const MISC_CATEGORY_NAME = 'misc';

/** Layering config path relative to the workspace root. */
export const TOOL_LAYERING_FILE = 'config/tool_layering.json';

/** Categories config path relative to the workspace root. */
export const TOOL_CATEGORIES_FILE = 'config/tool_categories.json';