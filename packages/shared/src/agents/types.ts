/**
 * Agent (role profile) types.
 *
 * An "agent" here is a *configuration bundle*, not a process and not a session
 * kind: it carries the persona prompt injected into the system prompt plus the
 * defaults a new session inherits (strategy group, model, permission mode,
 * thinking level) and the two scope ceilings (sources, skills).
 *
 * The built-in "default" agent lives in the top-level `defaults` block of
 * `agents.json` rather than as a row in `agents[]`, so there is exactly one
 * default and no "the builtin row was deleted" edge case.
 */

/** 'all' = no ceiling; 'allowlist' = the listed slugs are the maximum. */
export type ScopeMode = 'all' | 'allowlist';

export interface AgentScope {
  mode: ScopeMode;
  slugs: string[];
}

export interface AgentDefaults {
  /** Gateway strategy group id. Empty → first enabled group. */
  strategy?: string | null;
  /** Model id. Empty → resolved by the connection/strategy. */
  model?: string | null;
  /** Default permission mode for sessions created with this agent. Not a ceiling. */
  permissionMode?: 'safe' | 'ask' | 'allow-all' | null;
  /** Default reasoning level for sessions created with this agent. */
  thinkingLevel?: string | null;
}

/**
 * Upper bound on `dispatchHint`, enforced on write and again on read.
 *
 * This string is repeated in the supervisor's prompt **every turn**, so its
 * length is a per-turn cost, not just a layout constraint.
 */
export const MAX_DISPATCH_HINT_CHARS = 120;

export interface AgentProfile {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  /** Markdown injected into the system prompt as a pinned `<persona>` block. */
  persona: string;
  /**
   * How a dispatcher should *choose* this agent — for someone else, not for the
   * agent itself.
   *
   * Kept separate from `persona` because the two answer opposite questions.
   * `persona` is second-person behavioural instruction ("你负责…") addressed to
   * the agent and read by it after it was already chosen. This field is
   * third-person and discriminative ("接什么、不接什么"), addressed to whatever
   * decides who does the work, and read before a session exists.
   *
   * Before this existed, the supervisor derived a routing gist from the first
   * line of `persona` — a behavioural sentence moonlighting as a job
   * description. That works only by luck: a persona opening with "你是一位严谨
   * 的工程师" routes as nothing.
   *
   * **NOT part of the agent's system prompt.** Deliberately excluded from
   * `AgentSnapshot`: routing happens before the session exists, and an agent
   * that could read its own dispatch description would start reasoning about
   * being dispatched. If you are adding a prompt block somewhere and this field
   * is in reach, leave it out.
   */
  dispatchHint?: string;
  defaults: AgentDefaults;
  sources: AgentScope;
  skills: AgentScope;
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Soft delete: historical sessions keep resolving their snapshot. */
  deletedAt?: number | null;
}

/** The built-in default profile (id is reserved and never stored in `agents[]`). */
export const DEFAULT_AGENT_ID = 'builtin-default';

/**
 * Wire shape of `<workspace>/agents.json`.
 *
 * `version` guards the one-shot migration that absorbs the legacy defaults
 * (`wsConfig.defaults.*` and `LlmConfig.defaultStrategy`) into `defaults`.
 */
export interface AgentsFile {
  version: number;
  defaultAgentId: string;
  defaults: Omit<AgentProfile, 'id' | 'name' | 'builtin' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
  agents: AgentProfile[];
}

export const AGENTS_FILE_VERSION = 1;

/** A scope that allows everything. */
export const ALL_SCOPE: AgentScope = { mode: 'all', slugs: [] };

/** Empty defaults: every field falls through to the next tier. */
export const EMPTY_DEFAULTS: AgentDefaults = {
  strategy: null,
  model: null,
  permissionMode: null,
  thinkingLevel: null,
};

export function emptyAgentsFile(): AgentsFile {
  return {
    version: AGENTS_FILE_VERSION,
    defaultAgentId: DEFAULT_AGENT_ID,
    defaults: {
      persona: '',
      defaults: { ...EMPTY_DEFAULTS },
      sources: { ...ALL_SCOPE },
      skills: { ...ALL_SCOPE },
    },
    agents: [],
  };
}

/**
 * Resolve a scope against a candidate list.
 *
 * @param scope   Agent ceiling.
 * @param candidates Slugs the session could otherwise use (workspace sources /
 *   loaded skills).
 * @returns The slugs allowed for this session, preserving `candidates` order so
 *   the result stays byte-stable for prompt caching.
 */
export function applyScope(scope: AgentScope | undefined, candidates: string[]): string[] {
  if (!scope || scope.mode === 'all') return candidates;
  const allowed = new Set(scope.slugs);
  return candidates.filter((slug) => allowed.has(slug));
}

export function isAgentScope(value: unknown): value is AgentScope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<AgentScope>;
  return (v.mode === 'all' || v.mode === 'allowlist') && Array.isArray(v.slugs);
}
