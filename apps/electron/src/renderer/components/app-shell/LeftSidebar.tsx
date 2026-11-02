import type { LucideIcon } from "lucide-react"
import * as React from "react"
import { AnimatePresence, motion, type Variants } from "motion/react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  ContextMenuTrigger,
  StyledContextMenuContent,
} from '@/components/ui/styled-context-menu'
import { ContextMenuProvider } from '@/components/ui/menu-context'
import { ExclusiveContextMenu } from './ExclusiveContextMenu'
import { SidebarMenu, type SidebarMenuType } from './SidebarMenu'
import { SortableList, type SortableItemData } from '@/components/ui/sortable-list'
import { dispatchSidebarClick, dispatchSidebarDoubleClick } from './sidebar-click-behavior'

/** Context menu configuration for sidebar items */
export interface SidebarContextMenuConfig {
  /** Type of sidebar item (determines available menu items) */
  type: SidebarMenuType
  /** Handler for "Mark All Read" action - for allSessions type */
  onMarkAllRead?: () => void
  /** Handler for "New Folder" action - for allSessions type */
  onNewFolder?: () => void
  /** Handler for "Add Source" action - for sources type */
  onAddSource?: () => void
  /** Handler for "Add Skill" action - for skills type */
  onAddSkill?: () => void
  /** Handler for "Add Project" action - for projects type */
  onAddProject?: () => void
  /** Handler for "View Project Details" action - for project type */
  onViewDetails?: () => void
  /** Handler for "Rename" action - for project type */
  onRename?: () => void
  /** Handler for "Delete" action - for project type */
  onDelete?: () => void
  /** Source type filter for "Learn More" link - determines which docs page to open */
  sourceType?: 'api' | 'mcp' | 'local'
}

/**
 * Sortable configuration for expandable sidebar items.
 * When present on an expandable LinkItem, its children become drag-sortable.
 */
export interface SortableConfig {
  /** Flat list reorder: called with new ordered array of item IDs after a drag-drop */
  onReorder: (orderedIds: string[]) => void
}

export interface LinkItem {
  id: string            // Unique ID for navigation (e.g., 'nav:allSessions')
  title: string
  label?: string        // Optional badge (e.g., count)
  icon: LucideIcon | React.ReactNode  // LucideIcon or custom React element
  iconColor?: string    // Optional color class for the icon
  /** Whether the icon responds to color (uses currentColor). Default true for Lucide icons. */
  iconColorable?: boolean
  variant: "default" | "ghost"  // "default" = highlighted, "ghost" = subtle
  onClick?: () => void
  // Expandable item properties
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  items?: SidebarItem[]    // Subitems as data (rendered as nested LeftSidebar) - supports separators
  // Compact mode: reduced vertical padding (4px less total height)
  compact?: boolean
  // Tutorial system
  dataTutorial?: string // data-tutorial attribute for tutorial targeting
  // Context menu configuration (optional - if provided, right-click shows context menu)
  contextMenu?: SidebarContextMenuConfig
  /**
   * When set on an expandable item: a single click toggles expansion and only a
   * double click navigates (same rule as the folder tree rows).
   */
  clickTogglesExpand?: boolean
  /** When true, the title renders as an inline rename input (rename flow). */
  editing?: boolean
  /** Commit the inline rename (Enter / blur). Absent value = cancel. */
  onRenameCommit?: (value: string) => void
  /** Cancel the inline rename (Escape / empty blur). */
  onRenameCancel?: () => void
  // Drag-and-drop: flat list reorder (e.g., statuses)
  sortable?: SortableConfig
  // Optional element rendered after the title (e.g., label type icon), revealed on hover
  afterTitle?: React.ReactNode
  /**
   * Accept a session dragged from the session list. Dropping on a nav row is how
   * a session is moved back to that scope's root (e.g. out of a subfolder).
   */
  onDropSession?: (sessionId: string) => void
  /** Drop a FOLDER here — used to move a nested folder back to the root. */
  onDropFolder?: (folderId: string) => void
  /** Double-click action for leaf items (fired in addition to the two onClicks). */
  onDoubleClick?: () => void
}

export interface SeparatorItem {
  id: string
  type: 'separator'
}

/**
 * Custom content item — anything that is not nav-link shaped (e.g. the folder
 * tree that lives under "All Sessions"). Rendered verbatim inside the listflow, so it inherits the nested indentation of its parent.
 */
export interface CustomItem {
  id: string
  type: 'custom'
  render: React.ReactNode
}

export type SidebarItem = LinkItem | SeparatorItem | CustomItem

export const isSeparatorItem = (item: SidebarItem): item is SeparatorItem =>
  'type' in item && item.type === 'separator'

export const isCustomItem = (item: SidebarItem): item is CustomItem =>
  'type' in item && item.type === 'custom'

interface LeftSidebarProps {
  isCollapsed: boolean
  links: SidebarItem[]
  /** Get props for each item (from unified sidebar navigation) */
  getItemProps?: (id: string) => {
    tabIndex: number
    'data-focused': boolean
    ref: (el: HTMLElement | null) => void
  }
  /** Currently focused item ID */
  focusedItemId?: string | null
  /** Whether this is a nested sidebar (child of expandable item) */
  isNested?: boolean
}

// Stagger animation for child items
const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.025,
      delayChildren: 0.01,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      staggerChildren: 0.015,
      staggerDirection: -1,
    },
  },
}

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.15, ease: 'easeOut' },
  },
  exit: {
    opacity: 0,
    x: -8,
    transition: { duration: 0.1, ease: 'easeIn' },
  },
}

/**
 * LeftSidebar - Vertical list of navigation buttons with icons
 *
 * Navigation is managed by the parent component (Chat.tsx) for unified
 * sidebar keyboard navigation. This component just renders the items.
 *
 * Styling matches agent items in the sidebar for consistency:
 * - py-[7px] px-2 text-[13px] rounded-md
 * - Icon: h-3.5 w-3.5
 *
 * Link variants:
 * - "default": Highlighted style (used for active/selected items)
 * - "ghost": Subtle style (used for inactive items)
 *
 * Expandable items:
 * - Show a chevron toggle on hover (replaces icon position)
 * - Children are rendered with animated expand/collapse
 * - Nested items have left indentation with vertical line
 *
 * Drag-and-drop:
 * - Expandable items can opt-in to sortable (flat) or sortableTree (hierarchical) DnD
 * - Uses @dnd-kit with DragOverlay portaled to document.body (no clipping)
 * - Two-phase drop animation: overlay fades out, ghost fades in
 */
export function LeftSidebar({ links, isCollapsed, getItemProps, focusedItemId, isNested }: LeftSidebarProps) {
  // For nested sidebars, wrap in motion container for stagger effect
  const NavWrapper = isNested ? motion.nav : 'nav'
  const navProps = isNested ? {
    variants: containerVariants,
    initial: 'hidden',
    animate: 'visible',
    exit: 'exit',
  } : {}

  return (
    <div className={cn("flex flex-col select-none", !isNested && "py-1")}>
      <NavWrapper
        className={cn(
          "grid gap-0.5",
          isNested ? "pl-5 pr-0 relative min-w-0" : "px-2"
        )}
        role="navigation"
        aria-label={isNested ? "Sub navigation" : "Main navigation"}
        {...navProps}
      >
        {/* Vertical line for nested items - 4px left of chevron center */}
        {isNested && (
          <div
            className="absolute left-[13px] top-1 bottom-1 w-px bg-foreground/10"
            aria-hidden="true"
          />
        )}
        {links.map((item) => {
          // Handle separator items
          if (isSeparatorItem(item)) {
            return (
              <div key={item.id} className="py-1 px-2" aria-hidden="true">
                <div className="h-px bg-foreground/5" />
              </div>
            )
          }

          // Custom content (e.g. folder tree under "All Sessions")
          if (isCustomItem(item)) {
            return (
              <div key={item.id} className="group/section min-w-0 max-w-full overflow-hidden">
                {item.render}
              </div>
            )
          }

          const link = item
          const itemProps = getItemProps?.(link.id)
          const isFocused = focusedItemId === link.id

          // Button element shared by both expandable and non-expandable items
          const buttonElement = (
            <SidebarButton
              link={link}
              itemProps={itemProps}
            />
          )

          // Determine which expanded content to render (sortable vs regular)
          const expandedContent = link.expandable && link.items && link.expanded
            ? renderExpandedContent(link, getItemProps, focusedItemId, isNested)
            : null

          // Wrap with context menu if configured, scoped to button only.
          // ContextMenuTrigger with asChild sets data-state="open" on the button
          // so only the clicked item highlights, not the entire section.
          const content = (
            <div className="group/section">
              {link.contextMenu ? (
                <ExclusiveContextMenu>
                  <ContextMenuTrigger asChild>
                    {buttonElement}
                  </ContextMenuTrigger>
                  <StyledContextMenuContent>
                    <ContextMenuProvider>
                      <SidebarMenu
                        type={link.contextMenu.type}
                        onMarkAllRead={link.contextMenu.onMarkAllRead}
                        onNewFolder={link.contextMenu.onNewFolder}
                        onAddSource={link.contextMenu.onAddSource}
                        onAddSkill={link.contextMenu.onAddSkill}
                        onAddProject={link.contextMenu.onAddProject}
                        onViewDetails={link.contextMenu.onViewDetails}
                        onRename={link.contextMenu.onRename}
                        onDelete={link.contextMenu.onDelete}
                        sourceType={link.contextMenu.sourceType}
                      />
                    </ContextMenuProvider>
                  </StyledContextMenuContent>
                </ExclusiveContextMenu>
              ) : (
                buttonElement
              )}
              {/* Expandable subitems — outside context menu scope so only the
                * clicked button gets data-state="open", not nested children */}
              {link.expandable && link.items && (
                <AnimatePresence initial={false}>
                  {link.expanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
                      animate={{ height: 'auto', opacity: 1, marginTop: 2, marginBottom: isNested ? 4 : 8 }}
                      exit={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
                      transition={{ duration: 0.2, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      {expandedContent}
                    </motion.div>
                  )}
                </AnimatePresence>
              )}
            </div>
          )

          // For nested items, wrap in motion.div for stagger animation
          return isNested ? (
            <motion.div key={link.id} variants={itemVariants}>
              {content}
            </motion.div>
          ) : (
            <React.Fragment key={link.id}>
              {content}
            </React.Fragment>
          )
        })}
      </NavWrapper>
    </div>
  )
}

// ============================================================
// Expanded Content Renderer
// Chooses between sortable, sortableTree, or regular nested sidebar
// ============================================================

function renderExpandedContent(
  link: LinkItem,
  getItemProps: LeftSidebarProps['getItemProps'],
  focusedItemId: string | null | undefined,
  isNested: boolean | undefined
): React.ReactNode {
  // Flat sortable (e.g., statuses): wrap items in SortableList
  if (link.sortable && link.items) {
    // Split at first separator: items before are sortable, items after are trailing (non-sortable)
    const separatorIndex = link.items.findIndex(isSeparatorItem)
    const sortableItems = separatorIndex >= 0 ? link.items.slice(0, separatorIndex) : link.items
    const trailingItems = separatorIndex >= 0
      ? link.items.slice(separatorIndex + 1).filter((item): item is LinkItem => !isSeparatorItem(item) && !isCustomItem(item))
      : []

    return (
      <SortableStatusList
        items={sortableItems}
        onReorder={link.sortable.onReorder}
        getItemProps={getItemProps}
        focusedItemId={focusedItemId}
        trailingItems={trailingItems.length > 0 ? trailingItems : undefined}
      />
    )
  }

  // Default: regular nested sidebar (no DnD)
  return (
    <LeftSidebar
      isCollapsed={false}
      isNested={true}
      getItemProps={getItemProps}
      focusedItemId={focusedItemId}
      links={link.items!}
    />
  )
}

// ============================================================
// SortableStatusList — flat sortable wrapper for status items
// ============================================================

interface SortableStatusListProps {
  items: SidebarItem[]
  onReorder: (orderedIds: string[]) => void
  getItemProps: LeftSidebarProps['getItemProps']
  focusedItemId: string | null | undefined
  /** Non-sortable items rendered after the sortable list (e.g., Flagged, Archived) */
  trailingItems?: LinkItem[]
}

function SortableStatusList({ items, onReorder, getItemProps, focusedItemId, trailingItems }: SortableStatusListProps) {
  // Filter to LinkItems only (separators/custom blocks don't participate in DnD)
  const linkItems = items.filter((item): item is LinkItem => !isSeparatorItem(item) && !isCustomItem(item))

  // Map to SortableItemData format (needs `id` field)
  const sortableItems: (LinkItem & SortableItemData)[] = linkItems.map(item => ({
    ...item,
    id: item.id,
  }))

  const handleReorder = React.useCallback((newItems: (LinkItem & SortableItemData)[]) => {
    // Extract the raw IDs (strip 'nav:state:' prefix) for the IPC call
    const orderedIds = newItems.map(item => {
      // Strip navigation prefix to get the actual status/label ID
      const parts = item.id.split(':')
      return parts[parts.length - 1]
    })
    onReorder(orderedIds)
  }, [onReorder])

  return (
    <div className="flex flex-col select-none">
      <div className="pl-5 pr-0 relative">
        {/* Vertical line for nested items */}
        <div
          className="absolute left-[13px] top-1 bottom-1 w-px bg-foreground/10"
          aria-hidden="true"
        />
        <SortableList
          items={sortableItems}
          onReorder={handleReorder}
          className="grid gap-0.5"
          renderItem={(item) => (
            <div className="group/section">
              {item.contextMenu ? (
                <ExclusiveContextMenu>
                  <ContextMenuTrigger asChild>
                    <SidebarButton
                      link={item}
                      itemProps={getItemProps?.(item.id)}
                    />
                  </ContextMenuTrigger>
                  <StyledContextMenuContent>
                    <ContextMenuProvider>
                      <SidebarMenu
                        type={item.contextMenu.type}
                        onMarkAllRead={item.contextMenu.onMarkAllRead}
                        onNewFolder={item.contextMenu.onNewFolder}
                        onAddSource={item.contextMenu.onAddSource}
                        onAddSkill={item.contextMenu.onAddSkill}
                        sourceType={item.contextMenu.sourceType}
                      />
                    </ContextMenuProvider>
                  </StyledContextMenuContent>
                </ExclusiveContextMenu>
              ) : (
                <SidebarButton
                  link={item}
                  itemProps={getItemProps?.(item.id)}
                />
              )}
            </div>
          )}
          renderOverlay={(item) => (
            <SidebarButton
              link={item}
              isOverlay={true}
            />
          )}
        />
        {/* Non-sortable trailing items (e.g., Flagged, Archived) */}
        {trailingItems && trailingItems.length > 0 && (
          <>
            <div className="my-1 ml-2" aria-hidden="true">
              <div className="h-px bg-foreground/5" />
            </div>
            <div className="grid gap-0.5">
              {trailingItems.map(item => (
                <div key={item.id} className="group/section">
                  <SidebarButton
                    link={item}
                    itemProps={getItemProps?.(item.id)}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ============================================================
// SidebarButton - Extracted button component for reuse in sortable contexts
// ============================================================

interface SidebarButtonProps {
  link: LinkItem
  itemProps?: {
    tabIndex: number
    'data-focused': boolean
    ref: (el: HTMLElement | null) => void
  }
  /** True when rendering inside the DragOverlay (floating clone) */
  isOverlay?: boolean
}

// forwardRef is required so Radix's ContextMenuTrigger (asChild) can attach its ref
// and pass props like data-state="open" directly onto this button element.
const SidebarButton = React.forwardRef<HTMLButtonElement, SidebarButtonProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ link, itemProps, isOverlay, className: extraClassName, ...radixProps }, forwardedRef) => {
    // Pending single-click toggle for `clickTogglesExpand` rows. A double click
    // cancels it, so "toggle" and "navigate" never both fire.
    const clickTimer = React.useRef<number | null>(null)
    // Drop highlight while a session is dragged over this row.
    const [sessionDropHover, setSessionDropHover] = React.useState(false)
    React.useEffect(() => () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current)
    }, [])
    React.useEffect(() => {
      // dragend only fires on the source row; clear the target highlight here.
      const clear = () => setSessionDropHover(false)
      document.addEventListener('dragend', clear)
      document.addEventListener('drop', clear)
      return () => {
        document.removeEventListener('dragend', clear)
        document.removeEventListener('drop', clear)
      }
    }, [])
    return (
      <button
        {...(isOverlay ? {} : (() => {
          // Separate ref from itemProps so we can merge it with forwardedRef
          const { ref: _itemRef, ...rest } = itemProps || { ref: undefined }
          return rest
        })())}
        // Spread Radix props (data-state, onContextMenu, onPointerDown, etc.)
        {...radixProps}
        ref={(el) => {
          // Merge forwarded ref (from Radix) and itemProps ref (for keyboard nav)
          if (typeof forwardedRef === 'function') forwardedRef(el)
          else if (forwardedRef) forwardedRef.current = el
          if (!isOverlay && itemProps?.ref) itemProps.ref(el)
        }}
        onClick={isOverlay ? undefined : (event) => {
          dispatchSidebarClick(link, clickTimer, event, window)
        }}
        onDoubleClick={isOverlay ? undefined : (event) => {
          dispatchSidebarDoubleClick(link, clickTimer, event, window)
        }}
        onDragOver={isOverlay || (!link.onDropSession && !link.onDropFolder) ? undefined : (event) => {
          // A dragOver only fires mid-gesture, so a row that owns a drop handler
          // is a valid target by construction. Checking dataTransfer.types here
          // was fragile (empty for programmatic drags), which left the row with
          // no visible frame while hovering it.
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setSessionDropHover(true)
        }}
        onDragLeave={isOverlay ? undefined : (event) => {
          // Crossing into a child fires dragleave on the row: keep the frame.
          const next = event.relatedTarget as Node | null
          if (next && event.currentTarget.contains(next)) return
          setSessionDropHover(false)
        }}
        onDrop={isOverlay ? undefined : (event) => {
          setSessionDropHover(false)
          const sessionId = event.dataTransfer.getData('application/x-craft-session')
          const folderId = event.dataTransfer.getData('application/x-craft-folder')
          if (folderId && link.onDropFolder) {
            event.preventDefault()
            event.stopPropagation()
            link.onDropFolder(folderId)
            return
          }
          if (sessionId && link.onDropSession) {
            event.preventDefault()
            event.stopPropagation()
            link.onDropSession(sessionId)
          }
        }}
        data-tutorial={link.dataTutorial}
        className={cn(
          "group flex w-full items-center gap-2 rounded-[6px] text-[13px] select-none outline-none",
          "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          // Compact mode: 4px less total height (py-[3px] vs py-[5px])
          link.compact ? "py-[3px]" : "py-[5px]",
          "px-2",
          link.variant === "default"
            ? "bg-foreground/[0.07]"
            // Highlight on hover, context menu open (data-state), or EditPopover active (data-edit-active)
            : "hover:bg-sidebar-hover data-[state=open]:bg-sidebar-hover data-[edit-active=true]:bg-sidebar-hover",
          // Last so tailwind-merge lets it win over the row's own background —
          // an earlier bg-primary/* was silently dropped and the drop target
          // showed only a hairline ring.
          sessionDropHover ? "bg-foreground/[0.12] inset-ring-2 inset-ring-foreground/45" : "",
          extraClassName,
        )}
      >
        {/* Icon container with hover toggle for expandable items */}
        <span className="relative h-3.5 w-3.5 shrink-0 flex items-center justify-center">
          {link.expandable && !isOverlay ? (
            <>
              {/* Main icon - hidden on hover */}
              <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0 transition-opacity duration-150">
                {renderIcon(link)}
              </span>
              {/* Toggle chevron - shown on hover. data-no-dnd prevents drag activation on click. */}
              <span
                className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-pointer"
                data-no-dnd="true"
                data-touch-reveal="true"
                onClick={(e) => {
                  e.stopPropagation()
                  link.onToggle?.()
                }}
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
                    link.expanded && "rotate-90"
                  )}
                />
              </span>
            </>
          ) : (
            renderIcon(link)
          )}
        </span>
        {link.editing && (link.onRenameCommit || link.onRenameCancel) ? (
          <ProjectRenameInput
            initialValue={link.title}
            onCommit={(value) => link.onRenameCommit?.(value)}
            onCancel={() => link.onRenameCancel?.()}
          />
        ) : (
          link.title
        )}
        {/* After-title element: type indicator icon, right-aligned before count badge, revealed on hover */}
        {link.afterTitle && (
          <span data-touch-reveal="true" className="ml-auto opacity-0 group-hover/section:opacity-100 group-data-[state=open]:opacity-100 group-data-[edit-active=true]:opacity-100 transition-opacity">
            {link.afterTitle}
          </span>
        )}
        {/* Label Badge: Shows count or status on the right, revealed on section hover */}
        {link.label && (
          <span data-touch-reveal="true" className={cn(link.afterTitle ? 'ml-0' : 'ml-auto', 'text-xs text-foreground/30 opacity-0 group-hover/section:opacity-100 group-data-[state=open]:opacity-100 group-data-[edit-active=true]:opacity-100 transition-opacity')}>
            {link.label}
          </span>
        )}
      </button>
    )
  }
)

/**
 * Inline rename input for a sidebar row (project entries). Enter and blur
 * commit a non-empty trimmed value; Escape cancels. Clicks and keys are kept
 * inside the input so the row's own click/navigation handlers never fire.
 */
function ProjectRenameInput({ initialValue, onCommit, onCancel }: {
  initialValue: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = React.useState(initialValue)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = () => {
    const trimmed = value.trim()
    if (trimmed && trimmed !== initialValue) onCommit(trimmed)
    else onCancel()
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={commit}
      spellCheck={false}
      aria-label={initialValue}
      className="h-5 min-w-0 flex-1 rounded-sm bg-background px-1 text-[13px] outline-none ring-1 ring-ring"
    />
  )
}

/**
 * Helper to render icon - either component (function/forwardRef) or React element.
 * Colors are always applied via inline style (resolved CSS color strings from EntityColor).
 */
function renderIcon(link: LinkItem) {
  const isComponent = typeof link.icon === 'function' ||
    (typeof link.icon === 'object' && link.icon !== null && 'render' in link.icon)
  // Default color for items without explicit iconColor (foreground at 60% opacity)
  const defaultColor = 'color-mix(in oklch, var(--foreground) 60%, transparent)'

  // Lucide components are always colorable; ReactNode icons check iconColorable
  // Default to true for backwards compatibility (most icons are colorable)
  const applyColor = link.iconColorable !== false
  const colorStyle = applyColor ? { color: link.iconColor || defaultColor } : undefined

  if (isComponent) {
    const Icon = link.icon as React.ComponentType<{ className?: string; style?: React.CSSProperties }>
    return (
      <Icon
        className="h-3.5 w-3.5 shrink-0"
        style={colorStyle}
      />
    )
  }
  // Already a React element or primitive ReactNode
  // Clone with bare={true} to remove EntityIcon container, wrapper provides sizing
  // Only pass bare to components that accept it (have acceptsBare marker) to avoid
  // forwarding unknown props to DOM elements (e.g., Lucide icons → SVG)
  const iconElement = link.icon as React.ReactNode
  const bareIcon = React.isValidElement(iconElement)
    ? (typeof iconElement.type === 'function' && (iconElement.type as { acceptsBare?: boolean }).acceptsBare)
      ? React.cloneElement(iconElement as React.ReactElement<{ bare?: boolean }>, { bare: true })
      : iconElement
    : iconElement
  return (
    <span
      className="h-3.5 w-3.5 shrink-0 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
      style={colorStyle}
    >
      {bareIcon}
    </span>
  )
}
