import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSessionMemory, getSessionMemoryStorePath, loadSessionMemoryStore, saveSessionMemoryStore } from '../session-store'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root() { const value = mkdtempSync(join(tmpdir(), 'craft-session-memory-')); roots.push(value); return value }

describe('session memory store', () => {
  it('persists entries under their own session directory', () => {
    const workspace = root()
    const a = loadSessionMemoryStore(workspace, 'session-a')
    const b = loadSessionMemoryStore(workspace, 'session-b')
    addSessionMemory(a, '当前会话部署端口是 8080', 'factual')
    saveSessionMemoryStore(workspace, a)

    expect(getSessionMemoryStorePath(workspace, 'session-a')).toContain(join('sessions', 'session-a', 'memory.json'))
    expect(loadSessionMemoryStore(workspace, 'session-a').entries).toHaveLength(1)
    expect(loadSessionMemoryStore(workspace, 'session-b').entries).toHaveLength(0)
  })

  it('rejects traversal session IDs', () => {
    expect(() => getSessionMemoryStorePath(root(), '..\\other')).toThrow('Invalid session ID')
  })
})
