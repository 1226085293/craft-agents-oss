import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { RICH_BLOCK_DEFAULTS, type RichBlockInteractionOptions } from './rich-block-interaction-spec'

export function clampScale(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function zoomStepScale(current: number, direction: 'in' | 'out', factor: number, min: number, max: number): number {
  const nextFactor = direction === 'in' ? factor : 1 / factor
  return clampScale(current * nextFactor, min, max)
}

export function cursorAnchoredTranslate(
  translate: { x: number; y: number },
  cursor: { x: number; y: number },
  scaleRatio: number,
): { x: number; y: number } {
  return {
    x: cursor.x - scaleRatio * (cursor.x - translate.x),
    y: cursor.y - scaleRatio * (cursor.y - translate.y),
  }
}

export function computeFitScale(
  container: { width: number; height: number },
  content: { width: number; height: number },
  min: number,
  max: number,
): number {
  const scaleX = (container.width * 0.9) / content.width
  const scaleY = (container.height * 0.9) / content.height
  return clampScale(Math.min(scaleX, scaleY), min, max)
}

/**
 * Zoom level that fills the whole viewport (content may be cropped), with the
 * same 90% padding as `computeFitScale`. Used to open previews edge-to-edge
 * so wide or small images don't render as a centered strip on the backdrop.
 */
export function computeCoverScale(
  container: { width: number; height: number },
  content: { width: number; height: number },
  min: number,
  max: number,
): number {
  const scaleX = (container.width * 0.9) / content.width
  const scaleY = (container.height * 0.9) / content.height
  return clampScale(Math.max(scaleX, scaleY), min, max)
}

/**
 * Duck-type check for DOM nodes: every Node exposes a numeric `nodeType`.
 * Deliberately global-free (no `instanceof Node`) so it stays correct in
 * non-DOM environments and trivially unit-testable with plain object fakes.
 */
export function isNodeTarget(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { nodeType?: unknown }).nodeType === 'number'
  )
}

/**
 * Predicate deciding whether a wheel event should be handled as rich-block zoom.
 * The wheel listener is attached to `document` (see the wheel effect below), so
 * every event is gated here: only events whose target lies inside the preview
 * container zoom; everything else keeps native scroll behavior.
 *
 * Exported for unit testing — it is deliberately DOM-shape-agnostic so it can be
 * exercised with plain object fakes.
 */
export function shouldHandleWheel(
  container: HTMLElement | null,
  target: unknown,
): boolean {
  if (!container || !isNodeTarget(target)) return false
  return container.contains(target as Node)
}

interface UseRichBlockInteractionsOptions extends RichBlockInteractionOptions {
  containerRef: RefObject<HTMLDivElement | null>
}

/**
 * Single source of truth for the zoomed view: scale + center-anchored
 * translate. Kept in ONE state object so every gesture (wheel, drag, step)
 * applies a single pure update — the previous split-state version nested a
 * `setTranslate` inside a `setScale` updater, which is impure and drifted
 * under React updater re-invocation.
 */
interface InteractionView {
  scale: number
  x: number
  y: number
}

const DEFAULT_VIEW: InteractionView = { scale: 1, x: 0, y: 0 }

export function useRichBlockInteractions({
  isOpen,
  containerRef,
  minScale = RICH_BLOCK_DEFAULTS.minScale,
  maxScale = RICH_BLOCK_DEFAULTS.maxScale,
  zoomStepFactor = RICH_BLOCK_DEFAULTS.zoomStepFactor,
  wheelSensitivity = RICH_BLOCK_DEFAULTS.wheelSensitivity,
  keyboardShortcuts = true,
}: UseRichBlockInteractionsOptions) {
  const [view, setView] = useState<InteractionView>(DEFAULT_VIEW)
  const [isDragging, setIsDragging] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)

  const isDraggingRef = useRef(false)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const translateAtDragStartRef = useRef({ x: 0, y: 0 })

  const scale = view.scale
  const translate = useMemo(() => ({ x: view.x, y: view.y }), [view])

  const reset = useCallback(() => {
    setIsAnimating(true)
    setView(DEFAULT_VIEW)
  }, [])

  const zoomByStep = useCallback((direction: 'in' | 'out') => {
    setIsAnimating(true)
    setView(v => {
      const next = zoomStepScale(v.scale, direction, zoomStepFactor, minScale, maxScale)
      const ratio = next / v.scale
      return { scale: next, x: v.x * ratio, y: v.y * ratio }
    })
  }, [zoomStepFactor, minScale, maxScale])

  const zoomToPreset = useCallback((percent: number) => {
    setIsAnimating(true)
    setView({ scale: clampScale(percent / 100, minScale, maxScale), x: 0, y: 0 })
  }, [minScale, maxScale])

  const zoomToFit = useCallback((content: { width: number; height: number } | null) => {
    const container = containerRef.current
    if (!container || !content) {
      reset()
      return
    }

    const rect = container.getBoundingClientRect()
    const fit = computeFitScale({ width: rect.width, height: rect.height }, content, minScale, maxScale)
    setIsAnimating(true)
    setView({ scale: fit, x: 0, y: 0 })
  }, [containerRef, minScale, maxScale, reset])

  const zoomToCover = useCallback((content: { width: number; height: number } | null) => {
    const container = containerRef.current
    if (!container || !content) {
      reset()
      return
    }

    const rect = container.getBoundingClientRect()
    const cover = computeCoverScale({ width: rect.width, height: rect.height }, content, minScale, maxScale)
    setIsAnimating(true)
    setView({ scale: cover, x: 0, y: 0 })
  }, [containerRef, minScale, maxScale, reset])

  const onMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    isDraggingRef.current = true
    setIsDragging(true)
    setIsAnimating(false)
    dragStartRef.current = { x: e.clientX, y: e.clientY }
    setView(v => {
      translateAtDragStartRef.current = { x: v.x, y: v.y }
      return v
    })
  }, [])

  const onDoubleClick = useCallback(() => {
    reset()
  }, [reset])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      setIsAnimating(false)
      setView(v => ({
        ...v,
        x: translateAtDragStartRef.current.x + (e.clientX - dragStartRef.current.x),
        y: translateAtDragStartRef.current.y + (e.clientY - dragStartRef.current.y),
      }))
    }

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return

    // The preview mounts through a Radix Portal + Presence: portal content attaches
    // ONE COMMIT AFTER `isOpen` flips, so when this effect first runs the ref is
    // still null and a container-attached listener is silently never registered.
    // Attaching to `document` (always available) and gating each event with
    // `shouldHandleWheel` fixes that: zoom works regardless of portal timing,
    // and wheels outside the preview keep native scroll behavior.
    const handleWheel = (e: WheelEvent) => {
      const container = containerRef.current
      if (!container || !shouldHandleWheel(container, e.target)) return

      e.preventDefault()
      e.stopPropagation()

      const rect = container.getBoundingClientRect()
      const cursor = {
        x: e.clientX - rect.left - rect.width / 2,
        y: e.clientY - rect.top - rect.height / 2,
      }

      const sensitivity = e.ctrlKey ? wheelSensitivity.trackpadPinch : wheelSensitivity.mouse
      const factor = Math.pow(2, -e.deltaY * sensitivity)

      // Glide instead of snap: consumers apply a short CSS transition while
      // `isAnimating` is true, so rapid wheel/trackpad streams retarget an
      // interruptible transition and feel continuous.
      setIsAnimating(true)
      setView(v => {
        const next = clampScale(v.scale * factor, minScale, maxScale)
        const anchored = cursorAnchoredTranslate({ x: v.x, y: v.y }, cursor, next / v.scale)
        return { scale: next, ...anchored }
      })
    }

    document.addEventListener('wheel', handleWheel, { passive: false })
    return () => document.removeEventListener('wheel', handleWheel)
  }, [isOpen, containerRef, minScale, maxScale, wheelSensitivity])

  useEffect(() => {
    if (!isOpen || !keyboardShortcuts) return

    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return

      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        zoomByStep('in')
      } else if (e.key === '-') {
        e.preventDefault()
        zoomByStep('out')
      } else if (e.key === '0') {
        e.preventDefault()
        reset()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, keyboardShortcuts, reset, zoomByStep])

  useEffect(() => {
    if (!isOpen) return
    setView(DEFAULT_VIEW)
    setIsDragging(false)
    isDraggingRef.current = false
  }, [isOpen])

  return {
    scale,
    translate,
    isDragging,
    isAnimating,
    setIsAnimating,
    zoomByStep,
    zoomToPreset,
    zoomToFit,
    zoomToCover,
    reset,
    onMouseDown,
    onDoubleClick,
  }
}
