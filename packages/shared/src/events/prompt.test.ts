import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildEventsBlock, formatEventsBlock, readEnabledListeners } from './prompt.ts'

let root: string

function writeListener(id: string, name: string, types: string[]): void {
  const dir = join(root, 'events', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ spec: 'craft-listener/1', id, name, version: '1.0.0', eventTypes: types }),
    'utf8',
  )
}

function setEnabled(ids: string[]): void {
  mkdirSync(join(root, 'events-data'), { recursive: true })
  const listeners = Object.fromEntries(ids.map((id) => [id, { enabled: true }]))
  writeFileSync(join(root, 'events-data', 'listeners.json'), JSON.stringify({ version: 1, listeners }), 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-events-prompt-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('event prompt block', () => {
  it('is empty when no listener is enabled', () => {
    writeListener('qqmail', 'QQ 邮箱', ['mail.received'])
    expect(buildEventsBlock(root)).toBe('')
    expect(buildEventsBlock(undefined)).toBe('')
  })

  it('lists only enabled listeners with their event types', () => {
    writeListener('qqmail', 'QQ 邮箱', ['mail.received'])
    writeListener('github', 'GitHub', ['github.push', 'github.issue'])
    setEnabled(['qqmail'])

    const block = buildEventsBlock(root)
    expect(block).toContain('QQ 邮箱')
    expect(block).toContain('mail.received')
    expect(block).toContain('subscribe_event')
    expect(block).not.toContain('GitHub')
  })

  it('survives a broken manifest without taking the prompt down', () => {
    const dir = join(root, 'events', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), '{ nope', 'utf8')
    setEnabled(['broken'])
    expect(buildEventsBlock(root)).toBe('')
  })

  it('reads entries independently of the formatter', () => {
    writeListener('a', 'A', ['x.y'])
    setEnabled(['a'])
    expect(readEnabledListeners(root)).toEqual([{ id: 'a', name: 'A', eventTypes: ['x.y'] }])
  })

  it('formats an explicit entry list', () => {
    expect(formatEventsBlock([])).toBe('')
    expect(formatEventsBlock([{ id: 'x', name: 'X', eventTypes: [] }])).toContain('(any)')
  })
})
