import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAgentRosterBlock, formatAgentRosterBlock, readAgentRoster } from '../prompt.ts';
import { saveAgents } from '../storage.ts';
import { emptyAgentsFile, DEFAULT_AGENT_ID, type AgentProfile, type AgentsFile } from '../types.ts';
import { buildAgentSnapshot } from '../resolve.ts';

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-roster-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profile(overrides: Partial<AgentProfile> & { id: string; name: string }): AgentProfile {
  const file = emptyAgentsFile();
  return {
    ...file.defaults,
    ...overrides,
    createdAt: 1,
    updatedAt: 1,
  } as AgentProfile;
}

function writeRoster(root: string, agents: AgentProfile[], defaultAgentId?: string): AgentsFile {
  const file: AgentsFile = { ...emptyAgentsFile(), agents };
  if (defaultAgentId) file.defaultAgentId = defaultAgentId;
  saveAgents(root, file);
  return file;
}

describe('agent roster', () => {
  it('lists the stored profiles and marks the default', () => {
    const root = workspace();
    writeRoster(
      root,
      [
        profile({ id: 'agent-ui', name: '前端工', persona: '你负责界面。\n第二行不该出现' }),
        profile({ id: 'agent-research', name: '调研员', persona: '你负责查资料。' }),
      ],
      'agent-ui',
    );

    const roster = readAgentRoster(root);

    expect(roster.map((entry) => entry.id)).toEqual(['builtin-default', 'agent-ui', 'agent-research']);
    // The default is whichever profile unassigned work would run as.
    expect(roster.find((entry) => entry.id === 'agent-ui')?.isDefault).toBe(true);
    expect(roster.find((entry) => entry.id === 'builtin-default')?.isDefault).toBeUndefined();
  });

  it('keeps only the first line of a persona', () => {
    const root = workspace();
    writeRoster(root, [profile({ id: 'agent-ui', name: '前端工', persona: '你负责界面。\n还有一段很长的细则' })]);
    const gist = readAgentRoster(root).find((entry) => entry.id === 'agent-ui')?.gist;
    expect(gist).toBe('你负责界面。');
  });

  it('omits soft-deleted profiles', () => {
    const root = workspace();
    writeRoster(root, [
      profile({ id: 'agent-gone', name: '已删', persona: 'x', deletedAt: 2 }),
      profile({ id: 'agent-live', name: '在岗', persona: 'y' }),
    ]);
    expect(readAgentRoster(root).map((entry) => entry.id)).not.toContain('agent-gone');
  });

  it('always includes the built-in default, even when it is not stored', () => {
    // The built-in profile is synthesized, so a naive `.agents` walk omits the one
    // profile that unassigned tasks actually run as.
    const root = workspace();
    writeRoster(root, [profile({ id: 'agent-ui', name: '前端工', persona: 'x' })]);
    const ids = readAgentRoster(root).map((entry) => entry.id);
    expect(ids).toContain(DEFAULT_AGENT_ID);
  });

  it('prints the ids the supervisor has to type into assigneeAgentId', () => {
    const root = workspace();
    writeRoster(root, [profile({ id: 'agent-ui', name: '前端工', persona: '你负责界面。' })]);
    const block = buildAgentRosterBlock(root);
    expect(block).toContain('`agent-ui`');
    expect(block).toContain('前端工');
    expect(block).toContain('assigneeAgentId');
  });

  it('describes the synthesized default too, from the defaults block', () => {
    // The builtin is materialized from `defaults`, not stored in `agents[]`. It used
    // to reach the roster as a bare id next to fully described roles, which reads
    // as "this one has no scope" — while it is the profile every unassigned task
    // actually runs as.
    const root = workspace();
    writeRoster(root, [profile({ id: 'agent-ui', name: '前端工', persona: '你负责界面。' })]);
    const file: AgentsFile = {
      ...emptyAgentsFile(),
      agents: [profile({ id: 'agent-ui', name: '前端工', persona: '你负责界面。' })],
      defaults: {
        ...emptyAgentsFile().defaults,
        persona: '你是默认角色。',
        dispatchHint: '兜底的万能手。',
      },
    };
    saveAgents(root, file);

    const entry = readAgentRoster(root).find((e) => e.id === DEFAULT_AGENT_ID);
    expect(entry?.gist).toBe('兜底的万能手。');
    expect(buildAgentRosterBlock(root)).toContain('兜底的万能手。');
  });

  it('says nothing for a workspace that does not exist', () => {
    // `loadAgents` tolerates a missing file, which here would print a one-entry
    // roster for a path that is not there — a list the supervisor could act on.
    expect(buildAgentRosterBlock(undefined)).toBe('');
    expect(buildAgentRosterBlock('Z:/definitely-not-a-workspace')).toBe('');
  });

  it('formats nothing from an empty roster', () => {
    expect(formatAgentRosterBlock([])).toBe('');
  });

  describe('dispatchHint', () => {
    it('routes on the hint, not on a behavioural first line', () => {
      // The failure this exists to prevent: a persona that opens with a manner
      // instruction and says nothing about scope. Routing on it is a coin flip.
      const root = workspace();
      writeRoster(root, [
        profile({
          id: 'agent-ui',
          name: '前端工',
          persona: '你是一位严谨的工程师。在任何情况下都先复述需求。',
          dispatchHint: '改界面、调样式。不接后端接口。',
        }),
      ]);
      const entry = readAgentRoster(root).find((e) => e.id === 'agent-ui');
      expect(entry?.gist).toBe('改界面、调样式。不接后端接口。');
    });

    it('falls back to the persona first line when the hint is absent', () => {
      // Rows written before the field existed must keep the old signal rather
      // than going silent — a blank gist cannot be routed on at all.
      const root = workspace();
      writeRoster(root, [
        profile({ id: 'agent-ui', name: '前端工', persona: '你负责界面实现。\n第二行不该出现。' }),
      ]);
      const entry = readAgentRoster(root).find((e) => e.id === 'agent-ui');
      expect(entry?.gist).toBe('你负责界面实现。');
    });

    it('caps an over-long hint so it cannot inflate every turn', () => {
      const root = workspace();
      writeRoster(root, [
        profile({ id: 'agent-wordy', name: '话痨', persona: 'x', dispatchHint: '啰'.repeat(400) }),
      ]);
      const entry = readAgentRoster(root).find((e) => e.id === 'agent-wordy');
      expect(entry?.gist?.length).toBe(120);
    });

    it('collapses newlines so a multi-line hint stays one roster entry', () => {
      const root = workspace();
      writeRoster(root, [
        profile({ id: 'agent-ml', name: '多行', persona: 'x', dispatchHint: '改界面。\n不接后端。' }),
      ]);
      const entry = readAgentRoster(root).find((e) => e.id === 'agent-ml');
      expect(entry?.gist).toBe('改界面。 不接后端。');
    });

    it('keeps the hint out of the snapshot bound for the system prompt', () => {
      // A persona is frozen into the session; the hint describes how to choose a
      // session and would be nonsense inside one.
      const file = emptyAgentsFile();
      const agent = profile({ id: 'agent-ui', name: '前端工', persona: 'P', dispatchHint: 'H' });
      const snapshot = buildAgentSnapshot(agent);
      expect(snapshot.persona).toBe('P');
      expect(Object.keys(snapshot)).not.toContain('dispatchHint');
      expect(file.defaults.persona).toBe('');
    });
  });
});
