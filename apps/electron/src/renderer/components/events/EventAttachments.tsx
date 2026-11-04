/**
 * Attachments of one event.
 *
 * The point of this component is *parity with sessions*: the same
 * `classifyFile` decides what can be previewed, the same `FileTypeIcon` /
 * `getFileTypeLabel` render the row, and the same image/PDF overlays show the
 * content. Anything a session cannot preview (Office documents, archives)
 * falls back to opening with the OS default app — exactly like a session does.
 *
 * Images the mail embeds (`inline`) are excluded here: they belong to the body
 * and are drawn in place by `EventBody`.
 */

import * as React from 'react'
import { ChevronDown, ChevronRight, ExternalLink, Paperclip } from 'lucide-react'
import {
  classifyFile,
  FileTypeIcon,
  getFileTypeLabel,
  ImagePreviewOverlay,
  PDFPreviewOverlay,
  type FilePreviewType,
} from '@craft-agent/ui'
import type { AttachmentType } from '@craft-agent/core'
import type { EventAttachmentContentDto, EventAttachmentDto } from '@craft-agent/shared/protocol/dto'

/** `classifyFile` speaks preview types; the icon helpers speak attachment types. */
const ICON_TYPE: Record<FilePreviewType, AttachmentType> = {
  image: 'image',
  pdf: 'pdf',
  code: 'text',
  markdown: 'text',
  json: 'text',
  text: 'text',
}

const PREVIEW_LABEL: Record<FilePreviewType, string> = {
  image: '图片',
  pdf: 'PDF',
  code: '代码',
  markdown: 'Markdown',
  json: 'JSON',
  text: '文本',
}

/** Read mode each preview type needs from the main process. */
const READ_MODE: Record<FilePreviewType, 'text' | 'dataUrl' | 'bytes'> = {
  image: 'dataUrl',
  pdf: 'bytes',
  code: 'text',
  markdown: 'text',
  json: 'text',
  text: 'text',
}

function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export interface EventAttachmentsProps {
  workspaceId: string
  eventId: string
  attachments: EventAttachmentDto[]
  theme?: 'light' | 'dark'
}

export function EventAttachments({
  workspaceId,
  eventId,
  attachments,
  theme = 'dark',
}: EventAttachmentsProps): React.ReactElement | null {
  const [expanded, setExpanded] = React.useState<number | null>(null)
  const [content, setContent] = React.useState<Record<number, EventAttachmentContentDto | { error: string }>>({})
  const [loading, setLoading] = React.useState<number | null>(null)
  const [imageIndex, setImageIndex] = React.useState<number | null>(null)
  const [pdfIndex, setPdfIndex] = React.useState<number | null>(null)

  /** Keep the original array index: the RPC addresses attachments by position. */
  const items = React.useMemo(
    () =>
      attachments
        .map((attachment, index) => ({ attachment, index }))
        .filter((entry) => entry.attachment.inline !== true),
    [attachments],
  )

  const load = React.useCallback(
    async (index: number, mode: 'text' | 'dataUrl' | 'bytes') => {
      setLoading(index)
      try {
        const result = await window.electronAPI.readEventAttachment(workspaceId, eventId, index, mode)
        setContent((prev) => ({ ...prev, [index]: result }))
      } catch (error) {
        setContent((prev) => ({
          ...prev,
          [index]: { error: error instanceof Error ? error.message : String(error) },
        }))
      } finally {
        setLoading(null)
      }
    },
    [workspaceId, eventId],
  )

  if (items.length === 0) return null

  const toggle = (index: number) => {
    if (expanded === index) {
      setExpanded(null)
      return
    }
    setExpanded(index)
    const attachment = attachments[index]
    if (!attachment) return
    const preview = classifyFile(attachment.path).type
    // PDFs open in their own overlay; everything else reads bytes/text inline.
    if (preview === 'pdf') {
      setPdfIndex(index)
      return
    }
    if (!content[index]) void load(index, preview ? READ_MODE[preview] : 'text')
  }

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-2">
        <Paperclip className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] font-medium text-foreground">附件</span>
        <span className="text-[12px] text-muted-foreground">{items.length}</span>
      </div>

      <div className="rounded-lg border border-border/70 divide-y divide-border/60 overflow-hidden">
        {items.map(({ attachment, index }) => {
          const preview = classifyFile(attachment.path).type
          const iconType = preview ? ICON_TYPE[preview] : 'unknown'
          const isOpen = expanded === index
          const item = content[index]
          const kind = preview ? PREVIEW_LABEL[preview] : getFileTypeLabel(iconType, attachment.mime, attachment.name)

          return (
            <div key={`${attachment.path}-${index}`} className="bg-muted/20">
              <button
                type="button"
                onClick={() => toggle(index)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-foreground/[0.04] transition-colors"
              >
                <FileTypeIcon type={iconType} mimeType={attachment.mime} className="h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] text-foreground truncate">{attachment.name}</span>
                  <span className="block text-[12px] text-muted-foreground mt-0.5">
                    {kind}
                    {attachment.size ? ` · ${formatSize(attachment.size)}` : ''}
                    {!preview ? ' · 无法内联预览' : ''}
                  </span>
                </span>
                {preview ? (
                  isOpen ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  )
                ) : (
                  <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </button>

              {isOpen && (
                <div className="px-3 pb-3">
                  {loading === index && <p className="text-[12.5px] text-muted-foreground">正在读取…</p>}

                  {item && 'error' in item && (
                    <p className="text-[12.5px] text-destructive">读取失败：{item.error}</p>
                  )}

                  {item && !('error' in item) && item.kind === 'unsupported' && (
                    <div className="flex items-center gap-3">
                      <p className="text-[12.5px] text-muted-foreground flex-1">{item.reason}</p>
                      {item.bytes > 0 && (
                        <button
                          type="button"
                          onClick={() => void window.electronAPI.openEventAttachment(workspaceId, eventId, index)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-foreground/[0.06] transition-colors"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          用默认程序打开
                        </button>
                      )}
                    </div>
                  )}

                  {item && !('error' in item) && item.kind === 'image' && (
                    <img
                      src={item.dataUrl}
                      alt={attachment.name}
                      className="max-h-[420px] max-w-full rounded-md border border-border/60 object-contain bg-background"
                    />
                  )}

                  {item && !('error' in item) && item.kind === 'text' && (
                    <>
                      <pre className="max-h-[420px] overflow-auto rounded-md bg-background/70 border border-border/60 p-3 text-[12.5px] leading-6 whitespace-pre-wrap break-words font-mono">
                        {item.text}
                      </pre>
                      {item.truncated && (
                        <p className="mt-1 text-[11.5px] text-muted-foreground">
                          内容较长，仅显示前 2 MB；完整内容请用默认程序打开。
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {imageIndex !== null && attachments[imageIndex] && (
        <ImagePreviewOverlay
          isOpen
          onClose={() => setImageIndex(null)}
          filePath={attachments[imageIndex]!.path}
          title={attachments[imageIndex]!.name}
          theme={theme}
          loadDataUrl={async (path) => {
            const index = attachments.findIndex((a) => a.path === path)
            const target = index >= 0 ? index : imageIndex
            const result = await window.electronAPI.readEventAttachment(workspaceId, eventId, target, 'dataUrl')
            if (result.kind !== 'image') throw new Error('not an image')
            return result.dataUrl
          }}
        />
      )}

      {pdfIndex !== null && attachments[pdfIndex] && (
        <PDFPreviewOverlay
          isOpen
          onClose={() => setPdfIndex(null)}
          filePath={attachments[pdfIndex]!.path}
          theme={theme}
          loadPdfData={async (path) => {
            const index = attachments.findIndex((a) => a.path === path)
            const target = index >= 0 ? index : pdfIndex
            const result = await window.electronAPI.readEventAttachment(workspaceId, eventId, target, 'bytes')
            if (result.kind !== 'pdf') throw new Error('not a pdf')
            return result.data
          }}
        />
      )}
    </div>
  )
}
