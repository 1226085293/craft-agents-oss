/**
 * MarqueeText geometry.
 *
 * The component's behaviour is "truncate, and on hover scroll to the end once
 * and stop". The browser half of that (Web Animations, real text layout) cannot
 * run under bun+jsdom, so the numbers that decide it live in pure helpers and
 * are pinned here:
 *
 * - how much is hidden ({@link marqueeOverflow}) — 0 means "fits, do not move";
 * - how long the single pass takes at a given speed;
 * - the keyframe pass itself — two stops, left edge to end, no loop keyframe.
 *   The "scrolls again" part is the component creating a new animation on each
 *   fresh hover, not an iteration inside one animation.
 */

import { describe, expect, it } from 'bun:test'

import {
  MARQUEE_DEFAULT_SPEED,
  marqueeAnimationSpec,
  marqueeOverflow,
  marqueeScrollMs,
} from '../marquee-text'

describe('marqueeOverflow', () => {
  it('reports the hidden width when the text does not fit', () => {
    expect(marqueeOverflow(320, 200)).toBe(120)
  })

  it('is zero when the text fits — nothing may move', () => {
    expect(marqueeOverflow(180, 200)).toBe(0)
    expect(marqueeOverflow(200, 200)).toBe(0)
    // Sub-pixel slack from fractional layout must not start a scroll.
    expect(marqueeOverflow(199.6, 200)).toBe(0)
  })

  it('survives a layout that has not been measured yet', () => {
    expect(marqueeOverflow(Number.NaN, 200)).toBe(0)
    expect(marqueeOverflow(200, Number.NaN)).toBe(0)
    expect(marqueeOverflow(-5, 200)).toBe(0)
  })
})

describe('marqueeScrollMs', () => {
  it('travels at the requested speed', () => {
    // 120px at 40px/s = 3s.
    expect(marqueeScrollMs(120, 40)).toBe(3000)
    expect(marqueeScrollMs(120, MARQUEE_DEFAULT_SPEED)).toBe(3000)
  })

  it('floors the leg so a tiny overflow does not strobe', () => {
    expect(marqueeScrollMs(4, 40)).toBe(250)
    expect(marqueeScrollMs(1, 400)).toBe(250)
  })

  it('has no scroll leg when nothing is hidden', () => {
    expect(marqueeScrollMs(0, 40)).toBe(0)
  })

  it('falls back to the default speed for a nonsensical value', () => {
    expect(marqueeScrollMs(120, 0)).toBe(3000)
    expect(marqueeScrollMs(120, Number.NaN)).toBe(3000)
    expect(marqueeScrollMs(120, -10)).toBe(3000)
  })
})

describe('marqueeAnimationSpec', () => {
  it('makes exactly one pass from the left edge to the end', () => {
    const spec = marqueeAnimationSpec(120, 40)
    expect(spec.duration).toBe(3000)
    expect(spec.keyframes).toEqual([
      { transform: 'translateX(0px)' },
      { transform: 'translateX(-120px)' },
    ])
  })

  it('has no hold keyframe — the element stops at the end and stays there', () => {
    // The old spec ended with a duplicate `translateX(-overflow)` at offset 1
    // so a looping animation could rest before restarting. One pass needs no
    // rest: the last keyframe IS the resting position, held by `fill`.
    const spec = marqueeAnimationSpec(200, 40)
    expect(spec.keyframes).toHaveLength(2)
    expect(spec.keyframes[spec.keyframes.length - 1]).toEqual({ transform: 'translateX(-200px)' })
  })

  it('never produces a zero-length animation for tiny overflows', () => {
    expect(marqueeAnimationSpec(1, 40).duration).toBe(250)
  })
})
