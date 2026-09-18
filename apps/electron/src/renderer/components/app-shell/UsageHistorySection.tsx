/**
 * UsageHistorySection — Detail-page section showing usage count + history
 * for one source or skill.
 *
 * Displays "use count / last used" in an Info_Table, plus a toggle button
 * that expands a chronological call-history list. Each entry shows the time
 * and the title of the session that made the call; clicking an entry jumps
 * to that session. Deleted sessions show a toast explaining the record is
 * stale.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { History, ChevronDown, ChevronRight, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import {
  Info_Section,
  Info_Table,
} from '@/components/info'
import { useNavigation } from '@/contexts/NavigationContext'
import { cn } from '@/lib/utils'
import { formatShortRelativeTime } from '@/components/automations/utils'
import type { UsageStats, UsageRecord, Session } from '../../../shared/types'

export interface UsageHistorySectionProps {
  kind: 'source' | 'skill'
  slug: string
  workspaceId: string
  usageStats: UsageStats
}

export function UsageHistorySection({ kind, slug, workspaceId, usageStats }: UsageHistorySectionProps) {
  const { t } = useTranslation()
  const { navigateToSession } = useNavigation()

  const [expanded, setExpanded] = React.useState(false)
  const [records, setRecords] = React.useState<UsageRecord[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [sessionMap, setSessionMap] = React.useState<Map<string, string>>(new Map())

  const statsBucket = kind === 'source' ? usageStats.sources : usageStats.skills
  const stat = statsBucket[slug]
  const hasUsage = !!stat && stat.useCount > 0

  // Load history records lazily when expanded
  const loadHistory = React.useCallback(async () => {
    setLoading(true)
    try {
      const history = await window.electronAPI.getUsageHistory(workspaceId, kind, slug)
      setRecords(history)
    } catch (err) {
      console.error('[UsageHistorySection] Failed to load usage history:', err)
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId, kind, slug])

  const handleToggle = React.useCallback(() => {
    const next = !expanded
    setExpanded(next)
    if (next && records === null) {
      loadHistory()
    }
  }, [expanded, records, loadHistory])

  // Resolve session titles when history is loaded. Track load completion so
  // "deleted" can be distinguished from "still loading".
  const [sessionMapLoaded, setSessionMapLoaded] = React.useState(false)
  React.useEffect(() => {
    if (!records || records.length === 0) return
    let isMounted = true
    window.electronAPI.getSessions().then((sessions: Session[]) => {
      if (!isMounted) return
      const map = new Map<string, string>()
      for (const session of sessions) {
        if (session.workspaceId === workspaceId) {
          map.set(session.id, session.name || t('common.untitledSession'))
        }
      }
      setSessionMap(map)
      setSessionMapLoaded(true)
    }).catch((err: unknown) => {
      console.error('[UsageHistorySection] Failed to load session titles:', err)
      if (isMounted) setSessionMapLoaded(true)
    })
    return () => { isMounted = false }
  }, [records, workspaceId, t])

  const handleRecordClick = React.useCallback((sessionId: string | undefined) => {
    if (!sessionId) return
    if (!sessionMap.has(sessionId)) {
      toast.warning(t('usage.sessionDeleted'))
      return
    }
    navigateToSession(sessionId)
  }, [sessionMap, navigateToSession, t])

  return (
    <Info_Section
      title={t('usage.historyTitle')}
      description={t('usage.historyDescription')}
    >
      <Info_Table>
        <Info_Table.Row label={t('usage.useCountLabel')}>
          {hasUsage ? t('usage.timesUsed', { count: stat.useCount }) : t('usage.neverUsed')}
        </Info_Table.Row>
        {hasUsage && (
          <Info_Table.Row label={t('usage.lastUsedLabel')}>
            {formatShortRelativeTime(stat.lastUsedAt)}
          </Info_Table.Row>
        )}
      </Info_Table>

      {hasUsage && (
        <div className="px-4 pb-2">
          <button
            onClick={handleToggle}
            className="inline-flex items-center gap-1.5 h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors"
          >
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            {expanded ? t('usage.hideHistory') : t('usage.showHistory')}
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>

          {expanded && (
            <div className="mt-2 rounded-[8px] border border-border/40 overflow-hidden">
              {loading ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  {t('common.loading')}
                </div>
              ) : !records || records.length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  {t('usage.noHistory')}
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto divide-y divide-border/30">
                  {[...records].reverse().map((record) => {
                    const sessionTitle = record.sessionId ? sessionMap.get(record.sessionId) : undefined
                    // Only treat as deleted once the session list has loaded —
                    // otherwise a not-yet-loaded map would flash "deleted".
                    const sessionMissing = !!record.sessionId && sessionMapLoaded && !sessionMap.has(record.sessionId)
                    return (
                      <button
                        key={record.id}
                        onClick={() => handleRecordClick(record.sessionId)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors',
                          sessionMissing ? 'cursor-default opacity-60' : 'hover:bg-foreground/[0.03]',
                        )}
                      >
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {new Date(record.timestamp).toLocaleString()}
                        </span>
                        <span className={cn(
                          'flex-1 min-w-0 truncate text-sm',
                          sessionMissing && 'text-muted-foreground italic',
                        )}>
                          {record.sessionId
                            ? (sessionTitle ?? (sessionMissing ? t('usage.sessionDeleted') : t('common.loading')))
                            : t('usage.unknownSession')}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Info_Section>
  )
}
