/**
 * ExclusiveContextMenu
 *
 * A Radix context menu that participates in the app-wide "one menu at a time"
 * rule: opening it closes any other registered menu, and any other menu opening
 * closes it. Radix normally allows several context menus to be open at once
 * because each owns its own state.
 */

import * as React from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { claimMenu, releaseMenu, subscribeMenu } from './menuRegistry'

export interface ExclusiveContextMenuProps {
  children: React.ReactNode
}

export function ExclusiveContextMenu({ children }: ExclusiveContextMenuProps): React.ReactElement {
  const menuId = React.useId()
  const [open, setOpen] = React.useState(false)
  // Read inside the subscription without re-subscribing on every open change.
  const openRef = React.useRef(false)
  openRef.current = open

  React.useEffect(() => {
    if (open) claimMenu(menuId)
    else releaseMenu(menuId)
  }, [open, menuId])

  React.useEffect(() => subscribeMenu((activeId) => {
    // Also ignore null: re-opening this very menu releases the slot before the
    // re-claim lands, and openRef is still true at that moment.
    if (!activeId || activeId === menuId || !openRef.current) return
    // This Radix build's root takes no `open` prop, so the only way to close it
    // from the outside is the gesture Radix itself listens for: Escape on the
    // document (its escape handler binds keydown with capture).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }), [menuId])

  return (
    <ContextMenuPrimitive.Root modal onOpenChange={setOpen}>
      {children}
    </ContextMenuPrimitive.Root>
  )
}
