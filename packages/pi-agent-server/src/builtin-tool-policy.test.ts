import { describe, expect, it } from 'bun:test';

import {
  FULL_BUILTIN_TOOLS,
  SUPERVISOR_BUILTIN_TOOLS,
  builtinToolNamesForRole,
  isBuiltinToolAllowed,
} from './builtin-tool-policy.ts';

describe('builtin tool policy', () => {
  it('never gives a supervisor a shell or a way to change files', () => {
    for (const forbidden of ['bash', 'edit', 'write']) {
      expect(isBuiltinToolAllowed('supervisor', forbidden)).toBe(false);
    }
  });

  it('still lets a supervisor inspect what it was asked about', () => {
    for (const allowed of ['read', 'grep', 'find', 'ls']) {
      expect(isBuiltinToolAllowed('supervisor', allowed)).toBe(true);
    }
  });

  it('leaves a worker session with the full coding toolset', () => {
    expect(builtinToolNamesForRole('worker')).toEqual(FULL_BUILTIN_TOOLS);
    expect(builtinToolNamesForRole(undefined)).toEqual(FULL_BUILTIN_TOOLS);
    for (const name of ['bash', 'edit', 'write', 'read']) {
      expect(isBuiltinToolAllowed('worker', name)).toBe(true);
    }
  });

  it('keeps the supervisor set a strict subset of the worker set', () => {
    for (const name of SUPERVISOR_BUILTIN_TOOLS) {
      expect(FULL_BUILTIN_TOOLS).toContain(name);
    }
    expect(SUPERVISOR_BUILTIN_TOOLS.length).toBeLessThan(FULL_BUILTIN_TOOLS.length);
  });
});
