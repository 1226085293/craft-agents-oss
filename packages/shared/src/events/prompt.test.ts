import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildEventsBlock, formatEventsBlock, readEnabledListeners } from './prompt.ts'

let root: string

function writeListener(id: string, name: string, types: string[], description?: string): void {
  const dir = join(root, 'events', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      spec: 'craft-listener/1',
      id,
      name,
      version: '1.0.0',
      eventTypes: types,
      ...(description ? { description } : {}),
    }),
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

  it('leads each line with the id and avoids repeating it in the blurb', () => {
    writeListener('qqmail-idle', 'QQ 邮箱', ['mail.received'], '监听 QQ 邮箱新邮件')
    setEnabled(['qqmail-idle'])

    const line = formatEventsBlock(readEnabledListeners(root))
      .split('\n')
      .find((row) => row.startsWith('- '))
    expect(line).toBe('- `qqmail-idle`（监听 QQ 邮箱新邮件）→ mail.received')
  })

  it('carries the manifest description into the block', () => {
    writeListener('qqmail-idle', 'QQ 邮箱', ['mail.received'], '监听 QQ 邮箱新邮件')
    setEnabled(['qqmail-idle'])
    expect(readEnabledListeners(root)[0]?.description).toBe('监听 QQ 邮箱新邮件')
  })

  it('falls back to the bare name when the manifest has no description', () => {
    writeListener('plain', 'Plain', ['p.q'])
    setEnabled(['plain'])
    const line = formatEventsBlock(readEnabledListeners(root)).split('\n').find((row) => row.startsWith('- '))
    expect(line).toBe('- `plain`（Plain）→ p.q')
  })

  it('keeps a chatty description on one line and bounded', () => {
    var long =
      '\u76d1\u542c QQ \u90ae\u7bb1\u65b0\u90ae\u4ef6\u3002\n\u8fd9\u662f\u4e00\u6bb5\u6362\u884c\u540e\u7684\u5185\u5bb9\uff0c\u4e0d\u5e94\u8be5\u628a\u6b63\u6587\u6491\u6210\u591a\u884c\u3002\n\n\u8fd8\u6709\u7b2c\u4e09\u6bb5 '
      + 'x'.repeat(200)
    writeListener('noisy', 'Noisy', ['n.q'], long)
    setEnabled(['noisy'])
    const line = formatEventsBlock(readEnabledListeners(root)).split('\n').find((row) => row.startsWith('- '))!
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\u3002\u8fd9')
    expect(line).toContain('\u4e0d\u5e94\u8be5')
    expect(line.length).toBeLessThan(220)
  })

  it('formats an explicit entry list', () => {
    expect(formatEventsBlock([])).toBe('')
    expect(formatEventsBlock([{ id: 'x', name: 'X', eventTypes: [] }])).toContain('(any)')
  })
})
