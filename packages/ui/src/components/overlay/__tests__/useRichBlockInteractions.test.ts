import { describe, expect, it } from 'vitest'
import {
  clampScale,
  computeFitScale,
  cursorAnchoredTranslate,
  shouldHandleWheel,
  zoomStepScale,
} from '../useRichBlockInteractions'

describe('useRichBlockInteractions helpers', () => {
  it('clamps scale within bounds', () => {
    expect(clampScale(0.1, 0.25, 4)).toBe(0.25)
    expect(clampScale(10, 0.25, 4)).toBe(4)
    expect(clampScale(1.5, 0.25, 4)).toBe(1.5)
  })

  it('computes step zoom in and out', () => {
    expect(zoomStepScale(1, 'in', 1.25, 0.25, 4)).toBe(1.25)
    expect(zoomStepScale(1, 'out', 1.25, 0.25, 4)).toBeCloseTo(0.8)
  })

  it('keeps cursor-anchored point stable when zooming', () => {
    const result = cursorAnchoredTranslate({ x: 20, y: -10 }, { x: 100, y: 50 }, 1.5)
    expect(result).toEqual({ x: -20, y: -40 })
  })

  it('computes zoom-to-fit scale with 90% padding', () => {
    const fit = computeFitScale(
      { width: 1000, height: 800 },
      { width: 2000, height: 1000 },
      0.25,
      4,
    )
    // min((1000*0.9)/2000 = 0.45, (800*0.9)/1000 = 0.72) = 0.45
    expect(fit).toBeCloseTo(0.45)
  })

  describe('shouldHandleWheel (document-level wheel gating)', () => {
    // The wheel listener lives on `document` because Radix Presence mounts the
    // portal content one commit after isOpen flips — a container-attached effect
    // would see a null ref. Gating is therefore a pure predicate we can fake.
    const fakeContainer = (children: Array<unknown>) => ({
      contains: (node: unknown) => children.includes(node),
    })
    // DOM nodes expose a numeric nodeType; that duck-type is what isNodeTarget checks.
    const fakeNode = () => ({ nodeType: 1 })

    it('rejects when the container ref is still null (portal not mounted yet)', () => {
      expect(shouldHandleWheel(null, fakeNode())).toBe(false)
    })

    it('rejects targets that are not DOM nodes', () => {
      const container = fakeContainer([fakeNode()])
      expect(shouldHandleWheel(container, undefined)).toBe(false)
      expect(shouldHandleWheel(container, {})).toBe(false)
      expect(shouldHandleWheel(container, 'text')).toBe(false)
    })

    it('accepts a target inside the container, rejects one outside', () => {
      const inner = fakeNode()
      const outer = fakeNode()
      const container = fakeContainer([inner])
      expect(shouldHandleWheel(container, inner)).toBe(true)
      expect(shouldHandleWheel(container, outer)).toBe(false)
    })
  })
})
