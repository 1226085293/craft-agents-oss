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

function contextWithMiniCompletion(workspacePath: string, sessionId: string, respond: (prompt: string) => string | null): SessionToolContext {
  return {
    workspacePath, sessionId, plansFolderPath: workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources') },
    get skillsPath() { return join(workspacePath, 'skills') },
    callbacks: {
      onPlanSubmitted() {}, onAuthRequest() {},
      runMiniCompletion: (prompt: string) => Promise.resolve(respond(prompt)),
    },
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

  it('expands the query semantically when surface keywords miss', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'craft-memory-tool-'))
    dirs.push(workspace)
    const ctx = context(workspace, 'session-a')
    await handleAddMemory(ctx, { action: 'add', scope: 'global', content: '用户要求以后称呼 agent 为「小二」', type: 'behavioral', tags: [] })

    // Surface query shares zero tokens with the entry; the mini completion
    // returns the semantic bridge that hits it.
    const expandedCtx = contextWithMiniCompletion(workspace, 'session-a', () =>
      JSON.stringify(['名字', '称呼', 'nickname']),
    )
    const result = await handleQueryMemories(expandedCtx, { query: '你叫什么名字' })
    expect(result.content[0]?.text).toContain('小二')
  })

  it('falls back gracefully when no mini completion is available', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'craft-memory-tool-'))
    dirs.push(workspace)
    const ctx = context(workspace, 'session-a')
    await handleAddMemory(ctx, { action: 'add', scope: 'global', content: '关键词鸿沟条目', type: 'factual', tags: [] })

    const result = await handleQueryMemories(ctx, { query: '完全无重叠的查询词' })
    expect(result.isError).not.toBe(true)
    expect(result.content[0]?.text).toBe('No relevant memories found.')
  })

  it('falls back when the mini completion returns malformed JSON', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'craft-memory-tool-'))
    dirs.push(workspace)
    const ctx = context(workspace, 'session-a')
    await handleAddMemory(ctx, { action: 'add', scope: 'global', content: 'some stored fact', type: 'factual', tags: [] })

    const brokenCtx = contextWithMiniCompletion(workspace, 'session-a', () => 'not json at all')
    const result = await handleQueryMemories(brokenCtx, { query: 'unrelated words' })
    expect(result.isError).not.toBe(true)
  })

  it('rejects near-duplicate additions and steers to update by id', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'craft-memory-tool-'))
    dirs.push(workspace)
    const ctx = context(workspace, 'session-a')
    const first = await handleAddMemory(ctx, { action: 'add', scope: 'global', content: '用户要求以后称呼 agent 为「小二」。', type: 'behavioral', tags: [] })
    const firstId = (first.content[0]?.text ?? '').match(/Added global memory ([0-9a-f-]+)\./)?.[1] ?? ''
    expect(firstId).not.toBe('')

    // Same phrasing, only the name token differs — surface similarity (0.789)
    // falls below the fast-path threshold, so the LLM tier must flag it.
    const llmCtx = contextWithMiniCompletion(workspace, 'session-a', () => firstId)
    const dupResult = await handleAddMemory(llmCtx, { action: 'add', scope: 'global', content: '用户要求以后称呼 agent 为「小三」。', type: 'behavioral', tags: [] })
    const text = dupResult.content[0]?.text ?? ''
    expect(text).toContain('Similar memory already exists')
    expect(text).toContain('action="update"')

    // Store must still have exactly ONE entry (nothing added).
    const global = JSON.parse(readFileSync(join(workspace, 'memory.json'), 'utf8')) as { entries: Array<{ id: string }> }
    expect(global.entries).toHaveLength(1)
  })

  it('adds when the LLM deems the new memory genuinely new', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'craft-memory-tool-'))
    dirs.push(workspace)
    const ctx = context(workspace, 'session-a')
    await handleAddMemory(ctx, { action: 'add', scope: 'global', content: '用户要求以后称呼 agent 为「小二」。', type: 'behavioral', tags: [] })

    const llmCtx = contextWithMiniCompletion(workspace, 'session-a', () => 'NONE')
    const result = await handleAddMemory(llmCtx, { action: 'add', scope: 'global', content: '构建命令是 bun build', type: 'factual', tags: [] })
    expect(result.content[0]?.text).toContain('Added global memory')
    const global = JSON.parse(readFileSync(join(workspace, 'memory.json'), 'utf8')) as { entries: Array<{ id: string }> }
    expect(global.entries).toHaveLength(2)
  })

  it('recovers the true entry id when the LLM returns a prefix token', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'craft-memory-tool-'))
    dirs.push(workspace)
    const ctx = context(workspace, 'session-a')
    const first = await handleAddMemory(ctx, { action: 'add', scope: 'global', content: '用户要求以后称呼 agent 为「小二」。', type: 'behavioral', tags: [] })
    const firstText = first.content[0]?.text ?? ''
    const firstId = firstText.match(/Added global memory ([0-9a-f-]+)\./)?.[1] ?? ''
    expect(firstId).not.toBe('')

    const llmCtx = contextWithMiniCompletion(workspace, 'session-a', () => firstId.slice(0, 20))
    const dupResult = await handleAddMemory(llmCtx, { action: 'add', scope: 'global', content: '用户希望助手以后被称为「小三」。', type: 'behavioral', tags: [] })
    expect(dupResult.content[0]?.text).toMatch(/already exists/)
    expect(dupResult.content[0]?.text).toContain(firstId)
    const global = JSON.parse(readFileSync(join(workspace, 'memory.json'), 'utf8')) as { entries: Array<{ id: string }> }
    expect(global.entries).toHaveLength(1)
  })

  it('allows genuinely different additions', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'craft-memory-tool-'))
    dirs.push(workspace)
    const ctx = context(workspace, 'session-a')
    await handleAddMemory(ctx, { action: 'add', scope: 'global', content: '用户偏好 Simplified Chinese', type: 'behavioral', tags: [] })
    await handleAddMemory(ctx, { action: 'add', scope: 'global', content: '构建命令是 bun build', type: 'factual', tags: [] })

    const global = JSON.parse(readFileSync(join(workspace, 'memory.json'), 'utf8')) as { entries: Array<{ id: string }> }
    expect(global.entries).toHaveLength(2)
  })
})
