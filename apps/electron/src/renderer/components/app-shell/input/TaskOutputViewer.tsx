/**
 * TaskOutputViewer — live output for one background task, styled as a terminal.
 *
 * A proper terminal chrome instead of a bare code block: a header bar carries
 * the task title, the raw command (for shells), a live/final status badge and
 * copy/close actions; the body is a dark monospace log that scrolls with the
 * stream.
 *
 * Polling stops as soon as the task is terminal — a finished task's output is
 * immutable, so continuing to poll would be pure waste.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Loader2, Terminal, X } from 'lucide-react'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { BackgroundTask } from '@/atoms/sessions'

const POLL_MS = 1000

export interface TaskOutputViewerProps {
  /** Task to display; null closes the viewer. */
  task: BackgroundTask | null
  onClose: () => void
}

export function TaskOutputViewer({ task, onClose }: TaskOutputViewerProps) {
  const { t } = useTranslation()
  const [output, setOutput] = React.useState<string>('')
  const [loading, setLoading] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const taskId = task?.id ?? null
  const isRunning = task?.status === 'running' || task?.status === 'stale'
  const title = task?.intent || task?.command || taskId || ''

  React.useEffect(() => {
    if (!taskId) return
    let cancelled = false

    const read = async () => {
      try {
        const text = await window.electronAPI.getTaskOutput(taskId)
        if (!cancelled) setOutput(text ?? '')
      } catch {
        // Keep the last good text; a transient read failure is not worth a toast.
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    setLoading(true)
    void read()
    // A terminal task never changes again — read once and stop.
    if (!isRunning) {
      return () => { cancelled = true }
    }
    const timer = setInterval(read, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [taskId, isRunning])

  // Auto-stick to the bottom while live, so the freshest lines stay visible.
  React.useEffect(() => {
    if (!isRunning || !bodyRef.current) return
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [output, isRunning])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(output)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be unavailable in some sandboxed contexts; ignore.
    }
  }, [output])

  return (
    <Dialog open={taskId !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="max-w-3xl gap-0 p-0 overflow-hidden">
        <DialogTitle className="sr-only">{title || t('chat.taskOutputTitle', '任务输出')}</DialogTitle>
        {/* Header bar */}
        <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-foreground/70">
            <Terminal className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium leading-tight">{title}</div>
            {task?.command && (
              <div className="truncate font-mono text-[11px] text-muted-foreground leading-tight">
                {task.command}
              </div>
            )}
          </div>

          {/* Status badge */}
          <span
            className={cn(
              'shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
              isRunning
                ? 'bg-info/10 text-info'
                : 'bg-foreground/5 text-muted-foreground',
            )}
          >
            {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
            {isRunning
              ? t('chat.taskOutputLive', '实时输出')
              : t('chat.taskOutputFinal', '最终输出')}
          </span>

          {/* Copy */}
          <button
            type="button"
            onClick={handleCopy}
            disabled={!output}
            title={copied ? t('common.copied') : t('terminal.copyOutput')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
          >
            {copied
              ? <Check className="h-3.5 w-3.5 text-green-500" />
              : <Copy className="h-3.5 w-3.5" />}
          </button>

          {/* Close */}
          <button
            type="button"
            onClick={onClose}
            title={t('common.close')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Terminal body */}
        <div
          ref={bodyRef}
          className="max-h-[60vh] overflow-auto bg-[#0d1117] px-4 py-3 font-mono text-xs text-[#e6edf3]"
        >
          {output ? (
            <pre className="whitespace-pre-wrap break-words">{output}</pre>
          ) : (
            <span className="text-[#8b949e]">
              {loading
                ? t('chat.taskOutputLoading', '读取中…')
                : t('chat.taskOutputEmpty', '（暂无输出）')}
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
