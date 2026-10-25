/**
 * Time-limited model availability.
 *
 * A provider may declare, per model, the window during which that model is
 * usable — a limited-time free or discounted model is the motivating case.
 * Outside the window the member is removed from scheduling entirely: it must not
 * be tried, and it must not count as a failure when it is not.
 *
 * Pure and dependency-free so both the planner and the settings page's preview
 * can share one rule set. `now` is always passed in; nothing here reads the
 * clock, which is what makes the behaviour testable across midnights.
 */

/** One model's availability window, evaluated in its own timezone. */
export interface ModelWindow {
  /** IANA zone, e.g. `Asia/Shanghai`. Invalid zones fail open (see below). */
  tz: string
  /** First local date the window applies to, `YYYY-MM-DD`, inclusive. */
  from?: string
  /** Last local date the window applies to, `YYYY-MM-DD`, inclusive. */
  to?: string
  /** ISO weekdays, 1 = Monday … 7 = Sunday. Absent means every day. */
  days?: number[]
  /**
   * Daily spans in local time, `HH:MM`. Absent or empty means all day.
   * Several spans are OR-ed. An end earlier than its start crosses midnight.
   */
  spans?: Array<{ start: string; end: string }>
}

interface ZonedNow {
  /** Local date, `YYYY-MM-DD`. */
  date: string
  /** Minutes since local midnight. */
  minutes: number
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
}

function zonedNow(now: number, tz: string): ZonedNow | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    }).formatToParts(new Date(now))
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
    const year = get('year')
    const month = get('month')
    const day = get('day')
    const hour = Number(get('hour'))
    const minute = Number(get('minute'))
    const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0
    if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute) || !weekday) {
      return null
    }
    return {
      date: `${year}-${month}-${day}`,
      // `hourCycle: 'h23'` can still report 24 at midnight in some ICU builds.
      minutes: (hour % 24) * 60 + minute,
      weekday,
    }
  } catch {
    // Unknown zone. Returning null makes the caller fail open: an unusable
    // window must not take a provider out of service.
    return null
  }
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  return h * 60 + min
}

/** Whether `now` falls inside one of the spans. Empty spans mean all day. */
function spanAllows(spans: ModelWindow['spans'], minutes: number): boolean {
  if (!spans || spans.length === 0) return true
  for (const span of spans) {
    const start = toMinutes(span.start)
    const end = toMinutes(span.end)
    if (start === null || end === null) continue
    if (start === end) continue // A zero-length span is never inside itself.
    if (end > start) {
      if (minutes >= start && minutes < end) return true
    } else if (minutes >= start || minutes < end) {
      // Crosses midnight: 22:00–02:00 covers both ends of the day.
      return true
    }
  }
  return false
}

/**
 * Whether the model may be used right now.
 *
 * Absent window → allowed. An unparseable zone → allowed (fail open: a typo in a
 * timezone must not silently disable a working provider). Date bounds are
 * inclusive and compared against the window's own local date, so a window that
 * ends "today" still covers the whole of today in its zone.
 */
export function windowAllows(window: ModelWindow | undefined, now: number): boolean {
  if (!window) return true

  const local = zonedNow(now, window.tz)
  if (!local) return true

  if (window.from && local.date < window.from) return false
  if (window.to && local.date > window.to) return false
  if (window.days && window.days.length > 0 && !window.days.includes(local.weekday)) return false

  return spanAllows(window.spans, local.minutes)
}
