import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyScope, DEFAULT_AGENT_ID, emptyAgentsFile, type AgentProfile } from '../types.ts';
import { getAgentsFilePath, loadAgents, saveAgents } from '../storage.ts';
import {
  buildAgentSnapshot,
  getAgentById,
  getDefaultAgent,
  migrateAgentsFile,
  personForSession,
  resolveSessionDefaults,
  resolveStrategy,
  scopesForSession,
} from '../resolve.ts';

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-agents-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'agt_frontend',
    name: '前端',
    persona: '你是前端工程师',
    defaults: { strategy: 'frontend', model: null, permissionMode: 'ask', thinkingLevel: null },
    sources: { mode: 'all', slugs: [] },
    skills: { mode: 'all', slugs: [] },
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

describe('agents storage', () => {
  it('returns an empty file when nothing exists', () => {
    const file = loadAgents(workspace());
    expect(file.version).toBe(0);
    expect(file.defaultAgentId).toBe(DEFAULT_AGENT_ID);
    expect(file.agents).toEqual([]);
    expect(file.defaults.persona).toBe('');
  });

  it('round-trips profiles and drops the reserved default id', () => {
    const ws = workspace();
    const base = emptyAgentsFile();
    saveAgents(ws, {
      ...base,
      agents: [profile(), profile({ id: DEFAULT_AGENT_ID, name: '冒名的默认' })],
    });

    const loaded = loadAgents(ws);
    expect(loaded.agents).toHaveLength(1);
    expect(loaded.agents[0]?.id).toBe('agt_frontend');
    expect(loaded.version).toBe(1);
  });

  it('survives a corrupt file instead of throwing', () => {
    const ws = workspace();
    writeFileSync(getAgentsFilePath(ws), '{ not json', 'utf-8');
    expect(() => loadAgents(ws)).not.toThrow();
    expect(loadAgents(ws).agents).toEqual([]);
  });

  it('normalizes unknown scope modes and permission values', () => {
    const ws = workspace();
    writeFileSync(
      getAgentsFilePath(ws),
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: 'a1',
            name: 'A',
            persona: '',
            defaults: { permissionMode: 'god-mode', strategy: '  ' },
            sources: { mode: 'weird', slugs: ['x', 'x', ''] },
            skills: {},
          },
        ],
      }),
      'utf-8',
    );

    const agent = loadAgents(ws).agents[0]!;
    expect(agent.defaults.permissionMode).toBeNull();
    expect(agent.defaults.strategy).toBeNull();
    expect(agent.sources.mode).toBe('all');
    expect(agent.sources.slugs).toEqual(['x']);
    expect(agent.skills.mode).toBe('all');
  });
});

describe('agent lookup', () => {
  it('falls back to the default profile for unknown or deleted ids', () => {
    const file = { ...emptyAgentsFile(), agents: [profile({ deletedAt: 5 })] };
    expect(getAgentById(file, 'agt_frontend').id).toBe(DEFAULT_AGENT_ID);
    expect(getAgentById(file, 'nope').id).toBe(DEFAULT_AGENT_ID);
    expect(getAgentById(file, undefined).id).toBe(DEFAULT_AGENT_ID);
  });

  it('materializes the default profile from the defaults block', () => {
    const file = emptyAgentsFile();
    file.defaults.persona = '默认人设';
    file.defaults.defaults.strategy = 's1';
    const agent = getDefaultAgent(file);
    expect(agent.persona).toBe('默认人设');
    expect(agent.defaults.strategy).toBe('s1');
    expect(agent.builtin).toBe(true);
  });
});

describe('strategy resolution', () => {
  it('prefers the explicit caller value', () => {
    expect(resolveStrategy('explicit', profile(), ['first'])).toBe('explicit');
  });

  it('falls back to the agent default', () => {
    expect(resolveStrategy(undefined, profile(), ['first'])).toBe('frontend');
  });

  it('falls back to the first enabled group when nothing is configured', () => {
    const bare = profile({ defaults: { strategy: null } });
    expect(resolveStrategy(null, bare, ['alpha', 'beta'])).toBe('alpha');
    expect(resolveStrategy(null, undefined, ['alpha'])).toBe('alpha');
    expect(resolveStrategy(null, undefined, [])).toBeUndefined();
  });

  it('treats blank strings as unset', () => {
    expect(resolveStrategy('   ', profile(), ['first'])).toBe('frontend');
  });
});

describe('session defaults', () => {
  it('resolves the whole bundle in one pass', () => {
    const ws = workspace();
    const base = emptyAgentsFile();
    saveAgents(ws, { ...base, agents: [profile()] });

    const resolved = resolveSessionDefaults({
      workspaceRoot: ws,
      agentId: 'agt_frontend',
      enabledStrategies: ['first'],
    });

    expect(resolved.agent.id).toBe('agt_frontend');
    expect(resolved.strategy).toBe('frontend');
    expect(resolved.permissionMode).toBe('ask');
  });

  it('keeps legacy workspace defaults working before migration', () => {
    const ws = workspace();
    const resolved = resolveSessionDefaults({
      workspaceRoot: ws,
      workspaceDefaults: { strategy: 'legacy', permissionMode: 'safe' },
      enabledStrategies: ['first'],
    });
    expect(resolved.strategy).toBe('legacy');
    expect(resolved.permissionMode).toBe('safe');
  });

  it('never yields an undefined strategy when a group is enabled', () => {
    const ws = workspace();
    const resolved = resolveSessionDefaults({ workspaceRoot: ws, enabledStrategies: ['only'] });
    expect(resolved.strategy).toBe('only');
  });
});

describe('scopes', () => {
  it('keeps all candidates for mode=all', () => {
    expect(applyScope({ mode: 'all', slugs: [] }, ['a', 'b'])).toEqual(['a', 'b']);
    expect(applyScope(undefined, ['a'])).toEqual(['a']);
  });

  it('filters to the allowlist, preserving candidate order', () => {
    expect(applyScope({ mode: 'allowlist', slugs: ['b', 'c'] }, ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });

  it('yields nothing when the allowlist is empty', () => {
    expect(applyScope({ mode: 'allowlist', slugs: [] }, ['a'])).toEqual([]);
  });
});

describe('session snapshot', () => {
  it('prefers the snapshot over the live profile', () => {
    const live = profile({ persona: '新人设', sources: { mode: 'all', slugs: [] } });
    const snapshot = buildAgentSnapshot(profile({ persona: '旧人设' }));

    expect(personForSession(snapshot, live)).toBe('旧人设');
    expect(personForSession(undefined, live)).toBe('新人设');
    expect(scopesForSession(snapshot, live).sources.mode).toBe('all');
  });

  it('freezes the snapshot at creation time', () => {
    const snapshot = buildAgentSnapshot(profile());
    expect(snapshot.agentId).toBe('agt_frontend');
    expect(snapshot.name).toBe('前端');
    expect(snapshot.pinnedAt).toBeGreaterThan(0);
  });
});

describe('v0 → v1 migration', () => {
  it('absorbs legacy defaults and bumps the version', () => {
    const ws = workspace();
    const migrated = migrateAgentsFile(ws, {
      strategy: 'legacy-group',
      permissionMode: 'allow-all',
    });

    expect(migrated).toBe(true);
    const file = loadAgents(ws);
    expect(file.version).toBe(1);
    expect(file.defaults.defaults.strategy).toBe('legacy-group');
    expect(file.defaults.defaults.permissionMode).toBe('allow-all');
  });

  it('is idempotent once at v1', () => {
    const ws = workspace();
    migrateAgentsFile(ws, { strategy: 'first-run' });
    expect(migrateAgentsFile(ws, { strategy: 'second-run' })).toBe(false);
    expect(loadAgents(ws).defaults.defaults.strategy).toBe('first-run');
  });

  it('keeps an existing agents value over the legacy one', () => {
    const ws = workspace();
    const base = emptyAgentsFile();
    saveAgents(ws, {
      ...base,
      version: 0,
      defaults: { ...base.defaults, defaults: { strategy: 'already-set' } },
    });

    migrateAgentsFile(ws, { strategy: 'legacy' });
    expect(loadAgents(ws).defaults.defaults.strategy).toBe('already-set');
  });
});

describe('channel-gate fields survive the read-side whitelist（11-18 活体验收：SAVE 白名单修了、读侧 normalizeProfile 没修 → 每次 load 都把 assignable/memoryDomain 剥掉，GET/水合丢值 → 自动保存回写污染）', () => {
  it('profile 行：save→load 往返两字段不丢', () => {
    const ws = workspace();
    const file = loadAgents(ws);
    saveAgents(ws, {
      ...file,
      agents: [{ ...profile(), assignable: true, memoryDomain: 'agent-frontend' }],
    });
    const reloaded = loadAgents(ws);
    expect(reloaded.agents[0]?.assignable).toBe(true);
    expect(reloaded.agents[0]?.memoryDomain).toBe('agent-frontend');
  });

  it('memoryDomain 空串/纯空白 = 未指定，读时剥除（H1 缺省语义，不落 "" 进库）', () => {
    const ws = workspace();
    const file = loadAgents(ws);
    saveAgents(ws, { ...file, agents: [{ ...profile(), memoryDomain: '   ' }] });
    expect(loadAgents(ws).agents[0]?.memoryDomain).toBeUndefined();
  });

  it('assignable=false 显式落盘（关 vs 缺省 读时同 false，但字段保留）', () => {
    const ws = workspace();
    const file = loadAgents(ws);
    saveAgents(ws, { ...file, agents: [{ ...profile(), assignable: false }] });
    expect(loadAgents(ws).agents[0]?.assignable).toBe(false);
  });

  it('defaults 块（default agent 卡）两字段同样不丢', () => {
    const ws = workspace();
    const file = loadAgents(ws);
    file.defaults = { ...file.defaults, assignable: true, memoryDomain: 'shared-domain' };
    saveAgents(ws, file);
    const reloaded = loadAgents(ws);
    expect(reloaded.defaults.assignable).toBe(true);
    expect(reloaded.defaults.memoryDomain).toBe('shared-domain');
  });
});
