/**
 * Prototype atoms — one React port of each helper the prototype builds inline
 * (`badge()`, `switchEl()`, `dot`, `minibar`, `spark`). Keeping them as
 * components instead of template fragments is what lets the views emit the
 * exact DOM the prototype's CSS was written against.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'

export type BadgeKind = 'green' | 'amber' | 'gray' | 'red' | 'accent'

export function Badge(props: { kind: BadgeKind; children: React.ReactNode; title?: string }): React.JSX.Element {
  return (
    <span className={`badge ${props.kind}`} title={props.title}>
      {props.children}
    </span>
  )
}

export function Switch(props: { on: boolean; onClick?: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`switch ${props.on ? 'on' : ''}`}
      onClick={props.onClick}
    />
  )
}

export function Dot(props: { color: 'green' | 'amber' | 'red' | 'gray' }): React.JSX.Element {
  return <span className={`dot ${props.color}`} />
}

export function Minibar(props: { pct: number; tone?: 'ok' | 'warn' | 'bad'; width?: number }): React.JSX.Element {
  const tone = props.tone ?? 'ok'
  return (
    <span className="minibar" style={props.width ? { width: props.width } : undefined}>
      <i className={tone === 'ok' ? '' : tone} style={{ width: `${Math.min(100, Math.max(0, props.pct))}%` }} />
    </span>
  )
}

/**
 * Sparkline: same 200×26 viewBox and polyline math as the prototype's
 * `pts()` + `spark()`.
 */
export function Spark(props: { values: number[]; color?: string }): React.JSX.Element {
  const arr = props.values.length > 1 ? props.values : [0, 0]
  const mx = Math.max(...arr)
  const mn = Math.min(...arr)
  const span = Math.max(1e-9, mx - mn)
  const points = arr
    .map((v, i) => {
      const x = (i / (arr.length - 1)) * 200
      const y = 22 - ((v - mn) / span) * 20
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg className="spark" viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={props.color || 'var(--chart-prompt)'} strokeWidth="2" />
    </svg>
  )
}

/** 507–412 style token formatting, matching the prototype's `fmt()`. */
export function fmt(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n)
}

/** Countdown text for a cooldown deadline, matching `fmtRemain()`. */
export function fmtRemain(until: number, now = Date.now()): string {
  const ms = until - now
  if (!(ms > 0)) return '已解除'
  const m = Math.floor(ms / 60000)
  if (m < 60) return m + ' 分钟'
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 48) return h + ' 小时' + (rm ? ' ' + rm + ' 分' : '')
  return Math.floor(h / 24) + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 小时' : '')
}

/** Duration text (`fmtDur`), used by the window dialog's span hints. */
export function fmtDur(msValue: number): string {
  if (!(msValue > 0)) return '0 分钟'
  const m = Math.floor(msValue / 60000)
  if (m < 60) return m + ' 分钟'
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 48) return h + ' 小时' + (rm ? ' ' + rm + ' 分' : '')
  return Math.floor(h / 24) + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 小时' : '')
}

export function hhmm2min(v: string): number {
  const a = String(v || '00:00').split(':')
  return Number(a[0]) * 60 + Number(a[1] || 0)
}

/**
 * Dropdown that renders inside the page's own theme.
 *
 * Native `<select>` popups on Windows are painted by the OS in the *system*
 * theme, so a dark dialog opens a light list with a blue highlight. This keeps
 * the closed control looking identical to a `<select>` while the open list uses
 * the same tokens as every other surface.
 */
export function ProtoSelect(props: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null)
  const root = React.useRef<HTMLDivElement | null>(null)
  const btn = React.useRef<HTMLButtonElement | null>(null)
  const current = props.options.find((o) => o.value === props.value)

  // The dialog body scrolls and clips absolutely-positioned children, so the
  // list is portalled next to the page root and anchored to the button's
  // viewport rect (flipping up when there is no room below).
  const openList = (): void => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    const flip = window.innerHeight - r.bottom < 240
    setPos({
      left: r.left,
      width: r.width,
      ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    })
    setOpen(true)
  }

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (root.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    // Scrolling used to CLOSE the list outright, which made the dropdown
    // unusable: the settings page sits in a scroll container, so the merest
    // wheel nudge — the gesture everyone makes while reaching for the list —
    // dismissed it before an option could be clicked. Re-anchoring instead
    // keeps the list glued to its button while the page moves under it.
    let frame = 0
    const reposition = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const r = btn.current?.getBoundingClientRect()
        if (!r) return
        // Scrolled out of sight: the anchor is gone, so closing is right.
        if (r.bottom < 0 || r.top > window.innerHeight) {
          setOpen(false)
          return
        }
        const flip = window.innerHeight - r.bottom < 240
        setPos({
          left: r.left,
          width: r.width,
          ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
        })
      })
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [open])

  const host = (root.current?.closest('.llm-proto') as HTMLElement | null) ?? null
  // The option list lives in a portal outside `root`, so the outside-click
  // handler below cannot treat "not inside root" as "clicked away" — it must
  // also accept clicks on the popover. Without this, mousedown on an option
  // unmounts it before the click event fires and the selection never lands
  // (provider edit dialog: 默认类型 dropdown appeared inert).
  const popRef = React.useRef<HTMLDivElement | null>(null)

  return (
    <div className="pselect" ref={root}>
      <button
        ref={btn}
        type="button"
        className={`pselect-btn ${open ? 'open' : ''}`}
        disabled={props.disabled}
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <span className={current ? '' : 'muted'}>{current?.label ?? props.placeholder ?? '请选择'}</span>
        <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && pos && host
        ? createPortal(
            <div
              ref={popRef}
              className="pselect-pop"
              role="listbox"
              style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            >
              {props.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === props.value}
                  className={`pselect-item ${o.value === props.value ? 'on' : ''}`}
                  onClick={() => {
                    props.onChange(o.value)
                    setOpen(false)
                  }}
                >
                  {o.label}
                  {o.value === props.value ? <span className="pselect-check">✓</span> : null}
                </button>
              ))}
              {props.options.length === 0 ? (
                <div className="xs muted" style={{ padding: '8px 10px' }}>
                  没有可选项
                </div>
              ) : null}
            </div>,
            host,
          )
        : null}
    </div>
  )
}
