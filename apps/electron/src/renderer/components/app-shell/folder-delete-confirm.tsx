/**
 * FolderDeleteConfirm
 *
 * The "delete folder (and its sessions)" confirmation dialog, shared by every
 * surface that offers folder deletion. The dialog is the second confirm step:
 * the menu item only opens it.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export interface FolderDeleteConfirmProps {
  /** Folder name, shown in the title. */
  name: string
  /** Delete in flight: the confirm button stays disabled. */
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function FolderDeleteConfirm({
  name,
  busy,
  onCancel,
  onConfirm,
}: FolderDeleteConfirmProps): React.ReactElement {
  const { t } = useTranslation()
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[320px] rounded-lg border border-foreground/10 bg-popover p-4 text-popover-foreground shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 text-sm font-medium">{t('folders.deleteTitle', { name })}</div>
        <p className="mb-3 text-xs text-muted-foreground">{t('folders.deleteBody')}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={onCancel}
          >
            {t('folders.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-md bg-destructive px-3 py-1.5 text-sm text-white hover:bg-destructive/90 disabled:opacity-50"
            onClick={onConfirm}
          >
            {t('folders.deleteForever')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
