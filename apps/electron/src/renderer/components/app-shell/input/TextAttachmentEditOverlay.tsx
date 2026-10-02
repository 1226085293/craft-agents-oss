/**
 * TextAttachmentEditOverlay - Preview + edit for text attachments in the message input.
 *
 * Why this exists: pasted text blocks (`type: 'text'`, e.g. `pasted-text-N.txt`) have no
 * real OS path — they are synthetic clipboard attachments with content inline in
 * `attachment.text`. The app-level file preview (`onOpenFile`) requires a disk path,
 * so double-clicking a pasted text block did nothing. Disk-backed text files
 * (.md/.txt/.py/...) *do* resolve to a path and would open the read-only code preview,
 * but were not editable.
 *
 * This overlay covers both cases with a read/edit split:
 *   - view state is the familiar code-preview presentation (PreviewOverlay +
 *     ContentFrame + ShikiCodeViewer, same layout as CodePreviewOverlay),
 *   - hitting "Edit" swaps the live editor in; saving writes the new content back to
 *     `attachment.text` (plus size/base64), which `storeAttachment` persists to the
 *     session attachments folder when the message is sent.
 *
 * Files on disk are never modified — the path badge still offers "Open" /
 * "Reveal in {file manager}" through PreviewOverlay, and the edit hint reminds the
 * user that only the sent copy changes.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Info, PenLine } from 'lucide-react'
import { ContentFrame, PreviewOverlay, ShikiCodeViewer } from '@craft-agent/ui'
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
  const [editing, setEditing] = React.useState(false)

  // Re-seed whenever a different attachment is opened, and start in view mode
  React.useEffect(() => {
    setText(initialText)
    setEditing(false)
  }, [initialText])

  const dirty = text !== initialText

  const handleSave = React.useCallback(() => {
    if (!attachment) return
    onSave(text)
    onClose()
  }, [attachment, onSave, onClose, text])

  const handleCancelEdit = React.useCallback(() => {
    setText(initialText)
    setEditing(false)
  }, [initialText])

  const ext = attachment?.name ? attachment.name.split('.').pop()?.toUpperCase() : ''
  const typeLabel = ext && ext !== attachment?.name.toUpperCase() ? ext : 'TEXT'

  // Only surface the Open/Reveal-in-finder path badge for real disk files.
  // Pasted blocks carry a synthetic filename (e.g. `pasted-text-1.txt`) that
  // is not a filesystem path — the badge would offer actions that fail.
  const realPath =
    attachment && attachment.path && isAbsolutePath(attachment.path)
      ? attachment.path
      : undefined

  const language = languageForAttachment(attachment?.name ?? '')

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={
        editing
          ? { icon: PenLine, label: typeLabel, variant: 'amber' }
          : { icon: BookOpen, label: typeLabel, variant: 'blue' }
      }
      filePath={realPath}
      sessionId={sessionId}
      title={attachment?.name}
      className="bg-foreground-3"
      headerActions={
        editing ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCancelEdit}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!dirty}>
              {t('common.save')}
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={() => setEditing(true)}>
            <PenLine className="mr-1.5 h-3.5 w-3.5" />
            {t('common.edit')}
          </Button>
        )
      }
    >
      <ContentFrame title={t('overlay.code')} fitContent minWidth={850}>
        {editing ? (
          <div>
            <ShikiCodeEditor
              value={text}
              onChange={setText}
              language={language}
              className="h-[55vh]"
            />
            <div className="mt-2 flex items-start gap-1.5 px-4 pb-1 text-xs text-muted-foreground/70">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('attachment.editedHint')}</span>
            </div>
          </div>
        ) : (
          <ShikiCodeViewer
            code={text}
            language={language}
            filePath={attachment?.name}
            theme={theme}
          />
        )}
      </ContentFrame>
    </PreviewOverlay>
  )
}