import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Sticky-bottom for the expanded activities list: once the user is at the
// bottom (or expands the card), newly arriving process content must keep the
// list pinned to the latest row. packages/ui has no RTL/jsdom harness, so this
// is a source-text guard for the wiring in TurnCard.tsx.
const src = readFileSync(join(__dirname, '../TurnCard.tsx'), 'utf8')

describe('TurnCard activities list sticks to bottom', () => {
  it('tracks stick-to-bottom state from container scroll events', () => {
    expect(src).toContain('isActivitiesStickToBottomRef')
    expect(src).toContain('onScroll={handleActivitiesScroll}')
  })

  it('keeps the list pinned while new process content arrives', () => {
    expect(src).toContain('stickIfAtBottom')
    expect(src).toContain('MutationObserver')
    expect(src).toContain('ResizeObserver')
  })

  it('opens in-progress turns at the latest step before paint (session switch)', () => {
    expect(src).toContain('useLayoutEffect')
    // In-progress turns pin to the bottom during the layout phase, so a
    // session switch lands on the latest step without a visible jump.
    expect(src).toMatch(/if \(!isComplete\) \{[\s\S]{0,200}el\.scrollTop = el\.scrollHeight/)
    expect(src).toContain('}, [isExpanded, isComplete])')
  })
})

describe('TurnCard rows update in place while streaming (flicker fix)', () => {
  it('keys activity rows by stream identity, not the swappable message id', () => {
    // text_complete replaces the renderer id with the authoritative main-process
    // id; keying by id would remount the row (old row spliced next to the new).
    expect(src).toContain('buildActivityRenderKeys')
    expect(src).toContain('key={activityRenderKeys.get(activity) ?? activity.id}')
    expect(src).toContain("key={activityRenderKeys.get(item) ?? item.id}")
    expect(src).toContain('key={childRenderKeys.get(child) ?? child.id}')
  })

  it('suppresses the standalone indicator while a running step row shows the same state', () => {
    expect(src).toContain('hasVisibleRunningIntermediate')
    expect(src).toContain(
      'isThinking && !animateResponse && !hasVisibleRunningIntermediate'
    )
  })

  it('does not use exit-tracking AnimatePresence around the activity rows', () => {
    // Exit tracking splices removed rows back at their old index for a frame.
    // The rows list must render without AnimatePresence mode="sync".
    expect(src).not.toContain('mode="sync"')
  })

  it('renders running intermediate rows without an enter animation', () => {
    // The pending row fades in as the indicator disappears; fading it again
    // would blink. Both row sites (flat + grouped) skip initial for running rows.
    const runningInitial = src.match(
      /type === 'intermediate' && (?:activity|item)\.status === 'running'/g
    )
    expect(runningInitial?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
})
