/**
 * TextAttachmentEditOverlay - Preview + edit for text attachments in the message input.
 *
 * Why this exists: pasted text blocks (`type: 'text'`, e.g. `pasted-text-N.txt`) have no
 * real OS path — they are synthetic clipboard attachments with content inline in
 * `attachment.text`. The app-level file preview (`onOpenFile`) requires a disk path,
 * so double-clicking a pasted text block did nothing.
 *
 * Presentation (mirrors the original app-level previews so nothing "changes" for the user):
 *   - .md / .mdx files → rendered Markdown document card, same layout as
 *     DocumentFormattedMarkdownOverlay (the preview that `onOpenFile` used to open).
 *   - other text files → line-numbered code viewer, same layout as CodePreviewOverlay.
 *
 * Edit mode:
 *   - Markdown → split view: source editor with line numbers on the left, live rendered
 *     preview on the right (debounced).
 *   - Other text → full-width editor with line numbers and a status bar.
 *   Saving writes the new content back to `attachment.text` (plus size/base64), which
 *   `storeAttachment` persists to the session attachments folder when the message is sent.
 *   Disk files are never modified in place.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, PenLine } from 'lucide-react'
import { ContentFrame, PreviewOverlay, ShikiCodeViewer } from '@craft-agent/ui'
import { Markdown } from '@/components/markdown'
import { isAbsolutePath } from '@/lib/drafts'
import { ShikiCodeEditor } from '@/components/shiki/ShikiCodeEditor'
import { Button } from '@/components/ui/button'
import type { FileAttachment } from '../../../../shared/types'

/** Markdown-capable extensions (superset of classifyFile's md|mdx set) */
const MARKDOWN_EXT = new Set(['md', 'mdx', 'markdown'])

/** Extension → Shiki language name (aliases accepted: 'md' → 'markdown', etc.) */
const LANGUAGE_BY_EXT: Record<string, string> = {
  txt: 'text',
  log: 'text',
  md: 'markdown',
  mdx: 'markdown',
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

function getExt(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** Derive a Shiki highlight language from the attachment file name. */
function languageForAttachment(name: string): string {
  return LANGUAGE_BY_EXT[getExt(name)] ?? 'text'
}

/** Small debounce for the live preview pane (avoids re-rendering heavy markdown per keystroke) */
function useDebouncedValue<T>(value: T, delay = 150): T {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
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
  /** URL clicks inside rendered markdown */
  onUrlClick?: (url: string) => void
  /** File link clicks inside rendered markdown */
  onFileClick?: (path: string) => void
}

export function TextAttachmentEditOverlay({
  isOpen,
  onClose,
  attachment,
  sessionId,
  theme = 'light',
  onSave,
  onUrlClick,
  onFileClick,
}: TextAttachmentEditOverlayProps) {
  const { t } = useTranslation()
  const initialText = attachment?.text ?? ''
  const [text, setText] = React.useState(initialText)
  const [editing, setEditing] = React.useState(false)
  // Debounced copy used only for the live preview pane (editor stays snappy)
  const previewText = useDebouncedValue(text, 150)

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

  // Ctrl/Cmd+S saves while editing
  React.useEffect(() => {
    if (!editing || !isOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editing, isOpen, handleSave])

  const name = attachment?.name ?? ''
  const ext = getExt(name)
  const typeLabel = ext ? ext.toUpperCase() : 'TEXT'
  const isMarkdown = MARKDOWN_EXT.has(ext)

  // Only surface the Open/Reveal-in-finder path badge for real disk files.
  // Pasted blocks carry a synthetic filename (e.g. `pasted-text-1.txt`) that
  // is not a filesystem path — the badge would offer actions that fail.
  const realPath =
    attachment && attachment.path && isAbsolutePath(attachment.path)
      ? attachment.path
      : undefined

  const language = languageForAttachment(name)

  /** Shared status bar under the editors: language badge + "sent copy only" hint */
  const statusBar = (
    <div className="mt-2.5 flex items-center justify-between gap-4 rounded-[8px] border border-foreground/5 bg-foreground/3 px-3 py-1.5 text-[11px] text-muted-foreground/80">
      <span className="shrink-0 font-semibold tracking-wide text-foreground/70">{typeLabel}</span>
      <span className="min-w-0 text-right leading-snug">{t('attachment.editedHint')}</span>
    </div>
  )

  /**
   * Markdown view: rendered document card — same layout as
   * DocumentFormattedMarkdownOverlay (the original .md preview).
   */
  const markdownDocument = (
    <div className="px-6 py-10">
      <div className="mx-auto my-auto w-full max-w-[960px]">
        <div className="bg-background rounded-[16px] shadow-strong">
          <div className="px-10 pt-8 pb-8 text-sm">
            <Markdown mode="minimal" onUrlClick={onUrlClick} onFileClick={onFileClick}>
              {text}
            </Markdown>
          </div>
        </div>
      </div>
    </div>
  )

  /** Code view: line-numbered viewer, same layout as CodePreviewOverlay */
  const codeViewer = (
    <ContentFrame title={t('overlay.code')} fitContent minWidth={850}>
      <ShikiCodeViewer
        code={text}
        language={language}
        filePath={name}
        theme={theme}
      />
    </ContentFrame>
  )

  /** Markdown edit: split view — source editor (line numbers) + live rendered preview */
  const markdownSplitEditor = (
    <div className="px-6 pb-5">
      <div className="mx-auto w-full max-w-[1100px]">
        <div className="flex h-[55vh] min-h-[320px] overflow-hidden rounded-[12px] border border-border/40 bg-background shadow-minimal">
          <div className="min-w-0 flex-1 border-r border-border/40">
            <ShikiCodeEditor
              value={text}
              onChange={setText}
              language="markdown"
              showLineNumbers
              className="h-full"
            />
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="h-full min-h-full bg-muted/20 px-8 py-6 text-sm">
              <Markdown mode="minimal">{previewText}</Markdown>
            </div>
          </div>
        </div>
        {statusBar}
      </div>
    </div>
  )

  /** Plain-text / code edit: full-width editor + status bar */
  const codeEditor = (
    <ContentFrame title={t('overlay.code')} fitContent minWidth={850}>
      <div>
        <ShikiCodeEditor
          value={text}
          onChange={setText}
          language={language}
          showLineNumbers
          className="h-[55vh]"
        />
        {statusBar}
      </div>
    </ContentFrame>
  )

  const content = editing
    ? (isMarkdown ? markdownSplitEditor : codeEditor)
    : (isMarkdown ? markdownDocument : codeViewer)

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
      {/* Keyed remount → 200ms crossfade when toggling view ⇄ edit */}
      <div key={editing ? 'edit' : 'view'} className="animate-in fade-in-0 duration-200">
        {content}
      </div>
    </PreviewOverlay>
  )
}