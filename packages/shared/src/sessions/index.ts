/**
 * Sessions Module
 *
 * Public exports for workspace-scoped session management.
 *
 * Sessions are stored in JSONL format:
 * - Line 1: SessionHeader (metadata for fast list loading)
 * - Lines 2+: StoredMessage (one message per line)
 */

// Types
export type {
  SessionTokenUsage,
  StoredMessage,
  SessionConfig,
  StoredSession,
  SessionMetadata,
  SessionHeader,
  SessionPersistentField,
} from './types.ts';

// Field constants
export { SESSION_PERSISTENT_FIELDS } from './types.ts';

// Storage functions
export {
  // Directory utilities
  ensureSessionsDir,
  ensureSessionDir,
  getSessionPath,
  getSessionFilePath,
  getSessionAttachmentsPath,
  getSessionPlansPath,
  ensureAttachmentsDir,
  // ID generation
  generateSessionId,
  // Session CRUD
  createSession,
  getOrCreateSessionById,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  clearSessionMessages,
  getOrCreateLatestSession,
  // Metadata updates
  updateSessionSdkId,
  updateSessionMetadata,
  canUpdateSdkCwd,
  setSessionProjectId,
  unbindProjectFromSessions,
  // Pending plan execution (Accept & Compact flow)
  setPendingPlanExecution,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  clearPendingPlanExecution,
  getPendingPlanExecution,
  // Session filtering
  // Archive management
  archiveSession,
  unarchiveSession,
  listArchivedSessions,
  listActiveSessions,
  deleteOldArchivedSessions,
  // Plan storage
  formatPlanAsMarkdown,
  parsePlanFromMarkdown,
  savePlanToFile,
  loadPlanFromFile,
  loadPlanFromPath,
  listPlanFiles,
  deletePlanFile,
  getMostRecentPlanFile,
  // Async persistence queue
  sessionPersistenceQueue,
  // Header metadata signature (for self-triggered event suppression)
  getHeaderMetadataSignature,
} from './storage.ts';

// JSONL helpers (for direct access if needed)
export {
  readSessionHeader,
  readSessionJsonl,
  writeSessionJsonl,
  createSessionHeader,
  expandSessionPath,
  expandSessionPathInMemory,
} from './jsonl.ts';

// Field utilities
export { pickSessionFields } from './utils.ts';

// Session-level slash commands (`/stop`) shared by desktop RPC, the messaging
// gateway and the send_agent_message tool.
export type { SessionCommand, SessionCommandName, SessionCommandResult } from './session-commands.ts';
export {
  SESSION_COMMAND_NAMES,
  parseSessionCommand,
  isSessionCommand,
} from './session-commands.ts';

// Branch asset inheritance (attachments / downloads / plans / long_responses)
export {
  copySessionAssetsForBranch,
  BRANCH_ASSET_DIRS,
  BRANCH_ASSET_FILES,
  type BranchAssetsCopyResult,
} from './branch-assets.ts';

// Slug generator utilities
export {
  generateDatePrefix,
  generateHumanSlug,
  generateUniqueSessionId,
  parseSessionId,
  isHumanReadableId,
} from './slug-generator.ts';

// Word lists (for customization if needed)
export { ADJECTIVES, NOUNS } from './word-lists.ts';

// Session ID validation (security)
export {
  validateSessionId,
  sanitizeSessionId,
} from './validation.ts';

// Inline attachment tokens (`[attachment:name]`) — single source of truth for
// the token grammar, shared by the renderer (writes tokens) and the server
// (rewrites tokens to stored filenames at send time).
export {
  ATTACHMENT_TOKEN_PREFIX,
  MAX_ATTACHMENT_TOKEN_KEY_LENGTH,
  attachmentTokenKey,
  formatAttachmentToken,
  findAttachmentTokens,
  rewriteAttachmentNameTokens,
} from './attachment-token.ts';
export type { AttachmentTokenMatch } from './attachment-token.ts';

// Session bundle (export/import/dispatch)
export type {
  SessionBundle,
  BundleFile,
  BundleBranchInfo,
  DispatchMode,
} from './bundle.ts';
export {
  serializeSession,
  validateBundle,
  MAX_BUNDLE_SIZE_BYTES,
} from './bundle.ts';

// Session folders (D13 scope / D22 archive / D32 ordering)
export type {
  FolderConfig,
  WorkspaceFolderConfig,
  FolderScope,
  CreateFolderInput,
  ArchiveFolderResult,
  UnarchiveFolderResult,
  MoveFolderResult,
} from './folders.ts';
export {
  emptyFolderConfig,
  getFolderConfigPath,
  loadFolderConfig,
  saveFolderConfig,
  createFolder,
  renameFolder,
  moveFolder,
  moveFolderToScope,
  pinFolder,
  reorderFolder,
  folderSortOrderBetween,
  archiveFolder,
  unarchiveFolder,
  deleteFolderConfig,
  getFolderIdSet,
} from './folders.ts';
export {
  MAX_FOLDER_DEPTH,
  getFolderById,
  getFolderAncestors,
  getDescendantFolderIds,
  isFolderAncestor,
  getFolderDepth,
  getFolderPath,
  resolveDeepestExistingAncestor,
  isFolderArchived,
  validateFolderMove,
  subtreeHeight,
  compareSiblings,
  midpointSortOrder,
  appendSortOrder,
  computeReorderSortOrder,
  buildOrderedChildren,
  buildFolderTree,
  buildArchiveTree,
  canDrop,
  collectArchiveSubtree,
  collectUnarchiveSubtree,
} from './folder-tree.ts';
export type {
  FolderMoveRejection,
  FolderMoveValidation,
  SiblingKind,
  SortableSibling,
  DragItem,
  DropTarget,
  DropAction,
  DropDecision,
  FolderTreeNode,
  ArchiveSessionLike,
  ArchiveProjectLike,
  ArchiveTreeNode,
  ArchiveTreeResult,
} from './folder-tree.ts';

