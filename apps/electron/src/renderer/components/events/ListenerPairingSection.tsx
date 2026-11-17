/**
 * 渠道配对 — the detail-page content of channel pairing.
 *
 * Pairing is per-channel and a channel belongs to exactly one platform
 * plugin (`message://<platform>/<chatId>`), so this content lives inside a
 * Section on the plugin's own detail page, not the task board. The parent
 * gates rendering on the DTO's derived `channels` flag
 * (isMessagingListener: an action with `repliesToOrigin`), so only
 * messaging plugins ever show it — one shared rule, no per-platform
 * adapter code.
 *
 * A code generated here is single-use, lives one minute and is redeemed
 * in-chat with `/pair <code>`; the paired list below shows the channels
 * that belong to THIS plugin only (prefix-filtered).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

export interface ListenerPairingSectionProps {
  workspaceId: string
  listenerId: string
}

export function ListenerPairingSection({
  workspaceId,
  listenerId,
}: ListenerPairingSectionProps): React.ReactElement {
  const { t } = useTranslation()
  const [channels, setChannels] = React.useState<Array<{ channelKey: string; pairedAt: number }>>([])
  const [code, setCode] = React.useState<{ value: string; expiresAt: number } | null>(null)
  const [now, setNow] = React.useState(0)
  /** Display names the plugin itself resolves for its channel keys. */
  const [labels, setLabels] = React.useState<Record<string, string>>({})

  // Pairing happens in-chat (`/pair <code>`), not on this page — so the
  // list must keep refreshing like the outbox does: five-second poll,
  // the same cadence the dispatcher uses. Channel display names come from
  // the plugin's control service in the same pass — the host never learns
  // platform vocabulary, it just renders what the plugin answers.
  React.useEffect(() => {
    let cancelled = false
    const load = () => {
      window.electronAPI
        .pairingList(workspaceId)
        .then((rows) => {
          if (cancelled) return
          setChannels(rows)
          const keys = rows
            .filter((row) => row.pairedAt > 0 && row.channelKey.startsWith(`message://${listenerId}/`))
            .map((row) => row.channelKey)
          if (keys.length === 0) {
            setLabels({})
            return
          }
          window.electronAPI
            .channelLabels(workspaceId, listenerId, keys)
            .then(setLabels)
            .catch(() => setLabels({}))
        })
        .catch(() => undefined)
    }
    load()
    const timer = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [workspaceId, listenerId])

  React.useEffect(() => {
    if (!code) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code])

  // Only real pairings count as 已配对渠道: the same file also holds
  // prompt-cooldown records with pairedAt: 0, and those must not appear.
  const ownChannels = channels
    .filter((row) => row.pairedAt > 0)
    .filter((row) => row.channelKey.startsWith(`message://${listenerId}/`))

  // The code's job is done once this plugin's channel is paired: stop
  // showing the half-expired credential on screen.
  React.useEffect(() => {
    if (ownChannels.length > 0) setCode(null)
  }, [ownChannels.length])
  const remaining = code ? Math.max(0, Math.ceil((code.expiresAt - (now || Date.now())) / 1000)) : 0
  const activeCode = code !== null && remaining > 0 ? code : null

  const generate = async (): Promise<void> => {
    try {
      const generated = await window.electronAPI.pairingGenerate(workspaceId)
      setNow(Date.now())
      setCode({ value: generated.code, expiresAt: generated.expiresAt })
    } catch {
      // Generation failed: the button stays, no code appears.
    }
  }

  const unpair = (channelKey: string): void => {
    void window.electronAPI
      .pairingUnpair(workspaceId, channelKey)
      .then(() => setChannels((prev) => prev.filter((row) => row.channelKey !== channelKey)))
      .catch(() => undefined)
  }

  return (
    <>
      <p className="mb-3 text-[13px] leading-5 text-muted-foreground">
        {t('events.listener.pairing.hint', { seconds: 60 })}
      </p>

      {activeCode ? (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
          <code className="select-all break-all font-mono text-lg tracking-wider text-foreground">
            {activeCode.value}
          </code>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{remaining}s</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void generate()}
          className="mb-3 inline-flex min-h-9 items-center gap-2 rounded-md border border-border/60 px-3 text-xs text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('events.listener.pairing.get')}
        </button>
      )}

      {ownChannels.length === 0 ? (
        <p className="text-[13px] leading-5 text-muted-foreground">{t('events.listener.pairing.none')}</p>
      ) : (
        <>
          <h3 className="mb-1.5 text-xs text-muted-foreground">{t('events.listener.pairing.pairedChannels')}</h3>
          <ul className="space-y-1.5">
            {ownChannels.map((row) => (
              <li key={row.channelKey} className="flex min-w-0 items-center gap-2 text-[13px] leading-5">
                {labels[row.channelKey] ? (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-foreground" title={row.channelKey}>
                      {labels[row.channelKey]}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground/70">{row.channelKey}</div>
                  </div>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground/90" title={row.channelKey}>
                    {row.channelKey}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => unpair(row.channelKey)}
                  className="ml-auto shrink-0 text-xs text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('events.listener.pairing.unpair')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}