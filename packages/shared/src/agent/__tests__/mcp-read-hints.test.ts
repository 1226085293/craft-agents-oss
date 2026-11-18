/**
 * Hole-2 (v7): three-layer MCP tool read classification —
 *   layer 1: the tool's own annotations.readOnlyHint (tool author's word),
 *   layer 2: the source's manual read-only switch (configurer's word),
 *   layer 3: no declaration = conservative write.
 *
 * This file pins the CONSUMPTION points the rule used to lack: the
 * safe-mode gate (shouldAllowToolInMode), the ask-mode prompt skip
 * (shouldPromptInAskMode → evaluateMcpToolPolicy), and the freestanding
 * policy module used by non-hook callers (the Pages action bridge).
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { evaluateMcpToolPolicy } from '../source-policy.ts';
import { shouldPromptInAskMode, type SourcePolicyConfigSummary } from '../core/pre-tool-use.ts';

// A tool name deliberately outside any read-only name pattern, so the
// pattern oracle (the pre-existing safe-mode mechanism) cannot rescue it.
const TOOL = 'mcp__crm__doSomethingXyz';

const fakePermissionManager = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: (c: string) => c,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

describe('hole-2: safe-mode gate consumes the three layers', () => {
  it('layer 1: the tool\'s own readOnlyHint lets a pattern-unmatched tool through', () => {
    const result = shouldAllowToolInMode(TOOL, {}, 'safe', {
      mcpToolAnnotations: { [TOOL]: { readOnlyHint: true } },
    });
    expect(result.allowed).toBe(true);
  });

  it('layer 2: the source read-only switch lets the tool through', () => {
    const result = shouldAllowToolInMode(TOOL, {}, 'safe', {
      sourceReadOnlySlugs: { crm: true },
    });
    expect(result.allowed).toBe(true);
  });

  it('a false readOnlyHint never upgrades to read — layer 2 still decides', () => {
    const denied = shouldAllowToolInMode(TOOL, {}, 'safe', {
      mcpToolAnnotations: { [TOOL]: { readOnlyHint: false } },
    });
    expect(denied.allowed).toBe(false);

    const allowed = shouldAllowToolInMode(TOOL, {}, 'safe', {
      mcpToolAnnotations: { [TOOL]: { readOnlyHint: false } },
      sourceReadOnlySlugs: { crm: true },
    });
    expect(allowed.allowed).toBe(true);
  });

  it('no declaration: conservative write — blocked in safe mode (pre-existing behavior kept)', () => {
    const result = shouldAllowToolInMode(TOOL, {}, 'safe');
    expect(result.allowed).toBe(false);
  });

  it('another source\'s switch does not leak onto this tool\'s source', () => {
    const result = shouldAllowToolInMode(TOOL, {}, 'safe', {
      sourceReadOnlySlugs: { github: true },
    });
    expect(result.allowed).toBe(false);
  });
});

describe('hole-2: evaluateMcpToolPolicy settles declared reads before the oracle', () => {
  it('readOnlyHint=true → allow/read-only even when the oracle would block', () => {
    const decision = evaluateMcpToolPolicy(TOOL, {}, {
      mcpToolAnnotations: { [TOOL]: { readOnlyHint: true } },
    });
    expect(decision).toEqual({ decision: 'allow', reason: 'read-only' });
  });

  it('sourceReadOnly=true → allow/read-only', () => {
    const decision = evaluateMcpToolPolicy(TOOL, {}, { sourceReadOnly: true });
    expect(decision).toEqual({ decision: 'allow', reason: 'read-only' });
  });

  it('no declaration → the conservative write path (oracle: requires-approval)', () => {
    const decision = evaluateMcpToolPolicy(TOOL, {});
    expect(decision.decision).toBe('requires-approval');
  });
});

describe('hole-2: ask mode skips the confirmation for declared-read MCP tools', () => {
  const permissionsContext = { workspaceRootPath: '/tmp', activeSourceSlugs: ['crm'] };

  it('readOnlyHint=true → no prompt', () => {
    const prompt = shouldPromptInAskMode(
      TOOL,
      {},
      fakePermissionManager,
      permissionsContext,
      '/tmp/plans',
      undefined,
      { mcpToolAnnotations: { [TOOL]: { readOnlyHint: true } } },
    );
    expect(prompt).toBeNull();
  });

  it('the source read-only switch (via sourceConfigs) → no prompt', () => {
    const prompt = shouldPromptInAskMode(
      TOOL,
      {},
      fakePermissionManager,
      permissionsContext,
      '/tmp/plans',
      undefined,
      { sourceConfigs: { crm: { readOnly: true } as unknown as SourcePolicyConfigSummary } },
    );
    expect(prompt).toBeNull();
  });

  it('no declaration → the mcp_mutation prompt still fires (conservative write)', () => {
    const prompt = shouldPromptInAskMode(
      TOOL,
      {},
      fakePermissionManager,
      permissionsContext,
      '/tmp/plans',
    );
    expect(prompt?.promptType).toBe('mcp_mutation');
  });
});
