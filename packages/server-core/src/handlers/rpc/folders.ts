import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  archiveFolder as archiveFolderConfig,
  createFolder,
  loadFolderConfig,
  moveFolder,
  moveFolderToScope,
  pinFolder,
  renameFolder,
  reorderFolder,
  unarchiveFolder as unarchiveFolderConfig,
  type FolderScope,
} from '@craft-agent/shared/sessions'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.folders.LIST,
  RPC_CHANNELS.folders.CREATE,
  RPC_CHANNELS.folders.RENAME,
  RPC_CHANNELS.folders.MOVE,
  RPC_CHANNELS.folders.MOVE_TO_SCOPE,
  RPC_CHANNELS.folders.ARCHIVE,
  RPC_CHANNELS.folders.UNARCHIVE,
  RPC_CHANNELS.folders.REORDER,
  RPC_CHANNELS.folders.PIN,
  RPC_CHANNELS.folders.DELETE,
] as const

function requireWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
  return workspace
}

export function registerFoldersHandlers(server: RpcServer, deps: HandlerDeps): void {
  /** Every mutation re-broadcasts the tree so other windows converge (D16). */
  const broadcast = (workspaceId: string, scope: FolderScope) => {
    pushTyped(server, RPC_CHANNELS.folders.CHANGED, { to: 'workspace', workspaceId }, workspaceId, scope)
  }

  server.handle(RPC_CHANNELS.folders.LIST, async (_ctx, workspaceId: string, scope: FolderScope) => {
    const workspace = requireWorkspace(workspaceId)
    return loadFolderConfig(workspace.rootPath, scope).folders
  })

  server.handle(RPC_CHANNELS.folders.CREATE, async (
    _ctx,
    workspaceId: string,
    scope: FolderScope,
    input: { name: string; parentId?: string | null },
  ) => {
    const workspace = requireWorkspace(workspaceId)
    const folder = createFolder(workspace.rootPath, scope, input)
    broadcast(workspaceId, scope)

    // Automations: a new folder is a folder path change with an empty oldPath.
    deps.sessionManager.emitPathChange(workspace.rootPath, {
      subject: 'folder',
      changeType: 'folder',
      oldPath: null,
      newPath: `folder:${folder.id}`,
    })

    return folder
  })

  server.handle(RPC_CHANNELS.folders.RENAME, async (
    _ctx,
    workspaceId: string,
    scope: FolderScope,
    input: { id: string; name: string },
  ) => {
    const workspace = requireWorkspace(workspaceId)
    const folder = renameFolder(workspace.rootPath, scope, input.id, input.name)
    broadcast(workspaceId, scope)
    return folder
  })

  server.handle(RPC_CHANNELS.folders.MOVE, async (
    _ctx,
    workspaceId: string,
    scope: FolderScope,
    input: { id: string; parentId: string | null; name?: string },
  ) => {
    const workspace = requireWorkspace(workspaceId)
    const result = moveFolder(workspace.rootPath, scope, input.id, input.parentId, input.name)
    if (!result.ok) throw new Error(`Cannot move folder: ${result.reason}`)
    broadcast(workspaceId, scope)

    // Automations: moving a folder reparents the whole subtree.
    deps.sessionManager.emitPathChange(workspace.rootPath, {
      subject: 'folder',
      changeType: 'folder',
      oldPath: `folder:${input.id}`,
      newPath: input.parentId ? `folder:${input.id}/parent:${input.parentId}` : `folder:${input.id}`,
    })

    return result.folder
  })

  server.handle(RPC_CHANNELS.folders.MOVE_TO_SCOPE, async (
    _ctx,
    workspaceId: string,
    fromScope: FolderScope,
    input: { id: string; parentId?: string | null; name?: string },
    toScope: FolderScope,
  ) => {
    const workspace = requireWorkspace(workspaceId)
    const result = moveFolderToScope(workspace.rootPath, fromScope, input.id, toScope, input.parentId ?? null, input.name)
    if (!result.ok) throw new Error(`Cannot move folder to scope: ${result.reason}`)
    broadcast(workspaceId, fromScope)
    broadcast(workspaceId, toScope)

    // Sessions living in the moved subtree change 归属 with their folder: they
    // become part of the target scope (project sessions when the target is a
    // project, root sessions when it is "All Sessions").
    await deps.sessionManager.rebindSessionsToFolders(
      workspaceId,
      fromScope,
      toScope,
      result.folderIdMap ?? { [input.id]: result.folder.id },
    )

    // Automations: a cross-scope move reparents the subtree into a new scope.
    deps.sessionManager.emitPathChange(workspace.rootPath, {
      subject: 'folder',
      changeType: 'folder',
      oldPath: `folder:${input.id}`,
      newPath: toScope.projectId ? `folder:${input.id}/project:${toScope.projectId}` : `folder:${input.id}`,
    })

    return result.folder
  })

  server.handle(RPC_CHANNELS.folders.ARCHIVE, async (
    _ctx,
    workspaceId: string,
    scope: FolderScope,
    input: { id: string },
  ) => {
    const workspace = requireWorkspace(workspaceId)
    // Folder config first (structure), then sessions (state) so a partial failure
    // leaves sessions visible inside an archived container rather than orphaned.
    const configResult = archiveFolderConfig(workspace.rootPath, scope, input.id)
    const sessionResult = await deps.sessionManager.archiveFolder(workspaceId, scope, input.id)
    broadcast(workspaceId, scope)
    return { ...configResult, ...sessionResult }
  })

  server.handle(RPC_CHANNELS.folders.UNARCHIVE, async (
    _ctx,
    workspaceId: string,
    scope: FolderScope,
    input: { id: string },
  ) => {
    const workspace = requireWorkspace(workspaceId)
    const configResult = unarchiveFolderConfig(workspace.rootPath, scope, input.id)
    const sessionResult = await deps.sessionManager.unarchiveFolder(workspaceId, scope, input.id)
    broadcast(workspaceId, scope)
    return { ...configResult, ...sessionResult }
  })

  server.handle(RPC_CHANNELS.folders.REORDER, async (
    _ctx,
    workspaceId: string,
    scope: FolderScope,
    input: { id: string; sortOrder: string },
  ) => {
    const workspace = requireWorkspace(workspaceId)
    const folder = reorderFolder(workspace.rootPath, scope, input.id, input.sortOrder)
    broadcast(workspaceId, scope)
    return folder
  })

  server.handle(RPC_CHANNELS.folders.PIN, async (
    _ctx,
    workspaceId: string,
    scope: FolderScope,
    input: { id: string; pinned: boolean },
  ) => {
    const workspace = requireWorkspace(workspaceId)
    const folder = pinFolder(workspace.rootPath, scope, input.id, input.pinned)
    broadcast(workspaceId, scope)
    return folder
  })

  // D2: hard delete — the session manager removes sessions first, then the folder
  // subtree, and reports archived sessions separately so the UI can disclose them.
  server.handle(RPC_CHANNELS.folders.DELETE, async (
    _ctx,
    workspaceId: string,
    scope: FolderScope,
    input: { id: string },
  ) => {
    const result = await deps.sessionManager.deleteFolder(workspaceId, scope, input.id)
    broadcast(workspaceId, scope)
    return result
  })
}
