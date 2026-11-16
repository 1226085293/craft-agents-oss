/**
 * The plugin's process log, read rather than dumped.
 *
 * It used to be a `<pre>` holding the raw tail and a 刷新 button, refreshed on a 3-second timer.
 * Three things were wrong with that, and they are the reasons this file exists:
 *
 *   1. **A wall of text with no way in.** A log is a sequence of levels; painting them all the
 *      same colour meant scanning for the one line that failed. Levels are now data — the tab
 *      can filter to errors and the reader finds them.
 *   2. **The timer fought the reader.** A tail that re-renders every three seconds scrolls away
 *      from whatever you had scrolled to. Following is now a choice: it starts on (a log you
 *      just opened is usually a log you are watching) and stops the moment you scroll up.
 *   3. **The refresh button existed because the page was not live.** Pressing it and watching
 *      nothing visibly change is the classic dead-button feel. The page polls on its own; what
 *      the reader needs is a way to *pause* while they read a stack trace.
 *
 * The line count is bounded on purpose: a plugin in a crash loop can produce thousands of lines
 * a second, and this renders on the UI thread. The tail keeps the last `MAX_LINES`.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Pause, Play, Trash2 } from 'lucide-react'
import type { ListenerStatusDto } from '@craft-agent/shared/protocol/dto'

/** How many lines are kept. Beyond this the oldest are dropped. */
const MAX_LINES = 2000

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'plain'

export interface LogLine {
  /** Monotonic index — the React key. Two identical lines are two lines. */
  key: number
  text: string
  level: LogLevel
}

/**
 * Read the level off a line.
 *
 * Deliberately loose: plugins are Python, Node or Go and none of them agree on a format, so this
 * matches the tokens all three use (ERROR/ERR/FATAL/CRITICAL, WARN, INFO, DEBUG/TRACE). A line
 * that matches nothing stays `plain` — inventing a level for it would colour ordinary prose.
 */
export function classifyLine(text: string): LogLevel {
  // Case-sensitive upper-case match first: `Error: ...` in a traceback is the interesting case,
  // while `error_count=0` in a debug line is not. The word-boundary check is what separates them.
  if (/(^|[\s[(\-])(ERROR|ERR|FATAL|CRITICAL|Traceback)(\b|[\s\]:)])/i.test(text)) return 'error'
  // Exception class names carry their own suffix (`ValueError:`, `KeyError:`) and appear with no
  // leading separator when they start the line. Matching the suffix form catches them without
  // colouring `errors=0` in an ordinary stats line.
  if (/\b[A-Z][A-Za-z]*(Error|Exception)\b\s*:/.test(text)) return 'error'
  if (/(^|[\s[(\-])(WARN|WARNING)(\b|[\s\]:)])/i.test(text)) return 'warn'
  if (/(^|[\s[(\-])(INFO|NOTICE)(\b|[\s\]:)])/i.test(text)) return 'info'
  if (/(^|[\s[(\-])(DEBUG|TRACE)(\b|[\s\]:)])/i.test(text)) return 'debug'
  return 'plain'
}

/** Split a tail into classified lines, keeping only the newest `MAX_LINES`. */
export function parseLog(tail: string | null | undefined): LogLine[] {
  if (!tail) return []
  const raw = tail.split(/\r?\n/)
  // A trailing newline produces one empty entry; it is not a line.
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const kept = raw.length > MAX_LINES ? raw.slice(raw.length - MAX_LINES) : raw
  return kept.map((text, index) => ({ key: index, text, level: classifyLine(text) }))
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  error: 'text-destructive',
  warn: 'text-warning',
  info: 'text-foreground/80',
  debug: 'text-muted-foreground/70',
  plain: 'text-foreground/65',
}

export interface ListenerLogViewProps {
  logTail: string | null
  status: ListenerStatusDto
  /** Re-read now; wired to the follow toggle when it is switched back on. */
  onRefresh: () => void
}

/**
 * Which process states produce log output at all.
 *
 * 「跟随中」 is a claim that the view is tracking a live stream. For a plugin the user has switched
 * off there is no stream — the button was claiming to follow nothing, which is what made it read as
 * a lie. `stopped` and `failed` are the two states where nothing is writing.
 */
export function isLive(state: string | undefined): boolean {
  return state === 'starting' || state === 'running' || state === 'degraded'
}

export function ListenerLogView({ logTail, status, onRefresh }: ListenerLogViewProps): React.ReactElement {
  const { t } = useTranslation()
  const live = isLive(status.state)
  const [following, setFollowing] = React.useState(true)
  const [onlyProblems, setOnlyProblems] = React.useState(false)
  const [clearedAt, setClearedAt] = React.useState<number>(0)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  const lines = React.useMemo(() => {
    const all = parseLog(logTail)
    // 「Clear」 hides what was on screen at that moment without pretending the file changed:
    // the plugin still wrote it, and a re-read returns it. Hiding by index keeps the next poll
    // from resurrecting the lines the reader dismissed.
    return clearedAt > 0 ? all.slice(clearedAt) : all
  }, [logTail, clearedAt])

  const shown = React.useMemo(
    () => (onlyProblems ? lines.filter((line) => line.level === 'error' || line.level === 'warn') : lines),
    [lines, onlyProblems],
  )

  const problemCount = React.useMemo(
    () => lines.reduce((n, line) => (line.level === 'error' ? n + 1 : n), 0),
    [lines],
  )

  // Follow the tail: pinned to the bottom while `following`, released when the reader scrolls up.
  // `scrollHeight` after paint, because the new line is not laid out yet at effect time otherwise.
  React.useEffect(() => {
    if (!following) return
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [shown, following])

  const onScroll = (): void => {
    const node = scrollRef.current
    if (!node) return
    // 24px of slack: a programmatic pin and a human scroll are not distinguishable to the pixel.
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24
    setFollowing(atBottom)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/*
        Process facts belong above the text, not inside it: pid and restart count answer
        「is this thing alive」, which is the question that brings someone to this tab.
      */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border/60 px-5 py-2.5">
        <span className="text-[12.5px] tabular-nums text-muted-foreground">
          pid {status.pid ?? '—'}
        </span>
        <span className="text-border">·</span>
        <span className={`text-[12.5px] tabular-nums ${status.attempts > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
          {t('events.log.restarts', { count: status.attempts })}
        </span>
        {status.lastError && (
          <>
            <span className="text-border">·</span>
            <span className="max-w-[28rem] truncate text-[12.5px] text-destructive" title={status.lastError}>
              {status.lastError}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {problemCount > 0 && (
            <button
              type="button"
              onClick={() => setOnlyProblems((v) => !v)}
              aria-pressed={onlyProblems}
              className={`h-7 inline-flex items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors ${
                onlyProblems
                  ? 'bg-destructive/10 text-destructive'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
              }`}
              title={onlyProblems ? t('events.log.showAll') : t('events.log.onlyProblems')}
            >
              <AlertTriangle className="h-3 w-3" />
              {problemCount}
            </button>
          )}
          {/* No follow control when nothing is writing: there is no stream to track. */}
          {live ? (
            <button
              type="button"
              onClick={() => {
                // Turning follow back on re-reads immediately: the reader has been reading a stale
                // tail since they scrolled up, and waiting for the next tick looks like a dead click.
                if (!following) onRefresh()
                setFollowing((v) => !v)
              }}
              aria-pressed={following}
              className={`h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-[12.5px] transition-colors ${
                following
                  ? 'text-primary hover:bg-foreground/5'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
              }`}
              title={following ? t('events.log.pauseFollow') : t('events.log.resumeFollow')}
            >
              {following ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {following ? t('events.log.following') : t('events.log.paused')}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2 text-[12.5px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" aria-hidden />
              {t('events.log.stoppedNoNew')}
            </span>
          )}
          <button
            type="button"
            onClick={() => setClearedAt(parseLog(logTail).length)}
            disabled={lines.length === 0}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
            title={t('events.log.clearView')}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        // `flex-1` + `min-h-0` so the log owns the remaining height instead of the page
        // scrolling as a whole: a log that scrolls the page loses the header as you read.
        className="flex-1 min-h-0 overflow-auto px-5 py-2.5 font-mono text-[12.5px] leading-[1.75] selection:bg-primary/20"
        tabIndex={0}
        role="log"
        aria-label={t('events.log.ariaLabel')}
      >
        {shown.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            <ArrowDownToLine className="h-5 w-5 opacity-40" />
            <p className="text-[13px]">
              {onlyProblems && lines.length > 0 ? t('events.log.noProblems') : t('events.log.noOutput')}
            </p>
            {!status.lastError && lines.length === 0 && (
              <p className="text-[12.5px] opacity-70">{t('events.log.emptyHint')}</p>
            )}
          </div>
        ) : (
          shown.map((line) => (
            <div
              key={line.key}
              // `whitespace-pre-wrap` keeps the plugin's indentation (tracebacks need it) while
              // still wrapping long lines instead of forcing a horizontal scrollbar.
              className={`whitespace-pre-wrap break-words ${LEVEL_CLASS[line.level]}`}
            >
              {line.text || '\u00A0'}
            </div>
          ))
        )}
      </div>

      {/* Release note at the bottom, where the reader's eye already is after scrolling up. */}
      {live && !following && lines.length > 0 && (
        <button
          type="button"
          onClick={() => {
            onRefresh()
            setFollowing(true)
          }}
          className="h-8 shrink-0 inline-flex items-center justify-center gap-1.5 border-t border-border/60 text-[12.5px] text-primary transition-colors hover:bg-foreground/5"
        >
          <ArrowDownToLine className="h-3 w-3" />
          {t('events.log.jumpToLatest')}
        </button>
      )}
    </div>
  )
}
