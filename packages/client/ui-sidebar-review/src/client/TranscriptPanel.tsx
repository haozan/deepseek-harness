/** The ordered review transcript and its capture, editing, and export actions. */

import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode,
} from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  Button, IconChevronRightOutlineRegular, IconDragHandleOutlineRegular, IconListPenOutlineRegular,
  IconLoadingOutlineRegular, IconRightUpOutlineRegular, IconSparkleRegular, IconWarningOutlineRegular,
  Menu, MenuItemButton, StateDot, Switch, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ReviewClip } from './clip-store.ts'
import { exportTranscript, type TranscriptExportMode } from './export-transcript.ts'
import { FolderNavigator } from './FolderNavigator.tsx'
import type { RecognitionStatus } from './recognition.ts'
import { openCaptureSource, Screenshot } from './Review.tsx'
import { ReviewLayout } from './ReviewLayout.tsx'
import {
  cardSourceLabel, CARD_COLORS, editTranscript, EMPTY_DRAFT, folderRows, moveEntries, transcriptEntries, transcriptSections,
  type CardColor, type EntryKey, type FolderId, type FolderView, type TranscriptDraft, type TranscriptEdit, type TranscriptEntry,
} from '../transcript.ts'
import type {} from './locales.ts'
import css from './Review.module.css'

interface ReviewFace {
  readonly hooks: {
    readonly reviewRevision: ObservableSnapshot<number>
    readonly recognitionRevision: ObservableSnapshot<number>
    readonly autoRecognition: ObservableSnapshot<boolean>
    readonly recognitionStatuses: ObservableSnapshot<Readonly<Partial<Record<EntryKey, RecognitionStatus>>>>
  }
  readonly read: () => Promise<readonly ReviewClip[]>
  readonly readDraft: () => Promise<TranscriptDraft>
  readonly write: (edit: TranscriptEdit) => Promise<TranscriptDraft>
  readonly recognize: (clips: readonly ReviewClip[]) => void
  readonly setAutoRecognition: (enabled: boolean) => void
  readonly stageCard: (clip: ReviewClip, text: string, fullscreenTrigger?: HTMLElement) => boolean
  readonly saveExport: (file: Blob, name: string) => Promise<void>
}

type Copy = PropsLocale<'sidebarReview'>
type ReviewProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<ReviewFace> & Copy
type CardGroup = FolderId | 'unfiled'
const CARD_HIGHLIGHT_MS = 1800
type LoadState = { readonly kind: 'loading' | 'failed' }
  | { readonly kind: 'ready'; readonly clips: readonly ReviewClip[] }

type CardEditorProps = Copy & {
  readonly entry: TranscriptEntry<ReviewClip>
  readonly showSource: boolean
  readonly status: RecognitionStatus | undefined
  readonly recognizing: boolean
  readonly locate: () => void
  readonly recognizeCard: () => void
  readonly ask: (trigger: HTMLElement) => void
  readonly change: (edit: TranscriptEdit) => void
}

function CardEditor({ entry, showSource, status, recognizing, locate, recognizeCard, ask, change, t }: CardEditorProps): ReactNode {
  const [editing, setEditing] = useState(false)
  const [palette, setPalette] = useState(false)
  const sourceId = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    if (editing) field.current?.focus({ preventScroll: true })
  }, [editing])
  const paint = (value: CardColor | undefined): void => { change({ kind: 'color', key: entry.key, value }) }
  const hasText = entry.text.trim() !== ''
  const recognized = entry.recognition === 'text'
  const recognitionDisabled = recognized || recognizing
  const recognizingCard = status === 'running' || status === 'queued'
  const recognitionLabel = t(recognized ? 'recognized' : recognizingCard ? 'recognizing' : 'recognize')
  return <div className={css.editor}>
    <div className={css.cardTools} data-review-card-tools data-open={palette || undefined}>
      <Tooltip label={t('locateSource')} portal>
        <button className={css.cardAction} type="button" aria-label={t('openSource', { name: entry.clip.fileName })}
          onClick={locate}><IconRightUpOutlineRegular /></button>
      </Tooltip>
      <Tooltip label={recognitionLabel} portal>
        <button className={css.cardAction} type="button" aria-label={recognitionLabel} aria-disabled={recognitionDisabled}
          onClick={() => { if (!recognitionDisabled) recognizeCard() }}>
          {recognizingCard ? <IconLoadingOutlineRegular /> : <IconListPenOutlineRegular />}
        </button>
      </Tooltip>
      <Tooltip label={t('askAI')} portal>
        <button className={css.cardAction} type="button" aria-label={t('askAI')}
          onClick={(event) => { ask(event.currentTarget) }}><IconSparkleRegular /></button>
      </Tooltip>
      <Menu open={palette} portal autoFocus align="end" compact onClose={() => { setPalette(false) }} anchor={(
        <Tooltip label={t('cardColor')} disabled={palette} portal>
          <button className={css.cardAction} type="button" aria-label={t('cardColor')} aria-haspopup="menu" aria-expanded={palette}
            onClick={() => { setPalette(open => !open) }}><span className={css.swatch} data-color={entry.color} /></button>
        </Tooltip>
      )}>
        <MenuItemButton current={entry.color === undefined} icon={<span className={css.swatch} />}
          onSelect={() => { paint(undefined) }}>{t('clearColor')}</MenuItemButton>
        {CARD_COLORS.map(color => <MenuItemButton key={color} current={entry.color === color}
          icon={<span className={css.swatch} data-color={color} />} onSelect={() => { paint(color) }}>{t(color)}</MenuItemButton>)}
      </Menu>
    </div>
    <div className={css.cardBody}>
      {showSource && <span className={css.cardSource} id={sourceId}>{cardSourceLabel(entry.clip.fileName)}</span>}
      {editing || hasText ? (
        <textarea className={css.field} ref={field} rows={2} aria-label={t('cardText')} placeholder={t('cardText')} value={entry.text}
          aria-describedby={showSource ? sourceId : undefined} onFocus={() => { setEditing(true) }} onBlur={() => { setEditing(false) }}
          onChange={(event) => { change({ kind: 'text', key: entry.key, value: event.currentTarget.value }) }} />
      ) : (
        <button className={css.editScreenshot} type="button" aria-label={t('cardText')} aria-describedby={showSource ? sourceId : undefined}
          onClick={() => { setEditing(true) }}><Screenshot png={entry.clip.png} /></button>
      )}
    </div>
    {entry.recognition === 'empty' && !hasText && <p className={css.notice} role="status">{t('noText')}</p>}
    {status === 'failed' && <p className={css.notice} role="alert">{t('recognizeFailed')}</p>}
    {status === 'saveFailed' && <p className={css.notice} role="alert">{t('recognitionSaveFailed')}</p>}
  </div>
}

function gapAt(event: DragEvent<HTMLLIElement>, index: number): number {
  const box = event.currentTarget.getBoundingClientRect()
  return index + (event.clientY >= box.top + box.height / 2 ? 1 : 0)
}

/**
 * Edit, reorder, transcribe and export the Session's saved screenshot cards.
 * @param props - Session-scoped persistence, model, and file actions.
 * @returns the right-sidebar transcript.
 */
export function ReviewPanel({
  useTabInfo, useReviewRevision, useRecognitionRevision, useAutoRecognition, useRecognitionStatuses,
  read, readDraft, write, recognize, setAutoRecognition, stageCard, saveExport, t,
}: ReviewProps): ReactNode {
  const { sidebar, panel: pane, tab } = useTabInfo()
  const { params, revision: navigationRevision } = tab.navigation
  const requestedCard = params !== undefined && 'reviewEntry' in params ? params.reviewEntry : undefined
  const panel = useRef<HTMLElement>(null)
  const revealedNavigation = useRef<number>()
  const [highlight, setHighlight] = useState<{ readonly key: EntryKey }>()
  const revision = useReviewRevision(value => value)
  const recognitionRevision = useRecognitionRevision(value => value)
  const autoRecognition = useAutoRecognition(value => value)
  const statuses = useRecognitionStatuses(value => value)
  const [retry, setRetry] = useState(0)
  const [list, setList] = useState<LoadState>({ kind: 'loading' })
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const current = useRef(EMPTY_DRAFT)
  const edits = useRef<TranscriptEdit[]>([])
  const writing = useRef<Promise<boolean>>()
  const draftVersion = useRef(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'failed'>('idle')
  const [view, setView] = useState<FolderView>('all')
  const [collapsedChapters, setCollapsedChapters] = useState<ReadonlySet<CardGroup>>(() => new Set())
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<EntryKey>>(() => new Set())
  const [dragged, setDragged] = useState<readonly EntryKey[]>()
  const [placement, setPlacement] = useState<{ readonly group: CardGroup; readonly gap: number }>()
  const [announcement, setAnnouncement] = useState('')
  const [notice, setNotice] = useState<'openFailed' | 'exportFailed' | 'chatFailed' | 'autoRecognitionSaveFailed' | 'autoRecognitionHint'>()
  const [showSource, setShowSource] = useState(false)
  const [exportMenu, setExportMenu] = useState(false)
  const [exporting, setExporting] = useState(false)

  const commitDraft = useCallback((saved: TranscriptDraft): void => {
    const updated = edits.current.reduce(editTranscript, saved)
    draftVersion.current += 1
    current.current = updated
    setDraft(updated)
  }, [])

  useEffect(() => {
    let active = true
    const version = draftVersion.current
    void Promise.all([read(), readDraft()]).then(
      ([clips, saved]) => {
        if (!active) return
        if (draftVersion.current === version && edits.current.length === 0) commitDraft(saved)
        setList({ kind: 'ready', clips })
      },
      () => { if (active) setList({ kind: 'failed' }) },
    )
    return () => { active = false }
  }, [read, readDraft, revision, recognitionRevision, retry, commitDraft])

  const allEntries = useMemo(() => list.kind === 'ready' ? transcriptEntries(list.clips, draft) : [], [list, draft])
  const sections = useMemo(() => transcriptSections(allEntries, draft), [allEntries, draft])
  const chapters = useMemo(() => {
    let foldedDepth: number | undefined
    return sections.flatMap((section) => {
      const folder = section.kind === 'folder' ? section.folder : undefined
      const depth = folder?.depth ?? 0
      if (foldedDepth !== undefined && depth > foldedDepth) return []
      const group: CardGroup = folder?.id ?? 'unfiled'
      const foldable = section.kind === 'folder' ? section.folder.children || section.entries.length > 0 : section.heading
      const folded = foldable && collapsedChapters.has(group)
      foldedDepth = folded ? depth : undefined
      return [{ section, group, depth, foldable, folded, cards: folded ? [] : section.entries }]
    })
  }, [sections, collapsedChapters])
  const entries = view === 'all' ? chapters.flatMap(chapter => chapter.cards)
    : allEntries.filter(entry => (draft.assignments[entry.key] ?? 'unfiled') === view)
  const choose = useCallback((folder: FolderView): void => {
    setView(folder)
    setSelected(new Set())
  }, [])

  useLayoutEffect(() => {
    if (!tab.visible || requestedCard === undefined || revealedNavigation.current === navigationRevision
      || !allEntries.some(entry => entry.key === requestedCard)) return
    const group = draft.assignments[requestedCard] ?? 'unfiled'
    if (view !== 'all' && view !== group) {
      choose('all')
      return
    }
    const row = panel.current?.querySelector<HTMLElement>(`[data-review-entry="${requestedCard}"]`)
    if (row == null) {
      const next = new Set(collapsedChapters)
      let chapter: CardGroup | null = group
      while (chapter !== null) {
        next.delete(chapter)
        chapter = draft.folders.find(folder => folder.id === chapter)?.parentId ?? null
      }
      if (next.size < collapsedChapters.size) setCollapsedChapters(next)
      return
    }
    revealedNavigation.current = navigationRevision
    row.scrollIntoView({ block: 'start', inline: 'nearest' })
    row.focus({ preventScroll: true })
    setHighlight({ key: requestedCard })
  }, [tab.visible, requestedCard, navigationRevision, allEntries, draft, view, collapsedChapters, choose])

  useEffect(() => {
    if (highlight === undefined) return
    const timeout = window.setTimeout(() => { setHighlight(undefined) }, CARD_HIGHLIGHT_MS)
    return () => { window.clearTimeout(timeout) }
  }, [highlight])

  const orderedKeys = entries.map(entry => entry.key)
  const untranscribed = entries.filter(entry => entry.recognition !== 'text')
  const recognizing = allEntries.some(({ key }) => statuses[key] === 'queued' || statuses[key] === 'running')
  const allRecognized = entries.length > 0 && untranscribed.length === 0
  const title = view === 'all' ? t('transcript') : view === 'unfiled' ? t('unfiled')
    : draft.folders.find(folder => folder.id === view)?.title.trim() || t('untitledFolder')
  const counts = useMemo(() => {
    const totals = new Map<FolderView, number>([['all', allEntries.length]])
    for (const { key } of allEntries) {
      const id = draft.assignments[key] ?? 'unfiled'
      totals.set(id, (totals.get(id) ?? 0) + 1)
    }
    return totals
  }, [allEntries, draft.assignments])
  const destinations = useMemo(() => {
    const paths = new Map<FolderId, string>()
    for (const folder of folderRows(draft.folders)) {
      const label = folder.title.trim() || t('untitledFolder')
      const parent = folder.parentId === null ? undefined : paths.get(folder.parentId)
      paths.set(folder.id, parent === undefined ? label : `${parent} / ${label}`)
    }
    return paths
  }, [draft.folders, t])

  const toggleChapter = (group: CardGroup): void => {
    setCollapsedChapters((previous) => {
      const next = new Set(previous)
      if (!next.delete(group)) next.add(group)
      return next
    })
  }

  const flush = (): Promise<boolean> => {
    if (writing.current !== undefined) return writing.current
    writing.current = Promise.resolve().then(async () => {
      setSaveState('saving')
      try {
        while (edits.current[0] !== undefined) {
          const saved = await write(edits.current[0])
          edits.current.shift()
          commitDraft(saved)
        }
        setSaveState('idle')
        return true
      } catch (_error: unknown) {
        setSaveState('failed')
        return false
      } finally { writing.current = undefined }
    })
    return writing.current
  }

  const change = (edit: TranscriptEdit): void => {
    draftVersion.current += 1
    current.current = editTranscript(current.current, edit)
    setDraft(current.current)
    const last = edits.current.at(-1)
    if (edits.current.length > 1 && edit.kind === 'text' && last?.kind === 'text' && last.key === edit.key) {
      edits.current[edits.current.length - 1] = edit
    } else {
      edits.current.push(edit)
    }
    void flush()
  }

  const transcribe = async (entries: readonly TranscriptEntry<ReviewClip>[]): Promise<void> => {
    if (await flush() && !tab.signal.aborted) recognize(entries.map(entry => entry.clip))
  }

  const createFolder = (parentId: FolderId | null, title: string): void => {
    const id = `folder:${randomUUID()}` as const
    change({ kind: 'createFolder', folder: { id, parentId, title } })
    choose(id)
  }

  const deleteFolder = async (id: FolderId): Promise<void> => {
    if (!await flush()) throw new Error('Pending transcript edits could not be saved')
    const unfiledOrder = allEntries.filter(entry => current.current.assignments[entry.key] === undefined).map(entry => entry.key)
    const edit: TranscriptEdit = { kind: 'deleteFolder', id, unfiledOrder }
    commitDraft(await write(edit))
    if (view !== 'all' && view !== 'unfiled' && !current.current.folders.some(folder => folder.id === view)) choose('unfiled')
  }

  const file = (keys: readonly EntryKey[], folderId: FolderId | null): void => {
    const assignments = current.current.assignments
    const moving = keys.filter(key => (assignments[key] ?? null) !== folderId)
    if (moving.length === 0) return
    const destinationOrder = allEntries.filter(entry => (assignments[entry.key] ?? null) === folderId).map(entry => entry.key)
    change({ kind: 'file', keys: moving, folderId, destinationOrder })
    setSelected(new Set())
    setAnnouncement(t('filed', { count: moving.length }))
  }

  const selectedKeys = orderedKeys.filter(key => selected.has(key))
  const toggleCard = (key: EntryKey): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const move = (order: readonly EntryKey[], keys: readonly EntryKey[], gap: number): void => {
    const first = keys[0]
    if (first === undefined) return
    const next = moveEntries(order, keys, gap)
    if (next === order) return
    change({ kind: 'order', order: next })
    setAnnouncement(t('moved', { position: next.indexOf(first) + 1, count: next.length }))
  }

  const moveWithKey = (event: KeyboardEvent<HTMLButtonElement>, order: readonly EntryKey[], key: EntryKey, index: number): void => {
    const positions: Readonly<Record<string, number>> = { ArrowUp: index - 1, ArrowDown: index + 2, Home: 0, End: order.length }
    const gap = positions[event.key]
    if (gap === undefined) return
    event.preventDefault()
    move(order, [key], Math.max(0, Math.min(order.length, gap)))
    const target = event.currentTarget
    requestAnimationFrame(() => { target.scrollIntoView({ block: 'nearest' }) })
  }

  const clearDrag = (): void => { setDragged(undefined); setPlacement(undefined) }
  const open = (clip: ReviewClip): void => {
    try { openCaptureSource(tab.actions, clip) }
    catch (_error: unknown) { setNotice('openFailed') }
  }
  const saveFile = async (mode: TranscriptExportMode): Promise<void> => {
    setExportMenu(false)
    setExporting(true)
    const options = {
      title: t('transcript'), untitled: t('untitledFolder'), unfiled: t('unfiled'),
      screenshot: t('exportScreenshot'), includeSource: showSource, mode,
    }
    try { await saveExport(await exportTranscript(allEntries, draft, options), `${options.title}.html`) }
    catch (_error: unknown) { setNotice('exportFailed') }
    finally { setExporting(false) }
  }

  const renderCards = (cards: readonly TranscriptEntry<ReviewClip>[], group: CardGroup): ReactNode => {
    const order = cards.map(entry => entry.key)
    const canReorder = dragged?.every(key => order.includes(key)) === true
    const gap = placement?.group === group ? placement.gap : undefined
    return <ol className={css.clips} onDragLeave={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
        setPlacement(previous => previous?.group === group ? undefined : previous)
      }
    }}>
      {cards.map((entry, index) => {
        return <li key={entry.key} data-review-entry={entry.key} className={css.entry}
          tabIndex={requestedCard === entry.key ? -1 : undefined} data-review-highlighted={highlight?.key === entry.key || undefined}
          data-placement={gap === index ? 'before' : gap === index + 1 && index + 1 === cards.length ? 'after' : undefined}
          onDragOver={(event) => {
            if (dragged === undefined || !canReorder) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setPlacement({ group, gap: gapAt(event, index) })
          }}
          onDrop={(event) => {
            if (dragged === undefined || !canReorder) return
            event.preventDefault()
            move(order, dragged, gapAt(event, index))
            clearDrag()
          }}>
          <div className={css.cardNode} data-color={entry.color} data-selected={selected.has(entry.key) || undefined}>
            <div className={css.nodeMarker}>
              {selecting && <input type="checkbox" className={css.cardCheckbox}
                aria-label={t('selectCard', { name: entry.clip.fileName })}
                checked={selected.has(entry.key)} onChange={() => { toggleCard(entry.key) }} />}
              <Tooltip label={t('moveHelp')} side="bottom">
                <button type="button" className={css.grip} draggable aria-label={t('moveHelp')}
                  onKeyDown={(event) => { moveWithKey(event, order, entry.key, index) }}
                  onDragStart={(event) => {
                    setDragged(selected.has(entry.key) ? selectedKeys : [entry.key])
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('application/x-dsh-review-entry', entry.key)
                  }}
                  onDragEnd={clearDrag}><IconDragHandleOutlineRegular /></button>
              </Tooltip>
            </div>
            <CardEditor entry={entry} showSource={showSource} t={t}
              status={statuses[entry.key]} recognizing={recognizing} change={change}
              locate={() => { open(entry.clip) }} recognizeCard={() => { void transcribe([entry]) }} ask={(trigger) => {
                try {
                  const fullscreenTrigger = sidebar.fullscreen && !pane.isFloating ? trigger : undefined
                  if (!stageCard(entry.clip, current.current.texts[entry.key] ?? '', fullscreenTrigger)) setNotice('chatFailed')
                } catch (_error: unknown) { setNotice('chatFailed') }
              }} />
          </div>
        </li>
      })}
    </ol>
  }

  const renderOutline = (): ReactNode => {
    const branches = new Map<CardGroup | null, ReactNode[]>()
    for (const { section, group, depth, foldable, folded, cards } of [...chapters].reverse()) {
      const parent = section.kind === 'folder' ? section.folder.parentId : null
      const heading = section.kind === 'folder' ? section.folder.title.trim() || t('untitledFolder')
        : section.heading ? t('unfiled') : undefined
      const children = branches.get(group)?.reverse()
      const cardNodes = cards.length === 0 ? null : renderCards(cards, group)
      const branch = branches.get(parent) ?? []
      branch.push(
        <div key={group} className={css.transcriptChapter} data-review-chapter={group}>
          {heading !== undefined && (
            <div className={css.transcriptHeading} role="heading" aria-level={depth + 2} data-subheading={depth > 0 || undefined}>
              {foldable ? (
                <button type="button" className={css.chapterToggle} aria-expanded={!folded} onClick={() => { toggleChapter(group) }}>
                  <span className={css.chapterMarker} aria-hidden="true"><IconChevronRightOutlineRegular size={14} /></span>
                  <span>{heading}</span>
                </button>
              ) : <div className={css.chapterLabel}>
                <span className={css.chapterMarker} aria-hidden="true" />
                <span>{heading}</span>
              </div>}
            </div>
          )}
          {heading === undefined ? cardNodes : (cardNodes !== null || children !== undefined) && (
            <div className={css.outlineBranch} data-review-branch data-indent={depth < 3 || undefined} data-deep={depth >= 2 || undefined}>
              {cardNodes}
              {children}
            </div>
          )}
        </div>,
      )
      branches.set(parent, branch)
    }
    return <div className={css.transcriptChapters} data-review-outline>
      <h1 className={css.transcriptTitle}>{t('transcript')}</h1>
      {branches.get(null)?.reverse()}
    </div>
  }

  return <section ref={panel} className={css.panel} aria-label={t('review')} aria-busy={list.kind === 'loading'} data-review-panel>
    {list.kind === 'loading' && <div className={css.empty} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={28} /></div>}
    {list.kind === 'failed' && <div className={css.empty}>
      <p role="alert">{t('loadFailed')}</p>
      <Button size="sm" onClick={() => { setList({ kind: 'loading' }); setRetry(value => value + 1) }}>{t('retry')}</Button>
    </div>}
    {list.kind === 'ready' && <>
      <ReviewLayout t={t} currentFolder={title} folderTree={(
        <FolderNavigator folders={draft.folders} view={view} title={title} counts={counts} dragging={dragged !== undefined}
          t={t} select={choose} create={createFolder}
          rename={(id, title) => { change({ kind: 'renameFolder', id, title }) }}
          reorder={(id, anchor, position) => { change({ kind: 'moveFolder', id, anchor, position }) }}
          remove={deleteFolder}
          fileDragged={(folderId) => {
            if (dragged !== undefined) file(dragged, folderId)
            clearDrag()
          }} />
      )} toolbar={(
        <>
          <Button size="sm" aria-pressed={selecting} disabled={!selecting && entries.length === 0}
            onClick={() => { setSelecting(value => !value); setSelected(new Set()) }}>{t(selecting ? 'done' : 'selectCards')}</Button>
          <Button size="sm" disabled={recognizing || untranscribed.length === 0}
            onClick={() => { void transcribe(untranscribed) }}>{t(allRecognized ? 'allRecognized' : 'recognizeAll')}</Button>
          <label className={css.sourceToggle}>
            <Switch label={t('autoRecognition')} checked={autoRecognition} title={t('autoRecognitionHint')}
              onChange={(enabled) => {
                try {
                  setAutoRecognition(enabled)
                  if (enabled) setNotice('autoRecognitionHint')
                  else setNotice(current => current === 'autoRecognitionHint' ? undefined : current)
                } catch (_error: unknown) { setNotice('autoRecognitionSaveFailed') }
              }} />
            <span>{t('autoRecognition')}</span>
          </label>
          <label className={css.sourceToggle}>
            <Switch label={t('showSource')} checked={showSource} onChange={setShowSource} />
            <span>{t('showSource')}</span>
          </label>
          <Menu open={exportMenu} portal autoFocus align="end" compact onClose={() => { setExportMenu(false) }} anchor={(
            <Button size="sm" variant="outline" disabled={exporting || allEntries.length === 0} aria-haspopup="menu" aria-expanded={exportMenu}
              onClick={() => { setExportMenu(open => !open) }}>{t('export')}</Button>
          )}>
            <MenuItemButton onSelect={() => { void saveFile('illustrated') }}>{t('exportIllustrated')}</MenuItemButton>
            <MenuItemButton onSelect={() => { void saveFile('text') }}>{t('exportText')}</MenuItemButton>
          </Menu>
        </>
      )}>
        {selecting && <div className={css.transcriptToolbar}>
          <Button size="sm" disabled={entries.length === 0 || selectedKeys.length === entries.length}
            onClick={() => { setSelected(new Set(orderedKeys)) }}>{t('selectAll')}</Button>
          <select className={css.destination} aria-label={t('moveTo')} value="" disabled={selectedKeys.length === 0}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === 'unfiled') file(selectedKeys, null)
              else {
                const target = draft.folders.find(folder => folder.id === value)
                if (target !== undefined) file(selectedKeys, target.id)
              }
            }}>
            <option value="" disabled>{t('moveTo')}</option>
            <option value="unfiled" disabled={view === 'unfiled'}>{t('unfiled')}</option>
            {[...destinations].map(([id, path]) => <option key={id} value={id} disabled={view === id}>{path}</option>)}
          </select>
        </div>}
        {saveState === 'saving' && <p role="status" className={css.notice}>{t('savingEdits')}</p>}
        {saveState === 'failed' && <div role="alert" className={css.notice}>
          {t('editFailed')} <Button size="sm" onClick={() => { void flush() }}>{t('retry')}</Button>
        </div>}
        <span aria-live="polite" className={css.announcement}>{announcement}</span>
        {view === 'all' && chapters.length > 0 ? renderOutline() : entries.length === 0 || view === 'all'
          ? <p className={css.empty}>{t(view === 'all' ? 'empty' : 'emptyFolder')}</p>
          : renderCards(entries, view)}
      </ReviewLayout>
    </>}
    {notice === 'autoRecognitionHint'
      ? <Toast key={notice} text={t(notice)} holdMs={5000} onDone={() => { setNotice(undefined) }} />
      : notice !== undefined && <Toast key={notice} icon={<IconWarningOutlineRegular />} text={t(notice)}
        onDone={() => { setNotice(undefined) }} />}
  </section>
}
