/**
 * Agent (role profile) RPC surface.
 *
 * CRUD only. The resolver lives in `@craft-agent/shared/agents` and is used by
 * `createSession`; this file never decides defaults, it only stores profiles.
 */

import { randomUUID } from 'node:crypto';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport';
import {
  ALL_SCOPE,
  DEFAULT_AGENT_ID,
  EMPTY_DEFAULTS,
  MAX_DISPATCH_HINT_CHARS,
  getDefaultAgent,
  loadAgents,
  saveAgents,
  type AgentProfile,
  type AgentScope,
} from '@craft-agent/shared/agents';
import type { HandlerDeps } from '../handler-deps';

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.agents.LIST,
  RPC_CHANNELS.agents.GET,
  RPC_CHANNELS.agents.SAVE,
  RPC_CHANNELS.agents.DELETE,
  RPC_CHANNELS.agents.CHANGED,
] as const;

function requireWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
  return workspace;
}

function normalizeScope(input: unknown): AgentScope {
  if (!input || typeof input !== 'object') return { ...ALL_SCOPE };
  const value = input as Partial<AgentScope>;
  return {
    mode: value.mode === 'allowlist' ? 'allowlist' : 'all',
    slugs: Array.isArray(value.slugs)
      ? Array.from(new Set(value.slugs.filter((s): s is string => typeof s === 'string' && s.trim() !== '')))
      : [],
  };
}

/**
 * The flat shape the renderer/picker consumes.
 *
 * `description` is the one-line label under the name in the picker, so it prefers
 * `dispatchHint` — the field written to be read by someone other than the agent.
 * The hint is returned in full as well, because the settings page shows every
 * role's hint side by side to make overlaps visible, and a label clipped to 80
 * characters cannot do that job.
 */
function toOption(agent: AgentProfile) {
  const firstLine = agent.persona
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const hint = agent.dispatchHint?.trim() || undefined;
  return {
    id: agent.id,
    name: agent.name,
    icon: agent.icon,
    description: (hint ?? firstLine)?.slice(0, 80) || undefined,
    dispatchHint: hint,
    // 渠道闸门（v6/v7）：可分配开关（缺省 false）——通道助手下拉 + 派活名单用
    assignable: agent.assignable === true,
    memoryDomain: agent.memoryDomain,
    builtin: agent.builtin === true,
  };
}

/** Trim, cap, drop-if-empty: the same normalisation the storage layer applies. */
function normalizeHint(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  return trimmed ? trimmed.slice(0, MAX_DISPATCH_HINT_CHARS) : undefined;
}

export function registerAgentsHandlers(server: RpcServer, _deps: HandlerDeps): void {
  const broadcast = (workspaceId: string) => {
    pushTyped(
      server,
      RPC_CHANNELS.agents.CHANGED,
      { to: 'workspace', workspaceId },
      { workspaceId },
    );
  };

  // NOTE the argument shape: the RPC transport calls handlers as
  // `handler(ctx, ...args)`, exactly like the older channels in settings.ts.
  // These four handlers were written against an object payload, so every
  // `payload.workspaceId` was `undefined` at runtime — `agents:list` threw
  // "Cannot read properties of undefined (reading 'toLowerCase')" and the
  // composer's role picker silently rendered nothing.
  server.handle(RPC_CHANNELS.agents.LIST, async (_ctx, workspaceId: string) => {
    const workspace = requireWorkspace(workspaceId);
    const file = loadAgents(workspace.rootPath);
    // The built-in default is materialized, never stored: exactly one default.
    return [toOption(getDefaultAgent(file)), ...file.agents.filter((a) => !a.deletedAt).map(toOption)];
  });

  server.handle(
    RPC_CHANNELS.agents.GET,
    async (_ctx, workspaceId: string, id: string) => {
      const workspace = requireWorkspace(workspaceId);
      const file = loadAgents(workspace.rootPath);
      const profile =
        id === DEFAULT_AGENT_ID ? getDefaultAgent(file) : file.agents.find((a) => a.id === id && !a.deletedAt);
      if (!profile) throw new Error(`Agent not found: ${id}`);
      return profile;
    },
  );

  server.handle(
    RPC_CHANNELS.agents.SAVE,
    async (
      _ctx,
      workspaceId: string,
      agent?: Partial<AgentProfile> & { id?: string },
    ) => {
      const workspace = requireWorkspace(workspaceId);
      const file = loadAgents(workspace.rootPath);
      const input = agent ?? {};
      const now = Date.now();

      // Saving the built-in default edits the `defaults` block instead of
      // creating a row, so there is no second "default" to keep in sync.
      //
      // The id must be explicit here. Treating a *missing* id as "the default"
      // made 新建角色 impossible: the editor sends no id for a new profile, so
      // every save rewrote the workspace defaults and `agents[]` stayed empty.
      if (input.id === DEFAULT_AGENT_ID) {
        saveAgents(workspace.rootPath, {
          ...file,
          defaults: {
            persona: input.persona ?? file.defaults.persona,
            // The default profile's hint *is* editable — unlike its name, which is
            // derived. Routing needs to know what the fallback agent is for just as
            // much as it needs to know for a named role.
            ...(input.dispatchHint !== undefined
              ? { dispatchHint: normalizeHint(input.dispatchHint) }
              : {}),
            defaults: { ...EMPTY_DEFAULTS, ...file.defaults.defaults, ...(input.defaults ?? {}) },
            sources: input.sources ? normalizeScope(input.sources) : file.defaults.sources,
            skills: input.skills ? normalizeScope(input.skills) : file.defaults.skills,
            // 渠道闸门（v6/v7）：default agent 卡上的开关/记忆域也落 defaults 块
            // （同读侧白名单，漏了就是「保存后刷新丢值」）。memoryDomain 空串=未指定，
            // 不写 key（JSON 无法表达显式 undefined，清除旧值留待域体系阶段 4 一起接）
            ...(input.assignable !== undefined ? { assignable: input.assignable } : {}),
            ...(typeof input.memoryDomain === 'string' && input.memoryDomain.trim()
              ? { memoryDomain: input.memoryDomain.trim() }
              : {}),
          },
        });
        broadcast(workspaceId);
        return { id: DEFAULT_AGENT_ID };
      }

      const existingAt = file.agents.findIndex((a) => a.id === input.id);
      const profile: AgentProfile = {
        id: input.id ?? newAgentId(),
        name: input.name?.trim() || input.id || '新角色',
        icon: input.icon,
        color: input.color,
        persona: input.persona ?? '',
        ...(normalizeHint(input.dispatchHint)
          ? { dispatchHint: normalizeHint(input.dispatchHint) }
          : {}),
        defaults: { ...EMPTY_DEFAULTS, ...(input.defaults ?? {}) },
        sources: normalizeScope(input.sources),
        skills: normalizeScope(input.skills),
        // 渠道闸门（v6/v7）：可分配开关 + 记忆域（缺省=不进入派活名单/未接域体系）。
        // memoryDomain 归一化：非空才写，空串=未指定（不落 ''，与读侧白名单同语义）
        ...(input.assignable !== undefined ? { assignable: input.assignable } : {}),
        ...(typeof input.memoryDomain === 'string' && input.memoryDomain.trim()
          ? { memoryDomain: input.memoryDomain.trim() }
          : {}),
        builtin: false,
        createdAt: existingAt >= 0 ? file.agents[existingAt].createdAt : now,
        updatedAt: now,
        deletedAt: null,
      };

      const agents =
        existingAt >= 0
          ? file.agents.map((a, i) => (i === existingAt ? profile : a))
          : [...file.agents, profile];

      saveAgents(workspace.rootPath, { ...file, agents });
      broadcast(workspaceId);
      return { id: profile.id };
    },
  );

  server.handle(
    RPC_CHANNELS.agents.DELETE,
    async (_ctx, workspaceId: string, id: string) => {
      const workspace = requireWorkspace(workspaceId);
      const file = loadAgents(workspace.rootPath);
      if (id === DEFAULT_AGENT_ID) {
        throw new Error('The built-in default agent cannot be deleted.');
      }
      // Soft delete: historical sessions keep their snapshot, and the picker
      // simply stops offering it.
      saveAgents(workspace.rootPath, {
        ...file,
        agents: file.agents.map((agent) =>
          agent.id === id ? { ...agent, deletedAt: Date.now() } : agent,
        ),
      });
      broadcast(workspaceId);
      return { ok: true };
    },
  );
}

/** Exported for the create-session default (new agent id). */
export function newAgentId(): string {
  return `agt_${randomUUID().slice(0, 8)}`;
}
