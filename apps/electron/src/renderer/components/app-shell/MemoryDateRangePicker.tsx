import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { cn } from '@/lib/utils'

interface MemoryDateRangePickerProps {
  value?: DateRange
  onChange: (range: DateRange | undefined) => void
}

const MAX_YEAR = new Date().getFullYear() + 1
const GRID_ROWS = 6
const GRID_COLS = 7

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addMonths(date: Date, count: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + count, 1)
}

/**
 * Lightweight date-range calendar with fully controlled styling.
 * Replaces the react-day-picker wrapper (whose nav buttons were unclickable
 * under the dropdown caption and whose dropdown styling clashed with themes).
 *
 * - month navigation: chevron buttons + month/year dropdowns (theme-consistent)
 * - localised headers: "2026年10月" + 周一…周日 for zh, locale default otherwise
 * - range visual: accent chips on the ends, soft accent fill in between
 */
export function MemoryDateRangePicker({ value, onChange }: MemoryDateRangePickerProps) {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? 'en'
  const isZh = language.startsWith('zh')

  // Monday-first for zh locales, Sunday-first otherwise.
  const weekStartsOn = isZh ? 1 : 0
  const [viewMonth, setViewMonth] = React.useState<Date>(() => startOfMonth(value?.from ?? new Date()))

  const viewYear = viewMonth.getFullYear()
  const monthNames = React.useMemo(() => {
    const months: string[] = []
    for (let m = 0; m < 12; m++) {
      months.push(new Date(viewYear, m, 1).toLocaleDateString(language, { month: isZh ? 'long' : 'short' }))
    }
    return months
  }, [viewYear, language, isZh])

  const weekdayLabels = React.useMemo(() => {
    if (isZh) return ['一', '二', '三', '四', '五', '六', '日']
    const formatter = new Intl.DateTimeFormat(language, { weekday: 'short' })
    return [0, 1, 2, 3, 4, 5, 6].map(index => formatter.format(new Date(2026, 0, 4 + index))) // 2026-01-04 is a Sunday
  }, [language, isZh])

  const cells = React.useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1)
    const firstWeekday = first.getDay()
    const offset = (firstWeekday - weekStartsOn + 7) % 7
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
    const days: Date[] = []
    for (let i = 0; i < GRID_ROWS * GRID_COLS; i++) {
      days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
    }
    return days
  }, [viewMonth, weekStartsOn])

  const isInRange = (date: Date): boolean => {
    if (!value?.from) return false
    const ts = date.getTime()
    if (value.to) {
      const from = Math.min(value.from.getTime(), value.to.getTime())
      const to = Math.max(value.from.getTime(), value.to.getTime())
      return ts >= from && ts <= to
    }
    return ts === value.from.getTime()
  }

  const isEnd = (date: Date): boolean => {
    if (!value?.from) return false
    if (!value.to) return date.getTime() === value.from.getTime()
    return date.getTime() === value.from.getTime() || date.getTime() === value.to.getTime()
  }

  const handlePick = (date: Date) => {
    if (!value?.from || (value.from && value.to)) {
      onChange({ from: date, to: undefined })
      return
    }
    // Second click completes the range (swap if backwards).
    if (date.getTime() < value.from.getTime()) {
      onChange({ from: date, to: value.from })
    } else {
      onChange({ from: value.from, to: date })
    }
  }

  return (
    <div className="w-full p-3">
      {/* Header: previous / month+year dropdowns / next */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setViewMonth(month => addMonths(month, -1))}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          aria-label={t('memory.calendarPrevMonth')}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-1.5">
          <select
            value={viewMonth.getMonth()}
            onChange={(event) => setViewMonth(month => new Date(month.getFullYear(), Number(event.target.value), 1))}
            className="h-7 rounded-md border border-foreground/15 bg-background px-1.5 text-xs font-medium"
            aria-label={t('memory.calendarMonth')}
          >
            {monthNames.map((name, index) => (
              <option key={index} value={index}>{name}</option>
            ))}
          </select>
          <select
            value={viewMonth.getFullYear()}
            onChange={(event) => setViewMonth(month => new Date(Number(event.target.value), month.getMonth(), 1))}
            className="h-7 rounded-md border border-foreground/15 bg-background px-1.5 text-xs font-medium"
            aria-label={t('memory.calendarYear')}
          >
            {Array.from({ length: MAX_YEAR - 2019 }, (_, index) => 2020 + index).map(year => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => setViewMonth(month => addMonths(month, 1))}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          aria-label={t('memory.calendarNextMonth')}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Weekday header */}
      <div className="mt-3 grid grid-cols-7">
        {weekdayLabels.map(weekday => (
          <div key={weekday} className="flex h-7 items-center justify-center text-[11px] text-muted-foreground">
            {weekday}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="mt-1 grid grid-cols-7">
        {cells.map(date => {
          const inCurrentMonth = date.getMonth() === viewMonth.getMonth()
          const isToday = date.toDateString() === new Date().toDateString()
          const inRange = inCurrentMonth && isInRange(date)
          const end = inRange && isEnd(date)
          return (
            <button
              key={date.toISOString()}
              type="button"
              onClick={() => handlePick(date)}
              className={cn(
                'flex h-9 items-center justify-center rounded-md text-xs select-none transition-colors',
                'hover:bg-foreground/5',
                !inCurrentMonth && 'text-foreground/25',
                isToday && 'ring-1 ring-foreground/25',
                inRange && !end && 'rounded-none bg-accent/10 font-medium',
                end && 'bg-accent font-medium text-accent-foreground',
              )}
            >
              {date.getDate()}
            </button>
          )
        })}
      </div>

      {/* Selected range summary */}
      <div className="mt-3 border-t border-border/50 pt-2 text-center">
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {value?.from
            ? value.to
              ? `${formatDate(value.from)} ~ ${formatDate(value.to)}`
              : `${formatDate(value.from)} ~ …`
            : t('memory.customRangePlaceholder')}
        </span>
      </div>
    </div>
  )
}
