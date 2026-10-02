/**
 * TextAttachmentEditOverlay - Editable preview for text attachments in the message input.
 *
 * Why this exists: pasted text blocks (`type: 'text'`, e.g. `pasted-text-N.txt`) have no
 * real OS path — they are synthetic clipboard attachments with content inline in
 * `attachment.text`. The app-level file preview (`onOpenFile`) requires a disk path,
 * so double-clicking a pasted text block did nothing. Disk-backed text files
 * (.md/.txt/.py/...) *do* resolve to a path and would open the read-only code preview,
 * but were not editable.
 *
 * This overlay covers both cases:
 *   - always shows the inline text content (fixes the dead double-click),
 *   - lets the user edit it; saving writes the new content back to `attachment.text`,
 *     which `storeAttachment` persists to the session attachments folder on send.
 *
 * Files that exist on disk are never modified — the path badge still offers
 * "Open" / "Reveal in {file manager}" through PreviewOverlay.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Info } from 'lucide-react'
import { PreviewOverlay } from '@craft-agent/ui'
import { isAbsolutePath } from '@/lib/drafts'
import { ShikiCodeEditor } from '@/components/shiki/ShikiCodeEditor'
import { Button } from '@/components/ui/button'
import type { FileAttachment } from '../../../../shared/types'

/** Extension → Shiki language name (aliases accepted: 'md' → 'markdown', etc.) */
const LANGUAGE_BY_EXT: Record<string, string> = {
  txt: 'text',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
  diff: 'diff',
}

/** Derive a Shiki highlight language from the attachment file name. */
function languageForAttachment(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'text'
  const ext = name.slice(dot + 1).toLowerCase()
  return LANGUAGE_BY_EXT[ext] ?? 'text'
}

export interface TextAttachmentEditOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** The text attachment being viewed/edited (undefined when closed) */
  attachment?: FileAttachment | null
  /** Optional session ID — scopes the badge's Open/Reveal to that session */
  sessionId?: string
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Called with the edited content when the user hits Save */
  onSave: (newText: string) => void
}

export function TextAttachmentEditOverlay({
  isOpen,
  onClose,
  attachment,
  sessionId,
  theme = 'light',
  onSave,
}: TextAttachmentEditOverlayProps) {
  const { t } = useTranslation()
  const initialText = attachment?.text ?? ''
  const [text, setText] = React.useState(initialText)

  // Re-seed the editor whenever a different attachment is opened
  React.useEffect(() => {
    setText(initialText)
  }, [initialText])

  const dirty = text !== initialText

  const handleSave = React.useCallback(() => {
    if (!attachment) return
    onSave(text)
    onClose()
  }, [attachment, onSave, onClose, text])

  const ext = attachment?.name ? attachment.name.split('.').pop()?.toUpperCase() : ''
  const typeLabel = ext && ext !== attachment?.name.toUpperCase() ? ext : 'TEXT'

  // Only surface the Open/Reveal-in-finder path badge for real disk files.
  // Pasted blocks carry a synthetic filename (e.g. `pasted-text-1.txt`) that
  // is not a filesystem path — the badge would offer actions that fail.
  const realPath =
    attachment && attachment.path && isAbsolutePath(attachment.path)
      ? attachment.path
      : undefined

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: FileText,
        label: typeLabel,
        variant: 'blue',
      }}
      filePath={realPath}
      sessionId={sessionId}
      title={attachment?.name}
      headerActions={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!dirty}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="px-6 pb-5">
        <div className="mx-auto w-full max-w-[850px]">
          <div className="overflow-hidden rounded-[10px] border border-foreground/5 bg-background shadow-minimal">
            <ShikiCodeEditor
              value={text}
              onChange={setText}
              language={languageForAttachment(attachment?.name ?? '')}
              className="h-[55vh]"
            />
          </div>
          <div className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground/70">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('attachment.editedHint')}</span>
          </div>
        </div>
      </div>
    </PreviewOverlay>
  )
}