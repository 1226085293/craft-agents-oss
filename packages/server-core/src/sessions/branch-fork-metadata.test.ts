import { describe, expect, it } from 'bun:test';
import {
  hasBranchForkMetadata,
  retireBranchForkMetadata,
  type BranchForkMetadataFields,
} from './branch-fork-metadata';

describe('branch fork metadata retirement', () => {
  it('detects a branch that only carries branchFromSessionPath (2026-10-18 regression)', () => {
    // 261018-vital-moor persisted exactly this shape after the fork: the other
    // three fields were retired, branchFromSessionPath was not — so the Pi
    // backend kept re-forking the parent's live transcript on every restart.
    const fields: BranchForkMetadataFields = {
      branchFromSessionPath: 'C:\\Users\\me\\sessions\\261016-true-sparrow',
    };

    expect(hasBranchForkMetadata(fields)).toBe(true);
    retireBranchForkMetadata(fields);
    expect(fields.branchFromSessionPath).toBeUndefined();
    expect(hasBranchForkMetadata(fields)).toBe(false);
  });

  it('retires all four fork-only fields but keeps provenance fields', () => {
    const fields: BranchForkMetadataFields & {
      branchFromMessageId?: string;
      branchContextStrategy?: string;
    } = {
      branchFromSdkSessionId: 'sdk-parent',
      branchFromSdkCwd: 'C:\\work',
      branchFromSdkTurnId: 'entry-anchor',
      branchFromSessionPath: 'C:\\sessions\\parent',
      branchFromMessageId: 'msg-1',
      branchContextStrategy: 'sdk-fork',
    };

    retireBranchForkMetadata(fields);

    expect(fields.branchFromSdkSessionId).toBeUndefined();
    expect(fields.branchFromSdkCwd).toBeUndefined();
    expect(fields.branchFromSdkTurnId).toBeUndefined();
    expect(fields.branchFromSessionPath).toBeUndefined();
    // UI provenance + seeded-branch fallback still need these.
    expect(fields.branchFromMessageId).toBe('msg-1');
    expect(fields.branchContextStrategy).toBe('sdk-fork');
  });

  it('is a no-op for a non-branch session', () => {
    const fields: BranchForkMetadataFields = {};
    expect(hasBranchForkMetadata(fields)).toBe(false);
    retireBranchForkMetadata(fields);
    expect(hasBranchForkMetadata(fields)).toBe(false);
  });
});
