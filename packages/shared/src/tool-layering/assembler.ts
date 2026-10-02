/**
 * Tool Layering Assembler
 *
 * Spec §5: tools array assembly + §6 registry for dispatch.
 *
 *   flat mode:    fixed layer (subset) + ALL real tools (session + MCP).
 *   layered mode: fixed layer + category meta tools (tools_<cat>, empty schema)
 *                 + call_tool ({name, args}).
 *
 * Tool defs share the JsonSchemaToolDef/ProxyToolDef shape:
 *   { name, description, inputSchema }
 * Session tools are prefixed `mcp__session__`, MCP tools `mcp__{slug}__{tool}`.
 */

import type {
  ResolvedToolLayering,
  ToolCategory,
} from './types.ts';
import { MISC_CATEGORY_NAME } from './types.ts';
import { estimateFoldableTokens } from './estimator.ts';

export interface ToolDefLike {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Minimal legal JSON Schema for parameter-less tools (meta tools must carry
 *  a well-formed schema — empty objects `{}` are rejected by strict model
 *  providers with invalid_function_parameters (11129)). */
export const EMPTY_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

/** One entry in the dispatch registry. */
export interface RegistryEntry {
  /** Full registered name (with prefix), as the subprocess sees it. */
  fullName: string;
  /** User-facing name (prefix stripped) — what call_tool receives. */
  callName: string;
  def: ToolDefLike;
  /** Bucket: 'fixed' or a category name. */
  category: string;
  /** True when the tool stays top-level in both modes. */
  fixed: boolean;
}

export interface AssembledTools {
  mode: 'flat' | 'layered';
  /** register_tools payload: what the model sees top-level. */
  topLevel: ToolDefLike[];
  /** Category meta tools (layered only). */
  metaTools: ToolDefLike[];
  /** call_tool definition (layered only). */
  callToolDef?: ToolDefLike;
  /** Registry: every foldable tool (session + MCP) reachable via call_tool. */
  registry: Map<string, RegistryEntry>;
  /** Category index by name. */
  categoriesByName: Map<string, ToolCategory>;
  // --- telemetry / diagnostics (spec §8) ---
  /** Why the mode was chosen ('forced:layered', 'forced:flat', 'estimate≥threshold', 'estimate<threshold'). */
  decideReason: string;
  /** Estimated serialized overhead (chars / ESTIMATOR_DIVISOR) — only meaningful in auto mode. */
  estimatedTokenOverhead: number;
  /** enterThresholdTokens used for the auto decision. */
  thresholdTokens: number;
  /** Fixed-layer tool plain names (as configured). */
  fixedLayer: string[];
  /** Foldable (non-fixed) tool count in the registry. */
  foldableCount: number;
}

export const SESSION_PREFIX = 'mcp__session__';
export const CALL_TOOL_NAME = 'call_tool';

export const callToolDescription =
  '调用已展开分类中的工具。name 为工具名，args 为符合其 schema 的 JSON 对象。错误返回会给修正指引：未知工具→候选列表；未展开→指明需先调用的元工具；参数错误→完整 schema。按指引修正后重试。';

function metaToolFullName(cat: string): string {
  return SESSION_PREFIX + `tools_${cat}`;
}

function defForMeta(cat: ToolCategory): ToolDefLike {
  return {
    name: metaToolFullName(cat.name),
    description: cat.description,
    inputSchema: EMPTY_INPUT_SCHEMA,
  };
}

function buildCallToolDef(): ToolDefLike {
  return {
    name: SESSION_PREFIX + CALL_TOOL_NAME,
    description: callToolDescription,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要调用的工具名（不含前缀）' },
        args: { type: 'object', description: '符合该工具 inputSchema 的 JSON 对象' },
      },
      required: ['name'],
    },
  };
}

/** Strip known prefixes for user-facing call() usage. */
export function stripToolPrefix(fullName: string): string {
  if (fullName.startsWith(SESSION_PREFIX)) return fullName.slice(SESSION_PREFIX.length);
  return fullName;
}

function bucketFor(
  fullName: string,
  layering: ResolvedToolLayering,
): { category: string; fixed: boolean } {
  const callName = stripToolPrefix(fullName);
  // Fixed layer by either form (config uses plain names, registry has prefixes)
  if (layering.fixedLayer.includes(fullName) || layering.fixedLayer.includes(callName)) {
    return { category: 'fixed', fixed: true };
  }
  // Session tools are bucketed by plain name; MCP tools by full name
  const cat = layering.byTool.get(callName) ?? layering.byTool.get(fullName);
  if (cat) return { category: cat.name, fixed: false };
  return { category: MISC_CATEGORY_NAME, fixed: false };
}

/**
 * Assemble register_tools payload + dispatch registry for one session.
 * Mode is decided once at session start (spec §3): forced wins, else
 * est >= enterThresholdTokens → layered.
 */
export function assembleTools(
  layering: ResolvedToolLayering,
  sessionTools: ToolDefLike[],
  mcpTools: ToolDefLike[],
): AssembledTools {
  const all = [...sessionTools, ...mcpTools];
  const mode = decideMode(layering, all);
  const categoriesByName = new Map(layering.categories.map((c) => [c.name, c]));

  // Registry: EVERY tool (session + MCP) — flat keeps it for parity checks,
  // layered uses it for call_tool dispatch.
  const registry = new Map<string, RegistryEntry>();
  for (const def of all) {
    const { category, fixed } = bucketFor(def.name, layering);
    registry.set(def.name, {
      fullName: def.name,
      callName: stripToolPrefix(def.name),
      def,
      category,
      fixed: fixed || category === 'fixed',
    });
  }

  let topLevel: ToolDefLike[];
  const metaTools: ToolDefLike[] = [];
  let callToolDef: ToolDefLike | undefined;

  const fixedLayer = layering.fixedLayer;

  if (mode === 'layered') {
    // Fixed layer first, in fixedLayer order, then meta tools, then call_tool.
    const fixedTools: ToolDefLike[] = [];
    const seen = new Set<string>();
    for (const name of layering.fixedLayer) {
      const entry = registry.get(name) ?? registry.get(SESSION_PREFIX + name);
      if (entry && !seen.has(entry.fullName)) {
        seen.add(entry.fullName);
        fixedTools.push(entry.def);
      }
    }
    for (const cat of layering.categories) {
      if (cat.name === MISC_CATEGORY_NAME) continue; // misc has no meta tool
      metaTools.push(defForMeta(cat));
    }
    callToolDef = buildCallToolDef();
    topLevel = [...fixedTools, ...metaTools, callToolDef];
  } else {
    topLevel = all;
  }

  return {
    mode,
    topLevel,
    metaTools,
    callToolDef,
    registry,
    categoriesByName,
    decideReason: reasonFor(layering, mode, all),
    estimatedTokenOverhead: Math.round(estimateFoldableTokens(all)),
    thresholdTokens: layering.enterThresholdTokens,
    fixedLayer: [...layering.fixedLayer],
    foldableCount: [...registry.values()].filter((e) => !e.fixed).length,
  };
}

/** auto/forced mode decision at assembly (spec §3). */
export function decideMode(
  layering: ResolvedToolLayering,
  allTools: ToolDefLike[],
): 'flat' | 'layered' {
  if (layering.mode === 'flat' || layering.mode === 'layered') {
    return layering.mode;
  }
  // auto: estimate over foldable tools only (no SDK built-ins counted)
  return estimateFoldableTokens(allTools) >= layering.enterThresholdTokens
    ? 'layered'
    : 'flat';
}

/** Human-readable reason for telemetry (spec §8). */
export function reasonFor(
  layering: ResolvedToolLayering,
  mode: 'flat' | 'layered',
  allTools: ToolDefLike[],
): string {
  if (layering.mode === 'flat') return 'forced-flat';
  if (layering.mode === 'layered') return 'forced-layered';
  const est = Math.round(estimateFoldableTokens(allTools));
  return est >= layering.enterThresholdTokens
    ? `estimate≥threshold (${est} ≥ ${layering.enterThresholdTokens})`
    : `estimate<threshold (${est} < ${layering.enterThresholdTokens})`;
}

/** Build the expand-result payload for a category (spec §6).
 *  Collects ALL registry entries bucketed under the category — this covers
 *  config-listed tools AND mid-session tools folded into misc (spec §7). */
export function buildExpandPayload(
  cat: ToolCategory,
  registry: Map<string, RegistryEntry>,
): {
  category: string;
  tools: { name: string; description: string; schema: Record<string, unknown>; notes?: string }[];
  usage: string;
} {
  const entries = [...registry.values()].filter(
    (e) => e.category === cat.name && !e.fixed,
  );
  const tools = entries.map((e) => ({
    name: e.callName,
    description: e.def.description,
    schema: e.def.inputSchema,
    notes: e.fixed ? '固定层工具（始终顶层可用）' : undefined,
  }));
  return {
    category: cat.name,
    tools,
    usage: '用 call_tool(name, args) 调用；args 必须符合各工具 schema',
  };
}

/** Nearest-3 candidate names for unknown_tool errors (spec §6). */
export function nearestToolNames(
  registry: Map<string, RegistryEntry>,
  name: string,
  limit = 3,
): string[] {
  const target = name.toLowerCase();
  return [...registry.values()]
    .filter((e) => !e.fixed)
    .map((e) => ({ n: e.callName, d: editDistance(e.callName.toLowerCase(), target) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((c) => c.n);
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        (dp[i - 1]![j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m]![n]!;
}