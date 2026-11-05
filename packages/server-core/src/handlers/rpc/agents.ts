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

/** The flat shape the renderer/picker consumes. */
function toOption(agent: AgentProfile) {
  return {
    id: agent.id,
    name: agent.name,
    icon: agent.icon,
    description: agent.persona.split('\n')[0]?.slice(0, 80) || undefined,
    builtin: agent.builtin === true,
  };
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
      if (!input.id || input.id === DEFAULT_AGENT_ID) {
        saveAgents(workspace.rootPath, {
          ...file,
          defaults: {
            persona: input.persona ?? file.defaults.persona,
            defaults: { ...EMPTY_DEFAULTS, ...file.defaults.defaults, ...(input.defaults ?? {}) },
            sources: input.sources ? normalizeScope(input.sources) : file.defaults.sources,
            skills: input.skills ? normalizeScope(input.skills) : file.defaults.skills,
          },
        });
        broadcast(workspaceId);
        return { id: DEFAULT_AGENT_ID };
      }

      const existingAt = file.agents.findIndex((a) => a.id === input.id);
      const profile: AgentProfile = {
        id: input.id,
        name: input.name?.trim() || input.id,
        icon: input.icon,
        color: input.color,
        persona: input.persona ?? '',
        defaults: { ...EMPTY_DEFAULTS, ...(input.defaults ?? {}) },
        sources: normalizeScope(input.sources),
        skills: normalizeScope(input.skills),
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
