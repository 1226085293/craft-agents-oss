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
})
