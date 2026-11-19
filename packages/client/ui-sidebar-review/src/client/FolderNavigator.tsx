/** Folder navigation and organization for the review panel. */

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button, IconChevronRightOutlineRegular, IconEllipsisOutlineRegular, IconFolderCloseRegular,
  IconFolderOpenRegular, IconInboxOutlineRegular, Menu, MenuItemButton, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { folderRows, type FolderId, type FolderPosition, type FolderView, type ReviewFolder } from '../transcript.ts'
import type {} from './locales.ts'
import css from './Review.module.css'

type FolderEditor = { readonly kind: 'create'; readonly parentId: FolderId | null; readonly title: string }
  | { readonly kind: 'rename'; readonly id: FolderId; readonly title: string }

type FolderNavigatorProps = PropsLocale<'sidebarReview'> & {
  readonly folders: readonly ReviewFolder[]
  readonly view: FolderView
  readonly title: string
  readonly counts: ReadonlyMap<FolderView, number>
  readonly dragging: boolean
  readonly select: (view: FolderView) => void
  readonly create: (parentId: FolderId | null, title: string) => void
  readonly rename: (id: FolderId, title: string) => void
  readonly reorder: (id: FolderId, anchor: FolderId, position: FolderPosition) => void
  readonly remove: (id: FolderId) => Promise<void>
  readonly fileDragged: (destination: FolderId | null) => void
}

function DeleteFolderConfirmation({ folder, remove, close, t }: PropsLocale<'sidebarReview'> & {
  readonly folder: ReviewFolder
  readonly remove: FolderNavigatorProps['remove']
  readonly close: (deleted: boolean) => void
}): ReactNode {
  const [state, setState] = useState<'ready' | 'deleting' | 'failed'>('ready')
  const busy = state === 'deleting'
  const cancel = (): void => { if (!busy) close(false) }
  const confirm = async (): Promise<void> => {
    setState('deleting')
    try { await remove(folder.id) }
    catch (_error: unknown) { setState('failed'); return }
    close(true)
  }
  return <Modal open onClose={cancel} closeLabel={t('close')} title={t('deleteFolderTitle')} tone="warning"
    footer={<>
      <Button variant="outline" data-modal-autofocus disabled={busy} onClick={cancel}>{t('cancel')}</Button>
      <Button variant="outline" className={css.deleteFolderAction} disabled={busy} onClick={() => { void confirm() }}>
        {t(busy ? 'deletingFolder' : 'deleteFolder')}
      </Button>
    </>}>
    <p className={css.deleteFolderDescription}>{t('deleteFolderDescription', { name: folder.title.trim() || t('untitledFolder') })}</p>
    {state === 'failed' && <p className={css.deleteFolderError} role="alert">{t('deleteFolderFailed')}</p>}
  </Modal>
}

function positionAt(event: DragEvent<HTMLDivElement>): FolderPosition {
  const bounds = event.currentTarget.getBoundingClientRect()
  return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
}

/**
 * Render the folder tree, including a disclosure for a narrow review pane.
 * @param props - the current organization, selection, and folder actions.
 * @returns responsive folder navigation.
 */
export function FolderNavigator({
  folders, view, title, counts, dragging, select, create, rename, reorder, remove, fileDragged, t,
}: FolderNavigatorProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<FolderId>>(() => new Set())
  const [editor, setEditor] = useState<FolderEditor>()
  const [menu, setMenu] = useState<FolderId | null>()
  const [deletePrompt, setDeletePrompt] = useState<ReviewFolder>()
  const [dropTarget, setDropTarget] = useState<FolderView>()
  const [placement, setPlacement] = useState<{ readonly id: FolderId; readonly position: FolderPosition }>()
  const [announcement, setAnnouncement] = useState('')
  const draggedFolder = useRef<ReviewFolder>()
  const nameInput = useRef<HTMLInputElement>(null)
  const switcher = useRef<HTMLButtonElement>(null)
  const unfiled = useRef<HTMLButtonElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>()
  const editorTrigger = useRef<HTMLButtonElement>()
  const editorTarget = editor?.kind === 'rename' ? `rename:${editor.id}`
    : editor?.kind === 'create' ? `create:${editor.parentId ?? 'root'}` : undefined

  useEffect(() => {
    if (editorTarget === undefined) return
    nameInput.current?.focus()
    nameInput.current?.select()
  }, [editorTarget])

  const moveFolder = (folder: ReviewFolder, anchor: ReviewFolder, position: FolderPosition): void => {
    const siblings = folders.filter(item => item.parentId === folder.parentId && item.id !== folder.id)
    const index = siblings.findIndex(item => item.id === anchor.id)
    reorder(folder.id, anchor.id, position)
    setAnnouncement(t('moved', { position: index + (position === 'after' ? 2 : 1), count: siblings.length + 1 }))
  }

  const sibling = (folder: ReviewFolder, position: FolderPosition): ReviewFolder | undefined => {
    const siblings = folders.filter(item => item.parentId === folder.parentId)
    const index = siblings.findIndex(item => item.id === folder.id)
    return siblings[index + (position === 'before' ? -1 : 1)]
  }

  const moveWithKey = (event: KeyboardEvent<HTMLButtonElement>, folder: ReviewFolder): void => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const position = event.key === 'ArrowUp' ? 'before' : 'after'
    const anchor = sibling(folder, position)
    if (anchor === undefined) return
    moveFolder(folder, anchor, position)
    const button = event.currentTarget
    requestAnimationFrame(() => { button.scrollIntoView({ block: 'nearest' }) })
  }

  const clearFolderDrag = (): void => { draggedFolder.current = undefined; setPlacement(undefined) }

  const folderButton = (id: FolderView, label: string, record?: ReviewFolder): ReactNode => {
    const destination = id === 'unfiled' ? null : record?.id
    const Icon = id === 'unfiled' ? IconInboxOutlineRegular : view === id ? IconFolderOpenRegular : IconFolderCloseRegular
    return <Tooltip label={label} side="right" portal onlyWhenClipped delayMs={350}>
      <button type="button" ref={id === 'unfiled' ? unfiled : undefined} className={css.folderButton}
        aria-current={view === id ? 'true' : undefined}
        data-review-folder={id} data-drop-target={dragging && dropTarget === id || undefined}
        draggable={record !== undefined} aria-keyshortcuts={record === undefined ? undefined : 'Alt+ArrowUp Alt+ArrowDown'}
        onKeyDown={(event) => { if (record !== undefined) moveWithKey(event, record) }}
        onDragStart={(event) => {
          if (record === undefined) return
          draggedFolder.current = record
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('application/x-dsh-review-folder', record.id)
        }}
        onDragEnd={clearFolderDrag}
        onClick={() => {
          setMenu(undefined)
          setEditor(undefined)
          select(id)
          setOpen(false)
          if (switcher.current?.getClientRects().length) switcher.current.focus()
        }}
        onDragOver={(event) => {
          if (!dragging || destination === undefined) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTarget(id)
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(undefined)
        }}
        onDrop={(event) => {
          if (!dragging || destination === undefined) return
          event.preventDefault()
          setDropTarget(undefined)
          fileDragged(destination)
        }}>
        <Icon size={16} />
        <span className={css.folderLabel}>{label}</span>
      </button>
    </Tooltip>
  }

  const count = (id: FolderView): ReactNode =>
    <span className={css.folderCount} aria-hidden="true">{counts.get(id) ?? 0}</span>

  const beginEdit = (next: FolderEditor): void => {
    editorTrigger.current = menuTrigger.current
    setMenu(undefined)
    setEditor(next)
  }

  const closeEditor = (): void => {
    setEditor(undefined)
    editorTrigger.current?.focus()
  }

  const form = (id: FolderId | null): ReactNode => {
    if (editor === undefined || (editor.kind === 'create' ? editor.parentId : editor.id) !== id) return null
    return <form className={css.folderForm} onSubmit={(event) => {
      event.preventDefault()
      const name = editor.title.trim()
      if (name === '') return
      if (editor.kind === 'rename') rename(editor.id, name)
      else {
        const parentId = editor.parentId
        if (parentId !== null) setCollapsed(previous => new Set([...previous].filter(folder => folder !== parentId)))
        create(parentId, name)
      }
      closeEditor()
    }}>
      <input className={css.folderName} aria-label={t('folderName')} placeholder={t('folderName')} required
        ref={nameInput}
        value={editor.title} onChange={(event) => { setEditor({ ...editor, title: event.currentTarget.value }) }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeEditor() } }} />
      <div className={css.folderTools}>
        <Button size="sm" type="submit" disabled={editor.title.trim() === ''}>{t('saveFolder')}</Button>
        <Button size="sm" type="button" onClick={closeEditor}>{t('cancel')}</Button>
      </div>
    </form>
  }

  const folderMenu = (label: string, folder?: ReviewFolder): ReactNode => {
    const id = folder?.id ?? null
    const expanded = menu === id
    const above = expanded && folder !== undefined ? sibling(folder, 'before') : undefined
    const below = expanded && folder !== undefined ? sibling(folder, 'after') : undefined
    const accessibleLabel = t('folderActions', { name: label })
    const menuMove = (anchor: ReviewFolder | undefined, position: FolderPosition): void => {
      if (folder === undefined || anchor === undefined) return
      setMenu(undefined)
      moveFolder(folder, anchor, position)
    }
    return <Menu open={expanded} onClose={() => { setMenu(undefined) }} className={css.folderMenu} portal autoFocus align="end" compact
      anchor={
        <Tooltip label={accessibleLabel} disabled={expanded} portal>
          <button type="button" className={css.folderMenuTrigger} aria-label={accessibleLabel} aria-haspopup="menu" aria-expanded={expanded}
            onClick={(event) => {
              menuTrigger.current = event.currentTarget
              if (!expanded) setOpen(true)
              setMenu(expanded ? undefined : id)
            }}><IconEllipsisOutlineRegular size={16} /></button>
        </Tooltip>
      }>
      <MenuItemButton onSelect={() => { beginEdit({ kind: 'create', parentId: id, title: '' }) }}>{t('newFolder')}</MenuItemButton>
      {folder !== undefined && <>
        <MenuItemButton onSelect={() => { beginEdit({ kind: 'rename', id: folder.id, title: folder.title }) }}>{t('renameFolder')}</MenuItemButton>
        <MenuItemButton separatorBefore disabled={above === undefined} onSelect={() => { menuMove(above, 'before') }}>{t('moveUp')}</MenuItemButton>
        <MenuItemButton disabled={below === undefined} onSelect={() => { menuMove(below, 'after') }}>{t('moveDown')}</MenuItemButton>
        <MenuItemButton danger separatorBefore onSelect={() => {
          setMenu(undefined)
          setDeletePrompt(folder)
        }}>{t('deleteFolder')}</MenuItemButton>
      </>}
    </Menu>
  }

  return <div className={css.folderNavigation}>
    <Tooltip label={title} portal onlyWhenClipped delayMs={350}>
      <Button ref={switcher} size="sm" className={css.folderSwitcher}
        icon={view === 'unfiled' ? <IconInboxOutlineRegular /> : <IconFolderCloseRegular />}
        aria-label={t('folders')} aria-expanded={open} onClick={() => { setMenu(undefined); setOpen(value => !value) }}>
        <span className={css.folderLabel}>{title}</span>
      </Button>
    </Tooltip>
    <nav className={css.folderNav} aria-label={t('folders')} data-open={open || undefined}>
      <span aria-live="polite" className={css.announcement}>{announcement}</span>
      <ul className={css.folderRows}>
        <li>
          <div className={css.folderRow}>
            <span />
            {folderButton('all', t('transcript'))}
            {folderMenu(t('transcript'))}
            {count('all')}
          </div>
          {form(null)}
          <ul className={css.folderChildren}>
            {folderRows(folders, collapsed).map((folder) => {
              const label = folder.title.trim() || t('untitledFolder')
              const hidden = collapsed.has(folder.id)
              const disclosure = t(hidden ? 'expandFolder' : 'collapseFolder', { name: label })
              return <li key={folder.id} style={{ marginInlineStart: Math.min(folder.depth, 4) * 10 }}>
                <div className={css.folderRow} data-folder-placement={placement?.id === folder.id ? placement.position : undefined}
                  onDragOver={(event) => {
                    const moving = draggedFolder.current
                    if (moving === undefined || moving.id === folder.id || moving.parentId !== folder.parentId) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const position = positionAt(event)
                    setPlacement(previous => previous?.id === folder.id && previous.position === position
                      ? previous : { id: folder.id, position })
                  }}
                  onDragLeave={(event) => {
                    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                      setPlacement(previous => previous?.id === folder.id ? undefined : previous)
                    }
                  }}
                  onDrop={(event) => {
                    const moving = draggedFolder.current
                    if (moving === undefined || moving.id === folder.id || moving.parentId !== folder.parentId) return
                    event.preventDefault()
                    moveFolder(moving, folder, positionAt(event))
                    clearFolderDrag()
                  }}>
                  {folder.children ? <Tooltip label={disclosure}>
                    <button type="button" className={css.disclosure} aria-label={disclosure} aria-expanded={!hidden} onClick={() => {
                      setMenu(undefined)
                      setEditor(undefined)
                      setCollapsed((previous) => {
                        const next = new Set(previous)
                        if (next.has(folder.id)) next.delete(folder.id)
                        else next.add(folder.id)
                        return next
                      })
                    }}><IconChevronRightOutlineRegular size={14} /></button>
                  </Tooltip> : <span />}
                  {folderButton(folder.id, label, folder)}
                  {folderMenu(label, folder)}
                  {count(folder.id)}
                </div>
                {form(folder.id)}
              </li>
            })}
            <li className={css.folderRow}>
              <span />
              {folderButton('unfiled', t('unfiled'))}
              {count('unfiled')}
            </li>
          </ul>
        </li>
      </ul>
    </nav>
    {deletePrompt !== undefined && <DeleteFolderConfirmation folder={deletePrompt} remove={remove} t={t}
      close={(deleted) => {
        setDeletePrompt(undefined)
        const target = deleted ? unfiled.current : menuTrigger.current
        requestAnimationFrame(() => { target?.focus() })
      }} />}
  </div>
}
