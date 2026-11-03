/**
 * Events navigator column, "listeners" section.
 *
 * P1 shows the live ingest endpoint and a copy-paste example: that is exactly
 * what a hand-written listener needs. The listener catalog (manifest parsing,
 * dependency checks, enable switches) lands in P2, so this panel deliberately
 * does not pretend to install anything yet.
 */

import * as React from 'react'
import { Check, Copy, Radio, ShieldCheck } from 'lucide-react'

export interface EventsListenersPanelProps {
  workspaceId: string
  className?: string
}

interface Status {
  listening: boolean
  host: string | null
  port: number | null
  baseUrl: string | null
}

function CopyButton({ value, label }: { value: string; label: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="h-6 px-1.5 inline-flex items-center gap-1 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? '已复制' : label}
    </button>
  )
}

export function EventsListenersPanel({
  workspaceId,
  className,
}: EventsListenersPanelProps): React.ReactElement {
  const [status, setStatus] = React.useState<Status | null>(null)
  const [counts, setCounts] = React.useState<Record<string, number>>({})

  React.useEffect(() => {
    if (!workspaceId) return
    window.electronAPI
      .getEventCounts(workspaceId)
      .then((result) => {
        setStatus(result.status)
        setCounts(result.counts ?? {})
      })
      .catch((err: unknown) => console.error('[EventsListenersPanel] status failed:', err))
  }, [workspaceId])

  // Keep the counts fresh as events land.
  React.useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onEventsChanged((wsId, event) => {
      if (wsId !== workspaceId) return
      setCounts((prev) => ({ ...prev, [event.source]: (prev[event.source] ?? 0) + 1 }))
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId])

  const sources = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const exampleUrl = status?.baseUrl ? `${status.baseUrl}/events/my-listener` : 'http://127.0.0.1:<port>/events/my-listener'

  const curl = [
    `curl -X POST "${exampleUrl}" \\`,
    `  -H "Authorization: Bearer $CRAFT_EVENTS_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"type":"mail.received","title":"张三 · 合同确认","summary":"请确认付款条款"}'`,
  ].join('\n')

  return (
    <div className={className ? `flex flex-col h-full overflow-y-auto ${className}` : 'flex flex-col h-full overflow-y-auto'}>
      <div className="px-3 py-3 border-b border-border space-y-2">
        <div className="flex items-center gap-1.5 text-xs">
          <Radio className={`h-3.5 w-3.5 ${status?.listening ? 'text-primary' : 'text-muted-foreground'}`} />
          <span className="text-muted-foreground">接收地址</span>
          <span className="ml-auto font-mono text-[11px]">
            {status?.listening ? `${status.host}:${status.port}` : '未监听'}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          本地监听器把事件 POST 到这个地址即可。地址与本机端口绑定，不对外网开放。
        </p>
      </div>

      <div className="px-3 py-3 space-y-2 border-b border-border">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">接入示例</span>
          <span className="ml-auto" />
          <CopyButton value={curl} label="复制 curl" />
        </div>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/40 rounded-md p-2">
          {curl}
        </pre>
        <p className="text-[11px] text-muted-foreground">
          请求必须带 <code className="font-mono">Authorization: Bearer</code>（启动监听器时由 Craft 注入
          <code className="font-mono"> CRAFT_EVENTS_TOKEN</code>）与
          <code className="font-mono"> Content-Type: application/json</code>。
        </p>
      </div>

      <div className="px-3 py-3 space-y-2">
        <span className="text-xs font-medium">已接入的来源</span>
        {sources.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">还没有任何来源发过事件。</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {sources.map(([source, count]) => (
              <div key={source} className="rounded-md border border-border p-2 space-y-0.5">
                <div className="text-xs font-medium truncate">{source}</div>
                <div className="text-[11px] text-muted-foreground">{count} 条事件</div>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground pt-1">
          监听器目录、manifest 与依赖安装在 P2 提供；当前版本可直接用自己的脚本接入。
        </p>
      </div>
    </div>
  )
}
