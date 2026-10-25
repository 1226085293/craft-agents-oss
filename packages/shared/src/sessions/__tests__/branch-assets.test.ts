import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copySessionAssetsForBranch } from '../branch-assets.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function mk(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-branch-assets-'))
  dirs.push(dir)
  return dir
}

/**
 * A forked branch keeps `{{SESSION_PATH}}` placeholders in message payloads,
 * and those remap to the BRANCH directory. Files the parent stored there must
 * be copied or the branch shows broken images / unreadable long outputs
 * (2026-10-18 audit of 261018-bold-bonsai).
 */
describe('copySessionAssetsForBranch', () => {
  it('copies asset directories and the tool-metadata cache', () => {
    const src = mk()
    const dest = mk()
    mkdirSync(join(src, 'attachments'), { recursive: true })
    writeFileSync(join(src, 'attachments', 'a.png'), 'img')
    mkdirSync(join(src, 'long_responses'), { recursive: true })
    writeFileSync(join(src, 'long_responses', 'r.txt'), 'output')
    mkdirSync(join(src, 'plans'), { recursive: true })
    writeFileSync(join(src, 'plans', 'p.md'), '# plan')
    writeFileSync(join(src, 'tool-metadata.json'), '{"t":1}')

    const result = copySessionAssetsForBranch(src, dest)

    expect(result.copiedDirs.sort()).toEqual(['attachments', 'long_responses', 'plans'])
    expect(result.copiedFiles).toEqual(['tool-metadata.json'])
    expect(result.skippedDirs).toEqual([])
    expect(readFileSync(join(dest, 'attachments', 'a.png'), 'utf8')).toBe('img')
    expect(readFileSync(join(dest, 'long_responses', 'r.txt'), 'utf8')).toBe('output')
    expect(readFileSync(join(dest, 'tool-metadata.json'), 'utf8')).toBe('{"t":1}')
  })

  it('never overwrites an existing branch file', () => {
    const src = mk()
    const dest = mk()
    mkdirSync(join(src, 'attachments'), { recursive: true })
    writeFileSync(join(src, 'attachments', 'a.png'), 'from-parent')
    mkdirSync(join(dest, 'attachments'), { recursive: true })
    writeFileSync(join(dest, 'attachments', 'a.png'), 'already-here')

    copySessionAssetsForBranch(src, dest)

    expect(readFileSync(join(dest, 'attachments', 'a.png'), 'utf8')).toBe('already-here')
  })

  it('skips an asset tree over the size cap and reports it', () => {
    const src = mk()
    const dest = mk()
    mkdirSync(join(src, 'downloads'), { recursive: true })
    writeFileSync(join(src, 'downloads', 'big.bin'), 'x'.repeat(2048))

    const result = copySessionAssetsForBranch(src, dest, 1024)

    expect(result.skippedDirs).toEqual(['downloads'])
    expect(existsSync(join(dest, 'downloads', 'big.bin'))).toBe(false)
  })

  it('returns an empty result for a session with no assets', () => {
    const src = mk()
    const dest = mk()

    const result = copySessionAssetsForBranch(src, dest)

    expect(result).toEqual({ copiedDirs: [], copiedFiles: [], skippedDirs: [] })
  })
})
