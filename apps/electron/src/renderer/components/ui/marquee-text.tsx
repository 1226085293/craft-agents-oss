/**
 * MarqueeText — one line of text that truncates, and scrolls when hovered.
 *
 * Contract (2026-11-03, user-specified):
 * - idle: the text is clamped to one line and ends in `…` when it does not fit;
 * - hover, overflowing only: the text scrolls right-to-left ONCE, at a constant
 *   speed, and stops with its end visible. It does not loop while the pointer
 *   stays; leaving and re-entering starts it again from the left edge;
 * - hover, fitting text: nothing moves (there is nothing to reveal);
 * - pointer leaves: the animation is cancelled and the ellipsis returns.
 *
 * Earlier this looped with a 1s rest at the end. Looping kept a row the user had
 * already finished reading in motion, so it now stops and waits for a fresh
 * hover.
 *
 * Why the two-element shape: `text-overflow: ellipsis` only works on a box
 * whose width is constrained (`overflow: hidden`), and a box that is clipped to
 * the viewport cannot be translated to reveal its hidden tail — the text would
 * stay clipped inside its own box. So the inner element is natural width
 * (`w-max`) while scrolling and viewport width (`truncate`) at rest, and the
 * overflow amount is measured from `scrollWidth`, which reports the unclipped
 * text width even while the ellipsis is showing.
 *
 * The geometry (`marqueeOverflow` / `marqueeAnimationSpec`) lives outside the
 * component so it can be tested without a browser: jsdom has no
 * `Element.animate` and no text layout.
 */

import * as React from 'react'

import { cn } from '@/lib/utils'

/** Scroll speed in pixels per second. Fast enough to feel responsive on a
 *  250px row, slow enough to read. */
export const MARQUEE_DEFAULT_SPEED = 40
/** Floor for the scroll leg, so a 3px overflow does not strobe. */
const MIN_SCROLL_MS = 250

/** One span of the line. `muted` is the trailing half — `策略组名 - 模型名`. */
export interface MarqueePart {
  text: string
  /** Render dimmer, like the composer chip's model half. */
  muted?: boolean
}

/** How much of the text is hidden, in whole pixels. Never negative. */
export function marqueeOverflow(contentWidth: number, viewportWidth: number): number {
  if (!Number.isFinite(contentWidth) || !Number.isFinite(viewportWidth)) return 0
  return Math.max(0, Math.round(contentWidth - viewportWidth))
}

/** Time the single scroll leg takes at `speed` px/s. */
export function marqueeScrollMs(overflow: number, speed: number = MARQUEE_DEFAULT_SPEED): number {
  if (overflow <= 0) return 0
  const pxPerSecond = Number.isFinite(speed) && speed > 0 ? speed : MARQUEE_DEFAULT_SPEED
  return Math.max(MIN_SCROLL_MS, Math.round((overflow / pxPerSecond) * 1000))
}

export interface MarqueeAnimationSpec {
  keyframes: Keyframe[]
  duration: number
}

/**
 * Keyframes for the single pass: left edge → end. The element is left at the
 * end (`fill: 'forwards'` at the call site), so the hidden tail stays readable
 * until the pointer leaves.
 */
export function marqueeAnimationSpec(
  overflow: number,
  speed: number = MARQUEE_DEFAULT_SPEED,
): MarqueeAnimationSpec {
  return {
    keyframes: [
      { transform: 'translateX(0px)' },
      { transform: `translateX(-${overflow}px)` },
    ],
    duration: marqueeScrollMs(overflow, speed),
  }
}

export interface MarqueeTextProps {
  parts: MarqueePart[]
  /** Pixels per second while scrolling. */
  speed?: number
  className?: string
  /** Extra classes for the translated element (the text itself). */
  innerClassName?: string
}

export function MarqueeText({
  parts,
  speed = MARQUEE_DEFAULT_SPEED,
  className,
  innerClassName,
}: MarqueeTextProps): React.JSX.Element {
  const viewportRef = React.useRef<HTMLSpanElement>(null)
  const contentRef = React.useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = React.useState(0)
  const [hovering, setHovering] = React.useState(false)

  // Stable identity for "the text changed" — `parts` is a fresh array every
  // render, so depending on it would re-measure (and re-set state) each time.
  const measureKey = parts.map((p) => p.text).join('\u0000')

  // Measure on mount, on text change and on container resize. `scrollWidth`
  // reports the whole text even while it is ellipsised, so this works whether
  // or not the pointer is down.
  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const measure = () => setOverflow(marqueeOverflow(content.scrollWidth, viewport.clientWidth))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [measureKey])

  const scrolling = hovering && overflow > 0

  React.useEffect(() => {
    const content = contentRef.current
    if (!content) return
    if (!scrolling) {
      content.style.transform = ''
      return
    }
    // jsdom (tests) has no Web Animations API; the layout above still holds.
    if (typeof content.animate !== 'function') return
    const spec = marqueeAnimationSpec(overflow, speed)
    const animation = content.animate(spec.keyframes, {
      duration: spec.duration,
      // Exactly one pass: hover reveals the end and stops there. A fresh hover
      // creates a fresh animation, which is what "re-enter scrolls again" means.
      iterations: 1,
      fill: 'forwards',
      easing: 'linear',
    })
    return () => {
      animation.cancel()
      // `cancel()` drops the fill, but a transform left in the inline style by
      // an interrupted run would keep the text scrolled on the next hover.
      content.style.transform = ''
    }
  }, [scrolling, overflow, speed])

  return (
    <span
      ref={viewportRef}
      data-marquee={overflow > 0 ? 'overflowing' : 'fitting'}
      className={cn('block min-w-0 overflow-hidden whitespace-nowrap', className)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span
        ref={contentRef}
        className={cn('block', scrolling ? 'w-max' : 'truncate', innerClassName)}
      >
        {parts.map((part, i) => (
          <span key={i} className={part.muted ? 'text-muted-foreground' : undefined}>
            {part.text}
          </span>
        ))}
      </span>
    </span>
  )
}
