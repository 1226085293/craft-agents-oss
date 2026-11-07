/**
 * Agents storage.
 *
 * One file per workspace: `<workspace>/agents.json`. Kept as plain JSON (not a
 * database) so it can be inspected, diffed and hand-edited — the same reason
 * `config.json` is JSON.
 *
 * Reads are tolerant: a malformed or missing file yields the empty profile
 * rather than throwing, because a broken agents file must never prevent a
 * session from being created.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  AGENTS_FILE_VERSION,
  DEFAULT_AGENT_ID,
  EMPTY_DEFAULTS,
  ALL_SCOPE,
  MAX_DISPATCH_HINT_CHARS,
  emptyAgentsFile,
  type AgentDefaults,
  type AgentProfile,
  type AgentScope,
  type AgentsFile,
} from './types.ts';

export function getAgentsFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, 'agents.json');
}

function normalizeScope(value: unknown, fallback: AgentScope): AgentScope {
  if (!value || typeof value !== 'object') return { ...fallback };
  const v = value as Partial<AgentScope>;
  const mode = v.mode === 'allowlist' ? 'allowlist' : 'all';
  const slugs = Array.isArray(v.slugs)
    ? Array.from(new Set(v.slugs.filter((s): s is string => typeof s === 'string' && s.trim() !== '')))
    : [];
  return { mode, slugs };
}

function normalizeDefaults(value: unknown): AgentDefaults {
  if (!value || typeof value !== 'object') return { ...EMPTY_DEFAULTS };
  const v = value as Partial<AgentDefaults>;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() !== '' ? x : null);
  const permission = v.permissionMode;
  return {
    strategy: str(v.strategy),
    model: str(v.model),
    permissionMode:
      permission === 'safe' || permission === 'ask' || permission === 'allow-all' ? permission : null,
    thinkingLevel: str(v.thinkingLevel),
  };
}

function normalizeProfile(raw: unknown, now: number): AgentProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<AgentProfile>;
  if (typeof v.id !== 'string' || !v.id.trim()) return null;
  // The default id is reserved: it lives in `defaults`, never in `agents[]`.
  if (v.id === DEFAULT_AGENT_ID) return null;
  return {
    id: v.id,
    name: typeof v.name === 'string' && v.name.trim() ? v.name : v.id,
    icon: typeof v.icon === 'string' ? v.icon : undefined,
    color: typeof v.color === 'string' ? v.color : undefined,
    persona: typeof v.persona === 'string' ? v.persona : '',
    ...(typeof v.dispatchHint === 'string' && v.dispatchHint.trim()
      ? { dispatchHint: v.dispatchHint.trim().slice(0, MAX_DISPATCH_HINT_CHARS) }
      : {}),
    defaults: normalizeDefaults(v.defaults),
    sources: normalizeScope(v.sources, ALL_SCOPE),
    skills: normalizeScope(v.skills, ALL_SCOPE),
    builtin: v.builtin === true,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : now,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : now,
    deletedAt: typeof v.deletedAt === 'number' ? v.deletedAt : null,
  };
}

/** Read + normalize. Never throws on a missing/corrupt file. */
export function loadAgents(workspaceRoot: string): AgentsFile {
  const path = getAgentsFilePath(workspaceRoot);
  if (!existsSync(path)) {
    // No file yet is version 0: it is what tells the migration guard there is
    // legacy state (workspace `defaults.*`, gateway `defaultStrategy`) to absorb.
    return { ...emptyAgentsFile(), version: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { ...emptyAgentsFile(), version: 0 };
  }
  if (!parsed || typeof parsed !== 'object') return { ...emptyAgentsFile(), version: 0 };
  const raw = parsed as Partial<AgentsFile>;
  const now = Date.now();
  const agents = Array.isArray(raw.agents)
    ? (raw.agents.map((a) => normalizeProfile(a, now)).filter(Boolean) as AgentProfile[])
    : [];
  const defaultsRaw = (raw.defaults ?? {}) as Partial<AgentsFile['defaults']>;
  return {
    version: typeof raw.version === 'number' ? raw.version : 0,
    defaultAgentId:
      typeof raw.defaultAgentId === 'string' && raw.defaultAgentId.trim()
        ? raw.defaultAgentId
        : DEFAULT_AGENT_ID,
    defaults: {
      persona: typeof defaultsRaw.persona === 'string' ? defaultsRaw.persona : '',
      ...(typeof defaultsRaw.dispatchHint === 'string' && defaultsRaw.dispatchHint.trim()
        ? { dispatchHint: defaultsRaw.dispatchHint.trim().slice(0, MAX_DISPATCH_HINT_CHARS) }
        : {}),
      defaults: normalizeDefaults(defaultsRaw.defaults),
      sources: normalizeScope(defaultsRaw.sources, ALL_SCOPE),
      skills: normalizeScope(defaultsRaw.skills, ALL_SCOPE),
    },
    agents,
  };
}

export function saveAgents(workspaceRoot: string, file: AgentsFile): void {
  const path = getAgentsFilePath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true });
  const payload: AgentsFile = { ...file, version: AGENTS_FILE_VERSION };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

/** True when the workspace has never had an agents file (no user edits yet). */
export function hasAgentsFile(workspaceRoot: string): boolean {
  return existsSync(getAgentsFilePath(workspaceRoot));
}
