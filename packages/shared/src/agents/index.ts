/**
 * Public surface of the agents module.
 *
 * Kept as a barrel so every caller (server-core, session tools, renderer
 * bridges) imports the same names, and so the storage details stay private.
 */

export type {
  AgentDefaults,
  AgentProfile,
  AgentScope,
  AgentsFile,
} from './types.ts';

export type {
  AgentSnapshot,
  LegacyDefaults,
  ResolveAgentOptions,
  ResolveDefaultsOptions,
  ResolvedDefaults,
} from './resolve.ts';

export {
  AGENTS_FILE_VERSION,
  ALL_SCOPE,
  DEFAULT_AGENT_ID,
  EMPTY_DEFAULTS,
  applyScope,
  emptyAgentsFile,
  isAgentScope,
} from './types.ts';

export { getAgentsFilePath, hasAgentsFile, loadAgents, saveAgents } from './storage.ts';

export { buildAgentRosterBlock, formatAgentRosterBlock, readAgentRoster } from './prompt.ts';
export type { AgentPromptEntry } from './prompt.ts';

export {
  buildAgentSnapshot,
  getAgentById,
  getDefaultAgent,
  loadAgentsOrDefault,
  migrateAgentsFile,
  personForSession,
  resolveAgent,
  resolveSessionDefaults,
  resolveStrategy,
  scopesForSession,
} from './resolve.ts';
