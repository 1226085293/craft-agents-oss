import { describe, expect, it } from 'bun:test';

import {
  FULL_BUILTIN_TOOLS,
  SUPERVISOR_BUILTIN_TOOLS,
  builtinToolNamesForRole,
  isBuiltinToolAllowed,
} from './builtin-tool-policy.ts';

describe('builtin tool policy', () => {
  it('gives a supervisor no built-in tools at all', () => {
    expect(SUPERVISOR_BUILTIN_TOOLS).toEqual([]);
    expect(builtinToolNamesForRole('supervisor')).toEqual([]);
  });

  it('denies a supervisor every tool its prompt says it lacks', () => {
    // These names are asserted absent so the prompt and the tool table cannot
    // drift apart again. On 2026-11-06 a supervisor that had read/grep/find/ls/
    // web_search/web_fetch caught the contradiction between its prompt ("no file
    // tools, no web access") and its tool table, stopped trusting the prompt,
    // and burned its whole turn investigating instead of dispatching.
    for (const forbidden of [
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'web_search',
      'web_fetch',
    ]) {
      expect(isBuiltinToolAllowed('supervisor', forbidden)).toBe(false);
    }
  });

  it('cannot widen a supervisor through task scope', () => {
    // Scope narrows, never widens: a task asking for `read` must not conjure it.
    const names = builtinToolNamesForRole('supervisor', {
      allow: ['read', 'bash', 'web_search'],
    });
    expect(names).toEqual([]);
  });

  it('leaves a worker session with the full coding toolset', () => {
    expect(builtinToolNamesForRole('worker')).toEqual(FULL_BUILTIN_TOOLS);
    expect(builtinToolNamesForRole(undefined)).toEqual(FULL_BUILTIN_TOOLS);
    for (const name of ['bash', 'edit', 'write', 'read', 'web_search', 'web_fetch']) {
      expect(isBuiltinToolAllowed('worker', name)).toBe(true);
    }
  });

  it('still honours a worker task scope that narrows the set', () => {
    const names = builtinToolNamesForRole('worker', { allow: ['read', 'bash'] });
    expect(names).toEqual(['read', 'bash']);
    expect(builtinToolNamesForRole('worker', { deny: ['bash'] })).not.toContain('bash');
  });

  it('keeps web tools inside the role-filtered list', () => {
    // They were once concatenated unconditionally at assembly time, which is how
    // a supervisor ended up with web access its prompt denied.
    expect(FULL_BUILTIN_TOOLS).toContain('web_search');
    expect(FULL_BUILTIN_TOOLS).toContain('web_fetch');
    expect(SUPERVISOR_BUILTIN_TOOLS).not.toContain('web_search');
    expect(SUPERVISOR_BUILTIN_TOOLS).not.toContain('web_fetch');
  });

  it('keeps the supervisor set a strict subset of the worker set', () => {
    for (const name of SUPERVISOR_BUILTIN_TOOLS) {
      expect(FULL_BUILTIN_TOOLS).toContain(name);
    }
    expect(SUPERVISOR_BUILTIN_TOOLS.length).toBeLessThan(FULL_BUILTIN_TOOLS.length);
  });
});
