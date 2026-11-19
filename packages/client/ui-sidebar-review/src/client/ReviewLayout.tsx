/** The responsive folder tree and card columns inside the review pane. */

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './Review.module.css'

const MIN_FOLDER_WIDTH = 172
const DEFAULT_FOLDER_WIDTH = 210
const MIN_CARD_WIDTH = 280
const DIVIDER_WIDTH = 12
const KEY_STEP = 16

interface FolderResize {
  readonly pointerId: number
  readonly startX: number
  readonly startWidth: number
  readonly direction: number
}

type ReviewLayoutProps = PropsLocale<'sidebarReview'> & {
  readonly folderTree: ReactNode
  readonly currentFolder: string
  readonly toolbar: ReactNode
  readonly children: ReactNode
}

/**
 * Let readers collapse or resize the tree when the review pane can fit two columns.
 * @param props - the tree, its current folder label, and the card actions and content.
 * @returns the shared review layout, with the existing folder picker in narrow panes.
 */
export function ReviewLayout({ folderTree, currentFolder, toolbar, children, t }: ReviewLayoutProps): ReactNode {
  const folderPaneId = useId()
  const layout = useRef<HTMLDivElement>(null)
  const pointer = useRef<FolderResize>()
  const [available, setAvailable] = useState(0)
  const [width, setWidth] = useState(DEFAULT_FOLDER_WIDTH)
  const [collapsed, setCollapsed] = useState(false)
  const [resizing, setResizing] = useState(false)

  useLayoutEffect(() => {
    const element = layout.current
    if (element === null) return
    const measure = (): void => { setAvailable(element.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const maxWidth = Math.max(MIN_FOLDER_WIDTH, available - MIN_CARD_WIDTH - DIVIDER_WIDTH)
  const clamp = (value: number): number => Math.round(Math.max(MIN_FOLDER_WIDTH, Math.min(maxWidth, value)))
  const folderWidth = clamp(width)
  const style: CSSProperties & { '--review-folder-width': string; '--review-divider-width': string } = {
    '--review-folder-width': `${folderWidth}px`, '--review-divider-width': `${DIVIDER_WIDTH}px`,
  }
  const toggleLabel = t(collapsed ? 'showFolders' : 'hideFolders')
  const endResize = (id: number): void => {
    if (pointer.current?.pointerId !== id) return
    pointer.current = undefined
    setResizing(false)
  }

  return <div ref={layout} className={css.reviewLayout} style={style}
    data-folders-collapsed={collapsed || undefined} data-resizing-folders={resizing || undefined}>
    <div id={folderPaneId} className={css.folderPane}>{folderTree}</div>
    <div className={css.folderDivider} role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label={t('resizeFolders')} aria-controls={folderPaneId}
      aria-valuemin={MIN_FOLDER_WIDTH} aria-valuemax={maxWidth} aria-valuenow={folderWidth}
      onPointerDown={(event) => {
        if (event.button !== 0 || pointer.current !== undefined) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        pointer.current = {
          pointerId: event.pointerId, startX: event.clientX, startWidth: folderWidth,
          direction: getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1,
        }
        setResizing(true)
      }}
      onPointerMove={(event) => {
        const drag = pointer.current
        if (drag?.pointerId !== event.pointerId) return
        setWidth(clamp(drag.startWidth + (event.clientX - drag.startX) * drag.direction))
      }}
      onPointerUp={(event) => { endResize(event.pointerId) }}
      onPointerCancel={(event) => { endResize(event.pointerId) }}
      onLostPointerCapture={(event) => { endResize(event.pointerId) }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        const direction = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1
        const positions: Readonly<Record<string, number>> = {
          ArrowLeft: folderWidth - KEY_STEP * direction, ArrowRight: folderWidth + KEY_STEP * direction,
          Home: MIN_FOLDER_WIDTH, End: maxWidth,
        }
        const requested = positions[event.key]
        if (requested === undefined) return
        event.preventDefault()
        setWidth(clamp(requested))
      }} />
    <div className={css.cards}>
      <div className={css.transcriptToolbar}>
        <Tooltip label={collapsed ? `${toggleLabel} · ${currentFolder}` : toggleLabel} portal>
          <Button size="sm" className={css.folderToggle} aria-label={toggleLabel} aria-expanded={!collapsed} aria-controls={folderPaneId}
            icon={<IconPanelLeftOutlineRegular />} onClick={() => { setCollapsed(value => !value) }} />
        </Tooltip>
        {toolbar}
      </div>
      {children}
    </div>
  </div>
}
