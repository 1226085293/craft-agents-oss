/**
 * Agent profile schemas — the single source of truth for the field list.
 *
 * Why this file exists: the same field-by-field whitelist used to live in three
 * hand-maintained places (agents SAVE in the RPC handler, `loadAgents`'s
 * `normalizeProfile`, and the `defaults` block), and every new field had to be
 * added to all of them. Three separate bugs came from that — most expensively a
 * read-side whitelist that stripped `assignable`/`memoryDomain` on every load,
 * after which the editor's autosave wrote the stripped values back to disk
 * (silent data loss, caught only by live acceptance).
 *
 * Rule going forward: **add a field here, nowhere else.** Read
 * (`loadAgents`) and write (RPC save) both call `normalizeAgentProfile` /
 * `normalizeAgentDefaultsBlock` below, so a field that exists in one direction
 * cannot silently disappear in the other.
 */

import { z } from 'zod';

import {
  ALL_SCOPE,
  DEFAULT_AGENT_ID,
  EMPTY_DEFAULTS,
  MAX_DISPATCH_HINT_CHARS,
  type AgentDefaults,
  type AgentProfile,
  type AgentScope,
  type AgentsFile,
} from './types.ts';

export const AgentScopeSchema = z.object({
  mode: z.enum(['all', 'allowlist']),
  slugs: z.array(z.string()),
});

export const AgentDefaultsSchema = z.object({
  strategy: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  permissionMode: z.enum(['safe', 'ask', 'allow-all']).nullable().optional(),
  thinkingLevel: z.string().nullable().optional(),
});

/**
 * Every storable profile field. Optional here means "the writer may omit it"
 * (older rows, partial saves) — the normalizers decide the fallback.
 */
export const AgentProfileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  persona: z.string().optional(),
  /** Third-person routing blurb; capped because it is repeated every turn. */
  dispatchHint: z.string().optional(),
  /** Dispatch switch (channel gate v6/v7): only `true` opts in. */
  assignable: z.boolean().optional(),
  /** Memory domain slug (stage 4 resolves it; today it is a stored intent). */
  memoryDomain: z.string().optional(),
  defaults: AgentDefaultsSchema.optional(),
  sources: AgentScopeSchema.optional(),
  skills: AgentScopeSchema.optional(),
  builtin: z.boolean().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  deletedAt: z.number().nullable().optional(),
});

/** The `defaults` block: same profile fields minus identity/lifecycle. */
export const AgentDefaultsBlockSchema = AgentProfileSchema.omit({
  id: true,
  name: true,
  builtin: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

export type AgentProfileInput = z.infer<typeof AgentProfileSchema>;
export type AgentDefaultsBlockInput = z.infer<typeof AgentDefaultsBlockSchema>;

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** `dispatchHint` is trimmed and capped; empty means "no hint". */
export function normalizeDispatchHint(value: unknown): string | undefined {
  const hint = nonEmpty(value);
  return hint ? hint.trim().slice(0, MAX_DISPATCH_HINT_CHARS) : undefined;
}

/**
 * The two fields that caused the silent-loss bug. Exported so the RPC save path
 * can apply the exact same rule instead of re-deriving it.
 */
export function normalizeGateFields(input: {
  assignable?: unknown;
  memoryDomain?: unknown;
}): Pick<AgentProfile, 'assignable' | 'memoryDomain'> {
  return {
    ...(typeof input.assignable === 'boolean' ? { assignable: input.assignable } : {}),
    ...(nonEmpty(input.memoryDomain)
      ? { memoryDomain: (input.memoryDomain as string).trim() }
      : {}),
  };
}

/**
 * Tolerant by design: an unknown mode degrades to 'all' and junk slugs are
 * dropped, but the rest of the row survives. A strict parse would throw the
 * whole profile away over one bad enum — that is how a hand-edited file turns
 * into a silently missing agent.
 */
function normalizeScope(value: unknown, fallback: AgentScope): AgentScope {
  if (!value || typeof value !== 'object') return { ...fallback };
  const v = value as { mode?: unknown; slugs?: unknown };
  const mode: AgentScope['mode'] = v.mode === 'allowlist' ? 'allowlist' : 'all';
  const slugs = Array.isArray(v.slugs)
    ? Array.from(new Set(v.slugs.filter((slug): slug is string => typeof slug === 'string' && slug.trim() !== '')))
    : [];
  return { mode, slugs };
}

/** Same tolerance rule as `normalizeScope`: bad values fall back, the row stays. */
function normalizeDefaults(value: unknown): AgentDefaults {
  if (!value || typeof value !== 'object') return { ...EMPTY_DEFAULTS };
  const v = value as Partial<AgentDefaults>;
  const permission = v.permissionMode;
  return {
    strategy: nonEmpty(v.strategy),
    model: nonEmpty(v.model),
    permissionMode:
      permission === 'safe' || permission === 'ask' || permission === 'allow-all' ? permission : null,
    thinkingLevel: nonEmpty(v.thinkingLevel),
  };
}

/**
 * Read path: unknown JSON → a canonical `AgentProfile`, or null when the row
 * cannot be a profile at all (no id, or the reserved default id).
 */
export function normalizeAgentProfile(raw: unknown, now: number): AgentProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as AgentProfileInput;
  // Only identity is structural: without a usable id there is no row to keep.
  if (typeof v.id !== 'string' || !v.id.trim()) return null;
  // The default id is reserved: it lives in `defaults`, never in `agents[]`.
  if (v.id === DEFAULT_AGENT_ID) return null;
  const id = v.id;
  return {
    id,
    name: nonEmpty(v.name) ? (v.name as string) : id,
    icon: typeof v.icon === 'string' ? v.icon : undefined,
    color: typeof v.color === 'string' ? v.color : undefined,
    persona: typeof v.persona === 'string' ? v.persona : '',
    ...(normalizeDispatchHint(v.dispatchHint) ? { dispatchHint: normalizeDispatchHint(v.dispatchHint) } : {}),
    defaults: normalizeDefaults(v.defaults),
    sources: normalizeScope(v.sources, ALL_SCOPE),
    skills: normalizeScope(v.skills, ALL_SCOPE),
    ...normalizeGateFields(v),
    builtin: v.builtin === true,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : now,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : now,
    deletedAt: typeof v.deletedAt === 'number' ? v.deletedAt : null,
  };
}

/**
 * Read path for the top-level `defaults` block (the built-in default agent).
 * Kept beside the profile normalizer so the two cannot drift.
 */
export function normalizeAgentDefaultsBlock(
  raw: unknown,
): AgentsFile['defaults'] {
  const v = (raw && typeof raw === 'object' ? raw : {}) as AgentDefaultsBlockInput;
  return {
    persona: typeof v.persona === 'string' ? v.persona : '',
    ...(normalizeDispatchHint(v.dispatchHint) ? { dispatchHint: normalizeDispatchHint(v.dispatchHint) } : {}),
    defaults: normalizeDefaults(v.defaults),
    sources: normalizeScope(v.sources, ALL_SCOPE),
    skills: normalizeScope(v.skills, ALL_SCOPE),
    ...normalizeGateFields(v),
  };
}
