import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionToolContext } from '../context.ts'
import { handleAddMemory, handleQueryMemories } from './memory.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function context(workspacePath: string, sessionId: string): SessionToolContext {
  return {
    workspacePath, sessionId, plansFolderPath: workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources') },
    get skillsPath() { return join(workspacePath, 'skills') },
    callbacks: { onPlanSubmitted() {}, onAuthRequest() {} },
    fs: {
      exists: (path: string) => { try { readFileSync(path); return true } catch { return false } },
      readFile: (path: string) => readFileSync(path, 'utf8'), readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => { require('node:fs').writeFileSync(path, content) },
      isDirectory: () => false, readdir: () => [], stat: () => ({ size: 0, isDirectory: () => false }),
    },
    loadSourceConfig: () => null,
  } as unknown as SessionToolContext
}

describe('memory tool scope isolation', () => {
  it('adds session data only to the invoking session and global deletes are recoverable', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'craft-memory-tool-'))
    dirs.push(workspace)
    const ctx = context(workspace, 'session-a')
    await handleAddMemory(ctx, { action: 'add', scope: 'session', content: 'Current task host uses 8080', tags: [] })
    await handleAddMemory(ctx, { action: 'add', scope: 'global', content: 'User prefers Simplified Chinese', type: 'preference', tags: ['language'] })

    const foreign = context(workspace, 'session-b')
    const result = await handleQueryMemories(foreign, { query: 'Current task host 8080' })
    expect(result.content[0]?.text).not.toContain('8080')

    const globalPath = join(workspace, 'memory.json')
    const global = JSON.parse(readFileSync(globalPath, 'utf8')) as { entries: Array<{ id: string }>; trash: Array<{ entry: { id: string } }> }
    await handleAddMemory(ctx, { action: 'delete', scope: 'global', id: global.entries[0]!.id })
    const updated = JSON.parse(readFileSync(globalPath, 'utf8')) as typeof global
    expect(updated.entries).toHaveLength(0)
    expect(updated.trash[0]?.entry.id).toBe(global.entries[0]?.id)
  })

  it('rejects session identifiers that escape the session directory', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'craft-memory-tool-'))
    dirs.push(workspace)
    const result = await handleAddMemory(context(workspace, '../other'), { action: 'add', scope: 'session', content: 'leak', tags: [] })
    expect(result.isError).toBe(true)
  })
})
