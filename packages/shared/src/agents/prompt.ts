import { existsSync } from 'node:fs';

import { loadAgents } from '../agents/storage.ts';
import { DEFAULT_AGENT_ID, type AgentProfile } from '../agents/types.ts';

/**
 * The agent roster injected into the supervisor prompt.
 *
 * Why a prompt block instead of a `list_agents` tool: the failure this addresses
 * is the supervisor spending turns *discovering* things. It already burned
 * ~160 seconds of one turn on `list_sessions`/`get_session_info` hunting for a
 * session to hand work to. A discovery tool would add a round trip to every
 * dispatch decision — the roster is tiny and static enough to sit in the prompt,
 * where it costs nothing per turn and is re-read every turn (the prompt is
 * rebuilt per turn, so an added agent appears without recreating the session).
 *
 * The routing gist comes from `dispatchHint` when the profile has one — that
 * field exists precisely to answer "is this a UI job or a research job", the
 * only question the supervisor asks of an entry.
 *
 * Profiles written before the field existed fall back to the first line of the
 * persona. That fallback is a compromise, not a design: a persona opens with a
 * behavioural instruction addressed to the agent itself, so an entry can route
 * on a sentence that says nothing about scope. Filling in the hint upgrades the
 * entry; leaving it blank keeps the old behaviour rather than going silent.
 */
const MAX_PERSONA_CHARS = 160;
/** The hint has its own bound: it is sentence-shaped, so it needs less room. */
const MAX_HINT_CHARS = 120;

export interface AgentPromptEntry {
  id: string;
  name: string;
  /** First line of the persona, flattened and truncated. */
  gist?: string;
  /** True for the profile new sessions get when nothing is specified. */
  isDefault?: boolean;
}

function toEntry(agent: AgentProfile, defaultAgentId: string): AgentPromptEntry {
  const hint = agent.dispatchHint?.replace(/\s+/g, ' ').trim();
  const firstLine = agent.persona
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const gist = hint
    ? hint.slice(0, MAX_HINT_CHARS)
    : firstLine?.replace(/\s+/g, ' ').slice(0, MAX_PERSONA_CHARS);
  return {
    id: agent.id,
    name: agent.name,
    ...(gist ? { gist } : {}),
    ...(agent.id === defaultAgentId ? { isDefault: true } : {}),
  };
}

/**
 * Read the workspace roster, marking the default.
 *
 * The built-in default profile is not stored in `agents[]` — it is synthesized —
 * so it is added explicitly. Without it the roster would omit the profile that
 * every unassigned task actually runs as, which is exactly the one the
 * supervisor needs to understand when it leaves `assigneeAgentId` blank.
 */
export function readAgentRoster(workspaceRootPath: string | undefined): AgentPromptEntry[] {
  if (!workspaceRootPath) return [];
  // `loadAgents` tolerates a missing file by returning an empty roster, which is
  // right for session creation (fall through to the built-in default) and wrong
  // here: it would print a one-entry roster for a path that does not exist. The
  // existence check keeps "no workspace" and "workspace with only the default"
  // distinguishable — the first prints nothing, the second says so.
  if (!existsSync(workspaceRootPath)) return [];
  try {
    const file = loadAgents(workspaceRootPath);
    const defaultAgentId = file.defaultAgentId?.trim() || DEFAULT_AGENT_ID;
    const live = file.agents
      .filter((agent) => !agent.deletedAt)
      .map((agent) => toEntry(agent, defaultAgentId));
    const hasDefault = live.some((entry) => entry.id === DEFAULT_AGENT_ID);
    return hasDefault
      ? live
      : [{ id: DEFAULT_AGENT_ID, name: '默认', ...(defaultAgentId === DEFAULT_AGENT_ID ? { isDefault: true } : {}) }, ...live];
  } catch {
    return [];
  }
}

/**
 * Format the roster. Returns '' when there is nothing to say, so the caller can
 * append unconditionally.
 */
export function formatAgentRosterBlock(entries: AgentPromptEntry[]): string {
  if (entries.length === 0) return '';

  const lines = entries.map((entry) => {
    const label = entry.isDefault ? `${entry.name}，未指定时的默认` : entry.name;
    return entry.gist ? `- \`${entry.id}\`（${label}）：${entry.gist}` : `- \`${entry.id}\`（${label}）`;
  });

  return [
    '',
    '## 可选角色',
    '',
    '`task_create` 的 `assigneeAgentId` 和 `dispatch` 的 `target.agentId` 决定**由谁来做**。按任务性质选：要改 UI 的和要查资料的，不该是同一个人。留空就用默认角色。',
    '',
    ...lines,
    '',
    '选错了不用重派：`task_update` 也能改 `assigneeAgentId`，但只对**还没起会话**的任务有效——已经跑起来的会话带着原来的角色。',
  ].join('\n');
}

/** Convenience: read + format in one call. */
export function buildAgentRosterBlock(workspaceRootPath: string | undefined): string {
  return formatAgentRosterBlock(readAgentRoster(workspaceRootPath));
}
