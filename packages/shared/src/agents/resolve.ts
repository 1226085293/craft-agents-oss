/**
 * Agent resolution.
 *
 * The single place that answers "which agent does this session use, and what
 * defaults does it inherit". Every creation path (UI, automation, messaging,
 * API, CLI) goes through here, so the precedence chain exists once:
 *
 *     explicit caller value  >  agent defaults  >  first enabled strategy
 *
 * The last tier is not a config field: it is computed from whatever strategy
 * groups are enabled, which is why deleting the old `defaultStrategy` field is
 * safe for callers that never see a settings page.
 */

import {
  ALL_SCOPE,
  DEFAULT_AGENT_ID,
  EMPTY_DEFAULTS,
  emptyAgentsFile,
  type AgentDefaults,
  type AgentProfile,
  type AgentScope,
  type AgentsFile,
} from './types.ts';
import { loadAgents, saveAgents, hasAgentsFile } from './storage.ts';

/** The default profile materialized from the `defaults` block. */
export function getDefaultAgent(file: AgentsFile): AgentProfile {
  return {
    id: DEFAULT_AGENT_ID,
    name: '默认',
    icon: undefined,
    color: undefined,
    persona: file.defaults.persona ?? '',
    defaults: { ...EMPTY_DEFAULTS, ...file.defaults.defaults },
    sources: file.defaults.sources ?? { ...ALL_SCOPE },
    skills: file.defaults.skills ?? { ...ALL_SCOPE },
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
}

/**
 * Look up an agent by id, falling back to the workspace default.
 *
 * A missing id (agent deleted, or a session written by an older build) resolves
 * to the default profile rather than failing — session creation must not depend
 * on an agent row still existing.
 */
export function getAgentById(file: AgentsFile, agentId?: string | null): AgentProfile {
  const wanted = agentId?.trim() || file.defaultAgentId || DEFAULT_AGENT_ID;
  if (wanted === DEFAULT_AGENT_ID) return getDefaultAgent(file);
  const found = file.agents.find((a) => a.id === wanted && !a.deletedAt);
  return found ?? getDefaultAgent(file);
}

export interface ResolveAgentOptions {
  workspaceRoot: string;
  agentId?: string | null;
}

export function resolveAgent(options: ResolveAgentOptions): AgentProfile {
  const file = loadAgents(options.workspaceRoot);
  return getAgentById(file, options.agentId);
}

/**
 * Resolve which strategy group a new session should route through.
 *
 * @param explicit   What the caller passed (composer selection, API payload).
 * @param agent      The resolved agent profile.
 * @param enabledStrategies Ids of currently enabled groups, in config order.
 */
export function resolveStrategy(
  explicit: string | undefined | null,
  agent: AgentProfile | undefined,
  enabledStrategies: string[],
): string | undefined {
  const pick = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v : undefined);
  return pick(explicit) ?? pick(agent?.defaults.strategy) ?? enabledStrategies[0];
}

export interface ResolveDefaultsOptions {
  workspaceRoot: string;
  agentId?: string | null;
  strategy?: string | null;
  model?: string | null;
  permissionMode?: 'safe' | 'ask' | 'allow-all' | null;
  thinkingLevel?: string | null;
  workspaceDefaults?: {
    strategy?: string | null;
    model?: string | null;
    permissionMode?: 'safe' | 'ask' | 'allow-all' | null;
    thinkingLevel?: string | null;
  };
  enabledStrategies: string[];
}

export interface ResolvedDefaults {
  agent: AgentProfile;
  strategy?: string;
  model?: string;
  permissionMode?: 'safe' | 'ask' | 'allow-all';
  thinkingLevel?: string;
}

/**
 * Resolve every inherited value for a new session in one pass.
 *
 * `workspaceDefaults` is only consulted as a *legacy* tier: after the v0→v1
 * migration those keys are gone from `config.json`, but an upgrade that runs
 * before the migration must still create a routable session.
 */
export function resolveSessionDefaults(options: ResolveDefaultsOptions): ResolvedDefaults {
  const agent = resolveAgent({ workspaceRoot: options.workspaceRoot, agentId: options.agentId });
  const legacy = options.workspaceDefaults ?? {};
  return {
    agent,
    strategy: resolveStrategy(
      options.strategy ?? legacy.strategy,
      agent,
      options.enabledStrategies,
    ),
    model: options.model ?? legacy.model ?? undefined,
    permissionMode:
      (options.permissionMode ?? agent.defaults.permissionMode ?? legacy.permissionMode ?? undefined) as
        | 'safe'
        | 'ask'
        | 'allow-all'
        | undefined,
    thinkingLevel: options.thinkingLevel ?? agent.defaults.thinkingLevel ?? legacy.thinkingLevel ?? undefined,
  };
}

/** What a session stores so later edits to the agent do not rewrite history. */
export interface AgentSnapshot {
  agentId: string;
  name: string;
  persona: string;
  sources: AgentScope;
  skills: AgentScope;
  /** Frozen at creation: changing the agent later must not touch this session. */
  pinnedAt: number;
}

export function buildAgentSnapshot(agent: AgentProfile): AgentSnapshot {
  return {
    agentId: agent.id,
    name: agent.name,
    persona: agent.persona,
    sources: agent.sources,
    skills: agent.skills,
    pinnedAt: Date.now(),
  };
}

/** Effective persona for a session: snapshot wins over the live profile. */
export function personForSession(
  snapshot: AgentSnapshot | undefined,
  live: AgentProfile | undefined,
): string {
  if (snapshot) return snapshot.persona;
  return live?.persona ?? '';
}

/** Effective scopes for a session: snapshot wins over the live profile. */
export function scopesForSession(
  snapshot: AgentSnapshot | undefined,
  live: AgentProfile | undefined,
): { sources: AgentScope; skills: AgentScope } {
  if (snapshot) return { sources: snapshot.sources, skills: snapshot.skills };
  return {
    sources: live?.sources ?? { ...ALL_SCOPE },
    skills: live?.skills ?? { ...ALL_SCOPE },
  };
}

export interface LegacyDefaults {
  strategy?: string | null;
  model?: string | null;
  permissionMode?: 'safe' | 'ask' | 'allow-all' | null;
  thinkingLevel?: string | null;
}

/**
 * One-shot v0 → v1 migration.
 *
 * Absorbs the legacy defaults (workspace `defaults.*` and the gateway's old
 * `defaultStrategy`) into the default agent, so the resolver has a single
 * source. Idempotent: a file already at v1 is left untouched.
 *
 * @returns true when the file was written.
 */
export function migrateAgentsFile(workspaceRoot: string, legacy: LegacyDefaults): boolean {
  const file = loadAgents(workspaceRoot);
  if (hasAgentsFile(workspaceRoot) && file.version >= 1) return false;

  const merged: AgentDefaults = {
    strategy: legacy.strategy ?? file.defaults.defaults.strategy ?? null,
    model: legacy.model ?? file.defaults.defaults.model ?? null,
    permissionMode: legacy.permissionMode ?? file.defaults.defaults.permissionMode ?? null,
    thinkingLevel: legacy.thinkingLevel ?? file.defaults.defaults.thinkingLevel ?? null,
  };

  saveAgents(workspaceRoot, {
    ...file,
    version: 1,
    defaults: { ...file.defaults, defaults: merged },
  });
  return true;
}

/** Convenience for callers that only have a workspace root. */
export function loadAgentsOrDefault(workspaceRoot: string): AgentsFile {
  return workspaceRoot ? loadAgents(workspaceRoot) : emptyAgentsFile();
}
