/**
 * Source Action Policy (freestanding)
 *
 * The endpoint/tool policy rules that decide whether a source call is
 * read-only/allowlisted or needs explicit user approval. Extracted out of
 * runPreToolUseChecks' ask-mode prompt logic so non-hook callers (the Pages
 * action bridge, future services) evaluate the SAME rules instead of
 * re-implementing them. shouldPromptInAskMode delegates here.
 *
 * Session-scoped whitelists ("previously approved this session") are NOT
 * part of this module — they belong to the per-session PermissionManager
 * and stay in the hook layer.
 */

import { isApiEndpointAllowed, shouldAllowToolInMode } from './mode-manager.ts';
import type { PermissionsContext } from './permissions-config.ts';
import type {
  FolderSourceConfig,
  SourcePermissionKey,
  SourcePolicyPreference,
  SourceRiskLevel,
} from '../sources/types.ts';

export type SourceActionPolicyDecision =
  | { decision: 'allow'; reason: 'read-only' | 'endpoint-allowlisted' }
  | { decision: 'requires-approval'; description: string };

/**
 * API-source endpoint policy:
 * - GET is always allowed (read-only by convention)
 * - mutations are allowed when they match an allowedApiEndpoints rule from
 *   the merged permissions.json config
 * - everything else requires approval
 */
export function evaluateApiEndpointPolicy(
  method: string,
  path: string | undefined,
  permissionsContext?: PermissionsContext,
): SourceActionPolicyDecision {
  const upperMethod = (method || 'GET').toUpperCase();

  if (upperMethod === 'GET') {
    return { decision: 'allow', reason: 'read-only' };
  }

  if (isApiEndpointAllowed(upperMethod, path, permissionsContext)) {
    return { decision: 'allow', reason: 'endpoint-allowlisted' };
  }

  return { decision: 'requires-approval', description: `${upperMethod} ${path || ''}` };
}

/**
 * MCP tool policy: a tool that safe mode would block is a mutation and
 * requires approval; anything safe mode allows is read-only.
 *
 * @param proxyToolName - Full proxy tool name (mcp__{slug}__{tool})
 */
export function evaluateMcpToolPolicy(
  proxyToolName: string,
  input: Record<string, unknown>,
  options?: { plansFolderPath?: string },
): SourceActionPolicyDecision {
  const safeModeResult = shouldAllowToolInMode(proxyToolName, input, 'safe', {
    plansFolderPath: options?.plansFolderPath,
  });

  if (safeModeResult.allowed) {
    return { decision: 'allow', reason: 'read-only' };
  }

  const serverAndTool = proxyToolName.replace('mcp__', '').replace(/__/g, '/');
  return { decision: 'requires-approval', description: `MCP: ${serverAndTool}` };
}

// ============================================================================
// Authorization model (授权层) + Agent autonomy (运行层)
// ============================================================================

/** 解析代理工具名 → 数据源 slug 与类型。非来源工具返回 null。 */
export function parseSourceSlugFromTool(toolName: string): { slug: string; sourceType: 'mcp' | 'api' } | null {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) return { slug: parts[1]!, sourceType: 'mcp' };
    return null;
  }
  if (toolName.startsWith('api_')) {
    return { slug: toolName.slice(4), sourceType: 'api' };
  }
  return null;
}

const EXTERNAL_KEYWORDS = ['send', 'transfer', 'share', 'publish', 'broadcast', 'email', 'notify', 'webhook', 'invite']; // 注意：不含 'post' —— HTTP POST 属写操作而非外发
const DELETE_KEYWORDS = ['delete', 'remove', 'purge', 'destroy', 'drop', 'truncate', 'wipe', 'revoke', 'unlink', 'deactivate', 'clear'];
const PAYMENT_KEYWORDS = ['pay', 'payment', 'billing', 'charge', 'invoice', 'refund', 'checkout', 'subscribe', 'subscription', 'stripe', 'wallet'];
const SENSITIVE_KEYWORDS = ['pii', 'secret', 'credential', 'password', 'token', 'personal', 'private', 'financial', 'ssn', 'salary', 'medical', 'health', 'oauth'];
const WRITE_KEYWORDS = ['create', 'update', 'write', 'add', 'edit', 'modify', 'set', 'insert', 'upsert', 'patch', 'toggle'];

function matchesKeywords(haystack: string, keywords: string[]): boolean {
  const lower = haystack.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function sourceMutates(toolName: string, input: Record<string, unknown>, opts?: { plansFolderPath?: string }): boolean {
  if (toolName.startsWith('mcp__')) {
    const policy = evaluateMcpToolPolicy(toolName, input, opts);
    return policy.decision === 'requires-approval';
  }
  if (toolName.startsWith('api_')) {
    const method = ((input?.method as string) || 'GET').toUpperCase();
    const path = (input?.path as string) || '';
    if (method !== 'GET' && method !== 'HEAD') return true;
    const policy = evaluateApiEndpointPolicy(method, path);
    return policy.decision === 'requires-approval';
  }
  return false;
}

/**
 * 推断工具的操作类别（用于 grantedPermissions 硬约束与风险展示）。
 * 返回该次调用最“重”的权限类别。
 */
export function inferSourceToolPermission(
  toolName: string,
  input: Record<string, unknown>,
): SourcePermissionKey {
  const method = ((input?.method as string) || 'GET').toUpperCase();
  const path = (input?.path as string) || '';
  const haystack = `${toolName} ${method} ${path}`.toLowerCase();

  if (matchesKeywords(haystack, PAYMENT_KEYWORDS)) return 'payment';
  if (matchesKeywords(haystack, DELETE_KEYWORDS)) return 'delete';
  if (matchesKeywords(haystack, EXTERNAL_KEYWORDS)) return 'external';
  if (matchesKeywords(haystack, SENSITIVE_KEYWORDS)) return 'sensitive';
  const mutates = sourceMutates(toolName, input);
  if (mutates) return 'write';
  return 'read';
}

/**
 * 服务端风险裁定（最终裁定）。
 * - low：明确只读 + 无敏感/删除/外发/支付语义；
 * - medium（默认）：无法判定为 low 的其余情况（含未知）→ 需确认；
 * - high：mutation 或 写/删/外发/敏感 语义 → 强制确认（auto 也不跳过）；
 * - critical：支付/计费类 → 强制确认，MVP 禁止持久 auto。
 * config.riskLevel 允许手动覆写（可降），但服务端检测到 delete/external/payment/
 * sensitive 语义或 mutation 时强制提升，不允许人为降到 low。
 */
export function classifySourceToolRisk(
  toolName: string,
  input: Record<string, unknown>,
  config?: Partial<Pick<FolderSourceConfig, 'riskLevel' | 'tagline' | 'name'>> | null,
  opts?: { plansFolderPath?: string },
): {
  sourceSlug: string | null;
  operation: SourcePermissionKey;
  mutation: boolean;
  risk: SourceRiskLevel;
  manualRisk?: SourceRiskLevel;
} {
  const parsed = parseSourceSlugFromTool(toolName);
  const method = ((input?.method as string) || 'GET').toUpperCase();
  const path = (input?.path as string) || '';
  const meta = `${config?.name ?? ''} ${config?.tagline ?? ''}`;
  const haystack = `${toolName} ${method} ${path} ${meta}`.toLowerCase();

  const mutation = sourceMutates(toolName, input, opts);
  const operation = inferSourceToolPermission(toolName, input);

  // 服务端检测到的强制档（只升不降）：
  // payment → critical；mutation / 删/外发/敏感 → high；
  // 明确只读且无敏感/删除/外发/支付语义 → low（自动）；未知 → medium（需确认）
  let detected: SourceRiskLevel;
  if (matchesKeywords(haystack, PAYMENT_KEYWORDS)) {
    detected = 'critical';
  } else if (mutation || matchesKeywords(haystack, DELETE_KEYWORDS) || matchesKeywords(haystack, EXTERNAL_KEYWORDS) || matchesKeywords(haystack, SENSITIVE_KEYWORDS)) {
    detected = 'high';
  } else if (parsed !== null && !mutation) {
    detected = 'low';
  } else {
    // 未知/无法判定：默认 medium（需确认）
    detected = 'medium';
  }

  const manualRisk = config?.riskLevel;
  let risk: SourceRiskLevel;
  if (manualRisk) {
    // 服务端最终裁定：检测到的高风险语义不可通过手动降级
    const rank = (r: SourceRiskLevel) => (r === 'low' ? 0 : r === 'medium' ? 1 : r === 'high' ? 2 : 3);
    risk = rank(detected) > rank(manualRisk) ? detected : manualRisk;
  } else {
    risk = detected;
  }

  return { sourceSlug: parsed?.slug ?? null, operation, mutation, risk, manualRisk };
}

/** 来源工具访问决策上下文（pre-tool 与 ask 管线共用） */
export interface SourceToolAccessContext {
  config?: Partial<Pick<FolderSourceConfig, 'grantedPermissions' | 'sourcePolicy' | 'sourceToolPolicies' | 'riskLevel' | 'name' | 'tagline'>> | null;
  sessionAllow?: boolean;
  sessionDeny?: boolean;
  opts?: { plansFolderPath?: string };
}

/**
 * 已授权 + 在范围内的来源工具访问决策（按计划 v2 优先级 1–8）。
 * 调用方（pre-tool gate）先处理：未授权/范围外/内置工具；本函数只处理剩余情况。
 */
export function evaluateSourceToolAccess(
  toolName: string,
  input: Record<string, unknown>,
  ctx: SourceToolAccessContext,
):
  | { decision: 'allow'; reason: string; risk: ReturnType<typeof classifySourceToolRisk> }
  | { decision: 'confirm'; reason: string; risk: ReturnType<typeof classifySourceToolRisk> }
  | { decision: 'block'; reason: string; risk: ReturnType<typeof classifySourceToolRisk> } {
  const parsed = parseSourceSlugFromTool(toolName);
  const base = classifySourceToolRisk(toolName, input, ctx.config, ctx.opts);
  const risk = base;

  // 1) grantedPermissions 硬约束：显式授权列表不含本次操作类别 → blocked
  const granted = ctx.config?.grantedPermissions;
  if (granted && granted.length > 0 && !granted.includes(risk.operation)) {
    return {
      decision: 'block',
      reason: `数据源未授予“${risk.operation}”权限（已授权：${granted.join(', ')}）。请管理员在设置中调整最小权限。`,
      risk,
    };
  }

  // 2) config 级 deny（源级 / 工具级）
  const toolPolicy: SourcePolicyPreference | undefined = ctx.config?.sourceToolPolicies?.[toolName];
  const sourcePolicy = ctx.config?.sourcePolicy;
  if (toolPolicy === 'deny' || sourcePolicy === 'deny') {
    return {
      decision: 'block',
      reason: `该数据源/工具已被管理员禁止（deny 策略）。如需使用请让管理员调整授权。`,
      risk,
    };
  }

  // 3) session deny
  if (ctx.sessionDeny) {
    return {
      decision: 'block',
      reason: `该工具本会话已被禁止（deny-session）。如需使用请重新选择或调整禁止策略。`,
      risk,
    };
  }

  // 4) 本次范围已由调用方检查（only/exclude），此处不再重复

  // 5) 工具持久 auto（始终允许）：仅对 low/medium 生效；high/critical 不跳过
  if (toolPolicy === 'auto' && risk.risk !== 'high' && risk.risk !== 'critical') {
    return { decision: 'allow', reason: 'sourceToolPolicies auto（始终允许）', risk };
  }

  // 6) session allow
  if (ctx.sessionAllow && risk.risk !== 'high' && risk.risk !== 'critical') {
    return { decision: 'allow', reason: 'session allow-session', risk };
  }

  // 7) 风险分级默认：low 只读自动；medium/confirm 需确认；high/critical 强制确认
  if (risk.risk === 'low' && !sourceMutates(toolName, input, ctx.opts)) {
    return { decision: 'allow', reason: 'low-risk read-only auto', risk };
  }
  if (sourcePolicy === 'confirm') {
    return { decision: 'confirm', reason: 'sourcePolicy confirm（源级所有调用需确认）', risk };
  }
  if (risk.risk === 'high' || risk.risk === 'critical') {
    return { decision: 'confirm', reason: 'high-risk requires confirmation', risk };
  }
  return { decision: 'confirm', reason: 'default medium requires confirmation', risk };
}
