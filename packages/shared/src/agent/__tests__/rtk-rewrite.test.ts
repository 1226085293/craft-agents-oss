/**
 * RTK rewrite output → shell-safe command.
 *
 * `rtk rewrite` answers with its CLI name, not with the path we spawned it by.
 * The Bash tool's shell only sees the user's PATH, so a bare `rtk` in the answer
 * died with `rtk: command not found` — the turn the model was told had run had
 * not run at all. These cases pin the qualification that keeps the rewrite
 * executable wherever the binary actually lives.
 */

import { describe, expect, it } from 'bun:test'

import { qualifyRtkCommand } from '../core/rtk-rewrite'

const POSIX = '/home/u/.craft-agent/rtk/linux-x64/rtk'
const WINDOWS = 'C:\\Users\\u\\.craft-agent\\rtk\\win32-x64\\rtk.exe'

describe('qualifyRtkCommand', () => {
  it('replaces a leading rtk with the absolute path', () => {
    expect(qualifyRtkCommand('rtk git status', POSIX)).toBe(`"${POSIX}" git status`)
  })

  it('normalises a Windows path to forward slashes', () => {
    // Git Bash reads backslashes in a bare word as escapes, so the .exe path has
    // to be handed over as C:/... instead of C:\...
    expect(qualifyRtkCommand('rtk git log', WINDOWS)).toBe(
      '"C:/Users/u/.craft-agent/rtk/win32-x64/rtk.exe" git log',
    )
  })

  it('qualifies every command position in a compound command', () => {
    expect(qualifyRtkCommand('cd repo && rtk git status', POSIX)).toBe(
      `cd repo && "${POSIX}" git status`,
    )
    expect(qualifyRtkCommand('rtk git diff | rtk git status; rtk git log', POSIX)).toBe(
      `"${POSIX}" git diff | "${POSIX}" git status; "${POSIX}" git log`,
    )
  })

  it('leaves arguments and file names that merely contain rtk alone', () => {
    // `cat rtk-notes.md` is not an invocation; rewriting it would corrupt the
    // command the model asked for.
    const cmd = 'cat rtk-notes.md && grep rtk README.md'
    expect(qualifyRtkCommand(cmd, POSIX)).toBe(cmd)
  })

  it('handles a leading subshell parenthesis', () => {
    expect(qualifyRtkCommand('(rtk git status)', POSIX)).toBe(`("${POSIX}" git status)`)
  })

  it('is a no-op without a resolved binary', () => {
    expect(qualifyRtkCommand('rtk git status', '')).toBe('rtk git status')
  })
})
