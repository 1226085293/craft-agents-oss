/**
 * Contract tests for the field-list single source of truth.
 *
 * The bug these guard against (three times over): a field existed in the type,
 * was written by the save path, and was silently stripped by the read
 * whitelist — after which the editor's autosave wrote the stripped value back.
 * The last instance cost `assignable` and `memoryDomain` on a live workspace.
 *
 * So: every field in `AgentProfile` must survive a save → load round-trip, and
 * the field list must come from `schema.ts` rather than being re-listed by hand.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_DISPATCH_HINT_CHARS, type AgentProfile } from '../types.ts';
import { getAgentsFilePath, loadAgents, saveAgents } from '../storage.ts';
import {
  AgentDefaultsBlockSchema,
  AgentProfileSchema,
  normalizeAgentDefaultsBlock,
  normalizeAgentProfile,
} from '../schema.ts';

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-agents-schema-'));
  return dir;
}

const FULL_PROFILE: AgentProfile = {
  id: 'agt_full',
  name: '全字段',
  icon: '🧩',
  color: 'blue',
  persona: '你是全字段测试',
  dispatchHint: '接前端与设计系统',
  assignable: true,
  memoryDomain: 'agent-full',
  defaults: { strategy: 'frontend', model: 'claude-x', permissionMode: 'ask', thinkingLevel: 'high' },
  sources: { mode: 'allowlist', slugs: ['a', 'b'] },
  skills: { mode: 'allowlist', slugs: ['s1'] },
  builtin: false,
  createdAt: 100,
  updatedAt: 200,
  deletedAt: null,
};

describe('agent profile schema is the field-list source of truth', () => {
  it('declares every storable field of AgentProfile', () => {
    const declared = Object.keys(AgentProfileSchema.shape).sort();
    // If this fails, a field was added to AgentProfile without adding it to the
    // schema — which is exactly how the whitelist bugs happened.
    const expected = [
      'assignable',
      'builtin',
      'color',
      'createdAt',
      'defaults',
      'deletedAt',
      'dispatchHint',
      'icon',
      'id',
      'memoryDomain',
      'name',
      'persona',
      'skills',
      'sources',
      'updatedAt',
    ].sort();
    expect(declared).toEqual(expected);
  });

  it('drops identity and lifecycle from the defaults block schema', () => {
    const block = Object.keys(AgentDefaultsBlockSchema.shape);
    for (const excluded of ['id', 'name', 'builtin', 'createdAt', 'updatedAt', 'deletedAt']) {
      expect(block).not.toContain(excluded);
    }
    // …but keeps every editable field, the gate fields included.
    for (const kept of ['persona', 'dispatchHint', 'defaults', 'sources', 'skills', 'assignable', 'memoryDomain']) {
      expect(block).toContain(kept);
    }
  });

  it('round-trips every field through save → load', () => {
    const ws = workspace();
    try {
      saveAgents(ws, {
        version: 1,
        defaultAgentId: 'builtin-default',
        defaults: {
          persona: '',
          defaults: { strategy: null, model: null, permissionMode: null, thinkingLevel: null },
          sources: { mode: 'all', slugs: [] },
          skills: { mode: 'all', slugs: [] },
        },
        agents: [FULL_PROFILE],
      });
      const loaded = loadAgents(ws).agents[0]!;
      expect(loaded).toEqual(FULL_PROFILE);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('keeps the gate fields on the defaults block too', () => {
    const block = normalizeAgentDefaultsBlock({
      persona: '默认',
      assignable: true,
      memoryDomain: 'agent-ui',
      sources: { mode: 'allowlist', slugs: ['x'] },
    });
    expect(block.assignable).toBe(true);
    expect(block.memoryDomain).toBe('agent-ui');
    expect(block.sources).toEqual({ mode: 'allowlist', slugs: ['x'] });
  });

  it('treats an empty memoryDomain as unset instead of persisting an empty string', () => {
    const profile = normalizeAgentProfile({ id: 'a1', memoryDomain: '   ', assignable: false }, 1);
    expect(profile?.memoryDomain).toBeUndefined();
    expect(profile?.assignable).toBe(false);
  });

  it('caps dispatchHint on read (the same cap the write path applies)', () => {
    const long = 'x'.repeat(MAX_DISPATCH_HINT_CHARS + 50);
    const profile = normalizeAgentProfile({ id: 'a1', dispatchHint: `  ${long}  ` }, 1);
    expect(profile?.dispatchHint?.length).toBe(MAX_DISPATCH_HINT_CHARS);
  });

  it('still keeps a row whose enum-ish fields are junk', () => {
    const profile = normalizeAgentProfile(
      {
        id: 'a1',
        defaults: { permissionMode: 'god-mode' },
        sources: { mode: 'weird', slugs: ['x', 'x', ''] },
      },
      1,
    );
    expect(profile).not.toBeNull();
    expect(profile?.defaults.permissionMode).toBeNull();
    expect(profile?.sources).toEqual({ mode: 'all', slugs: ['x'] });
  });

  it('refuses rows without an id and the reserved default id', () => {
    expect(normalizeAgentProfile({ name: 'no id' }, 1)).toBeNull();
    expect(normalizeAgentProfile({ id: 'builtin-default' }, 1)).toBeNull();
  });

  it('writes through the real file path used by the loader', () => {
    const ws = workspace();
    try {
      saveAgents(ws, {
        version: 1,
        defaultAgentId: 'builtin-default',
        defaults: {
          persona: '',
          defaults: { strategy: null, model: null, permissionMode: null, thinkingLevel: null },
          sources: { mode: 'all', slugs: [] },
          skills: { mode: 'all', slugs: [] },
        },
        agents: [],
      });
      expect(getAgentsFilePath(ws).endsWith('agents.json')).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
