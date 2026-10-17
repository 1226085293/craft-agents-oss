import { describe, expect, it } from 'bun:test';
import { SESSION_PERSISTENT_FIELDS } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: previousPermissionMode', () => {
  it('includes previousPermissionMode in SESSION_PERSISTENT_FIELDS', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('previousPermissionMode');
  });

  it('pickSessionFields preserves previousPermissionMode when present', () => {
    const source = {
      id: 's1',
      workspaceRootPath: '/tmp/ws',
      permissionMode: 'allow-all',
      previousPermissionMode: 'safe',
      createdAt: 1,
      lastUsedAt: 2,
      ignoredRuntimeField: 'nope',
    } as const;

    const picked = pickSessionFields(source);
    expect(picked.permissionMode).toBe('allow-all');
    expect(picked.previousPermissionMode).toBe('safe');
    expect((picked as Record<string, unknown>).ignoredRuntimeField).toBeUndefined();
  });
});

describe('session persistence: branch metadata', () => {
  it("persists branchContextStrategy so a reload does not lose the fork strategy", () => {
    // Regression (2026-10-17 jade-stone): the field existed on ManagedSession
    // and was computed at creation, but was missing from this whitelist - so it
    // never reached session.jsonl. After a reload the loader could only guess from
    // branchFromSdkSessionId, and an older branch (no SDK id persisted) was
    // misclassified as seeded-fresh-session, which SKIPS the branch preflight.
    expect(SESSION_PERSISTENT_FIELDS).toContain('branchContextStrategy');
  });

  it("keeps every branch* field the loader reads in the whitelist", () => {
    const fields: string[] = [...SESSION_PERSISTENT_FIELDS];
    for (const field of [
      'branchFromMessageId',
      'branchFromSdkSessionId',
      'branchFromSessionPath',
      'branchFromSdkCwd',
      'branchFromSdkTurnId',
      'branchContextStrategy',
    ]) {
      expect(fields).toContain(field);
    }
  });
});
