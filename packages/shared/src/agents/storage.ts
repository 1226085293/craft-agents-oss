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
  emptyAgentsFile,
  type AgentProfile,
  type AgentsFile,
} from './types.ts';
import { normalizeAgentDefaultsBlock, normalizeAgentProfile } from './schema.ts';

export function getAgentsFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, 'agents.json');
}

/** Read + normalize. Field list lives in `schema.ts` — do not re-list fields here. */
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
    ? (raw.agents.map((a) => normalizeAgentProfile(a, now)).filter(Boolean) as AgentProfile[])
    : [];
  return {
    version: typeof raw.version === 'number' ? raw.version : 0,
    defaultAgentId:
      typeof raw.defaultAgentId === 'string' && raw.defaultAgentId.trim()
        ? raw.defaultAgentId
        : DEFAULT_AGENT_ID,
    defaults: normalizeAgentDefaultsBlock(raw.defaults),
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
