/**
 * One-shot branch-fork metadata.
 *
 * A branch keeps `branchFromMessageId` / `branchContextStrategy` for the whole
 * life of the session (UI provenance, seeded fallback), but the four
 * `branchFrom*` fork fields below exist only to materialize the branch's own
 * backend session ONCE. Keeping them on the session after that makes every
 * later subprocess spawn re-fork from the parent's LIVE context.
 *
 * 2026-10-18 (261016-true-sparrow → 261018-vital-moor): the Pi backend keys its
 * fork decision on `branchFromSessionPath`, but retirement only cleared
 * `branchFromSdkSessionId` / `branchFromSdkCwd` / `branchFromSdkTurnId`. Every
 * restart therefore re-copied the parent's current transcript into the branch,
 * so the branch answered a user message that had been sent in the parent after
 * the branch point.
 */
export interface BranchForkMetadataFields {
  branchFromSdkSessionId?: string;
  branchFromSdkCwd?: string;
  branchFromSdkTurnId?: string;
  branchFromSessionPath?: string;
}

/** True when the session still carries any fork-only field. */
export function hasBranchForkMetadata(fields: BranchForkMetadataFields): boolean {
  return Boolean(
    fields.branchFromSdkSessionId ||
    fields.branchFromSdkCwd ||
    fields.branchFromSdkTurnId ||
    fields.branchFromSessionPath
  );
}

/**
 * Drop every fork-only field. `branchFromMessageId` and
 * `branchContextStrategy` are deliberately kept.
 */
export function retireBranchForkMetadata(fields: BranchForkMetadataFields): void {
  fields.branchFromSdkSessionId = undefined;
  fields.branchFromSdkCwd = undefined;
  fields.branchFromSdkTurnId = undefined;
  fields.branchFromSessionPath = undefined;
}
