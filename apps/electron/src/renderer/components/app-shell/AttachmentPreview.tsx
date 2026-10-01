import * as React from "react"
import { X, Image as ImageIcon } from "lucide-react"
import { Spinner, FileTypeIcon, getFileTypeLabel } from "@craft-agent/ui"
import { cn } from "@/lib/utils"
import type { FileAttachment } from "../../../shared/types"

// Re-export for backward compatibility
export { FileTypeIcon, getFileTypeLabel }

interface AttachmentPreviewProps {
  attachments: FileAttachment[]
  onRemove: (index: number) => void
  /** Double-click (or Enter/Space) to preview the attachment.
   * Images open the in-input image overlay; other previewable file
   * types are routed through the app-level file preview. */
  onDoubleClick?: (index: number) => void
  disabled?: boolean
  loadingCount?: number
}

/**
 * AttachmentPreview - ChatGPT-style attachment preview strip
 *
 * Shows attached files as small bubbles above the textarea:
 * - Image thumbnails for image files (48x48px)
 * - Icon + filename for text/PDF/code files
 * - X button on hover to remove
 * - Horizontally scrollable when many files
 * - Loading placeholders while files are being read
 */
export function AttachmentPreview({
  attachments,
  onRemove,
  onDoubleClick,
  disabled,
  loadingCount = 0,
}: AttachmentPreviewProps) {
  if (attachments.length === 0 && loadingCount === 0) return null

  return (
    <div className="flex gap-2 px-4 py-3 border-b border-border/50 overflow-x-auto">
      {attachments.map((attachment, index) => (
        <AttachmentBubble
          key={`${attachment.path}-${index}`}
          attachment={attachment}
          onRemove={() => onRemove(index)}
          onDoubleClick={onDoubleClick ? () => onDoubleClick(index) : undefined}
          disabled={disabled}
        />
      ))}
      {/* Loading placeholders */}
      {Array.from({ length: loadingCount }).map((_, i) => (
        <LoadingBubble key={`loading-${i}`} />
      ))}
    </div>
  )
}

function LoadingBubble() {
  return (
    <div className="h-16 w-16 rounded-[8px] bg-background shadow-minimal flex items-center justify-center shrink-0">
      <Spinner className="text-muted-foreground" />
    </div>
  )
}

interface AttachmentBubbleProps {
  attachment: FileAttachment
  onRemove: () => void
  onDoubleClick?: () => void
  disabled?: boolean
}

function AttachmentBubble({ attachment, onRemove, onDoubleClick, disabled }: AttachmentBubbleProps) {
  const isImage = attachment.type === 'image'
  const hasThumbnail = !!attachment.thumbnailBase64
  const hasImageBase64 = isImage && attachment.base64
  const canPreview = !disabled && !!onDoubleClick

  const handlePreviewKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canPreview) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onDoubleClick?.()
    }
  }


  // For images, use full base64; for docs, use Quick Look thumbnail
  const imageSrc = hasImageBase64
    ? `data:${attachment.mimeType};base64,${attachment.base64}`
    : hasThumbnail
      ? `data:image/png;base64,${attachment.thumbnailBase64}`
      : null

  return (
    <div className="relative group shrink-0 select-none">
      {/* Remove button - appears on hover */}
      {!disabled && (
        <button
          onClick={onRemove}
          data-touch-reveal="true"
          className={cn(
            "absolute -top-1.5 -right-1.5 z-10",
            "h-5 w-5 rounded-full",
            "bg-muted-foreground/90 text-background",
            "flex items-center justify-center",
            "opacity-0 group-hover:opacity-100 transition-opacity",
            "hover:bg-muted-foreground"
          )}
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {isImage ? (
        /* IMAGE: Square thumbnail only */
        <div
          className={cn(
            "h-16 w-16 rounded-[8px] overflow-hidden bg-background shadow-minimal",
            canPreview && "cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          )}
          role={canPreview ? "button" : undefined}
          tabIndex={canPreview ? 0 : undefined}
          aria-label={canPreview ? attachment.name : undefined}
          onDoubleClick={canPreview ? () => onDoubleClick?.() : undefined}
          onKeyDown={canPreview ? handlePreviewKeyDown : undefined}
        >
          {imageSrc ? (
            <img src={imageSrc} alt={attachment.name} className="h-full w-full object-cover" draggable={false} />
          ) : (
            <div className="h-full w-full flex items-center justify-center">
              <ImageIcon className="h-5 w-5 text-muted-foreground" />
            </div>
          )}
        </div>
      ) : (
        /* DOCUMENT: Bubble with thumbnail/icon + 2-line text */
        <div
          className={cn(
            "h-16 flex items-center gap-2.5 rounded-[8px] bg-foreground/5 pl-1.5 pr-3",
            canPreview && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          )}
          role={canPreview ? "button" : undefined}
          tabIndex={canPreview ? 0 : undefined}
          aria-label={canPreview ? attachment.name : undefined}
          onDoubleClick={canPreview ? () => onDoubleClick?.() : undefined}
          onKeyDown={canPreview ? handlePreviewKeyDown : undefined}
        >
          {/* A4-like preview */}
          <div className="h-12 w-9 rounded-[6px] overflow-hidden bg-background shadow-minimal flex items-center justify-center shrink-0">
            {hasThumbnail ? (
              <img
                src={`data:image/png;base64,${attachment.thumbnailBase64}`}
                alt={attachment.name}
                className="h-full w-full object-cover object-top"
              />
            ) : (
              <FileTypeIcon type={attachment.type} mimeType={attachment.mimeType} className="h-5 w-5" />
            )}
          </div>
          {/* 2-line filename + type */}
          <div className="flex flex-col min-w-0 max-w-[120px]">
            <span className="text-xs font-medium line-clamp-2 break-all" title={attachment.name}>
              {attachment.name}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {getFileTypeLabel(attachment.type, attachment.mimeType, attachment.name)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
