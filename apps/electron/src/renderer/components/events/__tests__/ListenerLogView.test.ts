/**
 * The log reader's one piece of logic that can be wrong: turning a text tail into lines with
 * levels. Everything else in the component is layout, which a static-markup test cannot judge.
 *
 * The failure this guards against is over-eager matching. A level is a claim about a line, and a
 * wrong claim is worse than no claim: it sends the reader hunting for a failure that is not there,
 * or hides one behind `plain`.
 */

import { describe, expect, it } from 'bun:test'
import { classifyLine, isLive, parseLog } from '../ListenerLogView'

describe('classifyLine', () => {
  it('reads the level out of the shapes real plugins emit', () => {
    expect(classifyLine('2026-11-16 15:20:31 ERROR failed to bind port 8899')).toBe('error')
    expect(classifyLine('[WARN] token expires in 3 minutes')).toBe('warn')
    expect(classifyLine('INFO: listener started')).toBe('info')
    expect(classifyLine('DEBUG poll tick 41')).toBe('debug')
  })

  it('treats a Python traceback as an error', () => {
    // The line that matters in a crash is the exception, and it never carries a LEVEL token.
    expect(classifyLine('Traceback (most recent call last):')).toBe('error')
    expect(classifyLine('ValueError: missing CRAFT_EVENTS_TOKEN')).toBe('error')
  })

  it('does not colour ordinary prose containing the word error', () => {
    // `errors=0` in a stats line is not a failure; matching it would make every poll look broken.
    expect(classifyLine('poll complete errors=0')).toBe('plain')
    expect(classifyLine('warning_count: 0')).toBe('plain')
  })

  it('leaves an unmarked line plain rather than guessing', () => {
    expect(classifyLine('starting up')).toBe('plain')
    expect(classifyLine('')).toBe('plain')
  })
})

describe('parseLog', () => {
  it('splits a tail into numbered lines and drops the trailing newline', () => {
    const lines = parseLog('alpha\nbeta\n')
    expect(lines.map((l) => l.text)).toEqual(['alpha', 'beta'])
    expect(lines.map((l) => l.key)).toEqual([0, 1])
  })

  it('treats CRLF the same as LF', () => {
    expect(parseLog('alpha\r\nbeta').map((l) => l.text)).toEqual(['alpha', 'beta'])
  })

  it('returns nothing for an empty tail', () => {
    expect(parseLog(null)).toEqual([])
    expect(parseLog('')).toEqual([])
  })

  it('keeps the newest lines when the tail is longer than the cap', () => {
    // A crash loop can outrun the renderer; the cap is what stops the UI thread from melting, and
    // it must drop the OLDEST lines — a log tail is read from the bottom.
    const tail = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join('\n')
    const lines = parseLog(tail)
    expect(lines).toHaveLength(2000)
    expect(lines[lines.length - 1]!.text).toBe('line 2099')
    expect(lines[0]!.text).toBe('line 100')
  })
})

describe('isLive', () => {
  /**
   * 「跟随中」 claims the view is tracking a live stream.
   *
   * It was shown unconditionally, including for a plugin the user had switched off — a button
   * announcing it was following output that nothing was writing. The states below are the
   * difference between 「this process is producing logs」 and 「it is not」.
   */
  it('is live while the process can write output', () => {
    expect(isLive('running')).toBe(true)
    expect(isLive('starting')).toBe(true)
    expect(isLive('degraded')).toBe(true)
  })

  it('is not live when the process is down', () => {
    expect(isLive('stopped')).toBe(false)
    expect(isLive('failed')).toBe(false)
    expect(isLive(undefined)).toBe(false)
  })
})
