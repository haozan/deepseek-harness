/** Folder organization and editable text in a Session's review transcript. */

/** Stable identity of a saved screenshot in the draft. */
export type EntryKey = `clip:${number}`

/** Stable local identity of a user-created folder. */
export type FolderId = `folder:${string}`

/** The full transcript, unfiled cards, or the direct contents of a folder. */
export type FolderView = 'all' | 'unfiled' | FolderId

/** A folder's name and parent relationship. */
export interface ReviewFolder {
  readonly id: FolderId
  readonly parentId: FolderId | null
  readonly title: string
}

/** Placement relative to a sibling folder. */
export type FolderPosition = 'before' | 'after'

/** Available card highlight colors. */
export const CARD_COLORS = ['yellow', 'red', 'green', 'blue', 'purple'] as const

/** A saved card highlight color. */
export type CardColor = typeof CARD_COLORS[number]

/** Locally persisted folder, card order, and text edits. */
export interface TranscriptDraft {
  readonly version: 3
  readonly order: readonly EntryKey[]
  /** Siblings appear in their saved order. Parent records precede their descendants. */
  readonly folders: readonly ReviewFolder[]
  readonly assignments: Readonly<Partial<Record<EntryKey, FolderId>>>
  readonly texts: Readonly<Record<string, string>>
  readonly recognized: Readonly<Partial<Record<EntryKey, 'text' | 'empty'>>>
  readonly colors: Readonly<Partial<Record<EntryKey, CardColor>>>
}

/** One edit to apply to the latest committed draft. */
export type TranscriptEdit =
  | { readonly kind: 'order'; readonly order: readonly EntryKey[] }
  | { readonly kind: 'createFolder'; readonly folder: ReviewFolder }
  | { readonly kind: 'renameFolder'; readonly id: FolderId; readonly title: string }
  | { readonly kind: 'moveFolder'; readonly id: FolderId; readonly anchor: FolderId; readonly position: FolderPosition }
  | { readonly kind: 'deleteFolder'; readonly id: FolderId; readonly unfiledOrder: readonly EntryKey[] }
  | { readonly kind: 'file'; readonly keys: readonly EntryKey[]; readonly folderId: FolderId | null; readonly destinationOrder: readonly EntryKey[] }
  | { readonly kind: 'text' | 'recognized'; readonly key: EntryKey; readonly value: string }
  | { readonly kind: 'color'; readonly key: EntryKey; readonly value: CardColor | undefined }

/** The saved screenshot and its editable text. */
export interface TranscriptEntry<Clip> {
  readonly key: EntryKey
  readonly clip: Clip
  readonly text: string
  readonly recognition: TranscriptDraft['recognized'][EntryKey]
  readonly color: CardColor | undefined
}

/** A folder in depth-first order, with its depth relative to the root. */
export interface FolderRow extends ReviewFolder {
  readonly depth: number
  readonly children: boolean
}

/** One chapter and its direct cards in the complete transcript. */
export type TranscriptSection<Clip> =
  | { readonly kind: 'folder'; readonly folder: FolderRow; readonly entries: readonly TranscriptEntry<Clip>[] }
  | { readonly kind: 'unfiled'; readonly heading: boolean; readonly entries: readonly TranscriptEntry<Clip>[] }

/** Initial state for Sessions whose only saved records are screenshots. */
export const EMPTY_DRAFT: TranscriptDraft = { version: 3, order: [], folders: [], assignments: {}, texts: {}, recognized: {}, colors: {} }

/**
 * Format the source prefix used in the card and the exported transcript.
 * @param fileName - source file name, including any extension.
 * @returns the name in brackets with its final extension removed.
 */
export function cardSourceLabel(fileName: string): string {
  const suffix = fileName.lastIndexOf('.')
  const name = suffix > 0 && suffix < fileName.length - 1 ? fileName.slice(0, suffix) : fileName
  return `【${name}】`
}

/**
 * Join card text without losing either value or introducing labels.
 * @param first - existing text.
 * @param second - additional text.
 * @returns both texts in reading order, separated by a blank line when both are present.
 */
export function joinCardText(first: string, second: string): string {
  return first === '' || second === '' ? first + second : `${first}\n\n${second}`
}

function mergeOrder(current: readonly EntryKey[], order: readonly EntryKey[]): readonly EntryKey[] {
  const edited = new Set(order)
  const next = edited.values()
  return [...current.map(key => edited.has(key) ? next.next().value ?? key : key), ...next]
}

function moveFolder(draft: TranscriptDraft, edit: Extract<TranscriptEdit, { kind: 'moveFolder' }>): TranscriptDraft {
  const moving = draft.folders.find(folder => folder.id === edit.id)
  const anchor = draft.folders.find(folder => folder.id === edit.anchor)
  if (moving === undefined || anchor === undefined || moving === anchor || moving.parentId !== anchor.parentId) return draft
  const next = draft.folders.filter(folder => folder !== moving)
  next.splice(next.indexOf(anchor) + (edit.position === 'after' ? 1 : 0), 0, moving)
  // The stored array keeps parents before their descendants even when sibling branches change places.
  const folders = folderRows(next).map(({ id, parentId, title }) => ({ id, parentId, title }))
  return { ...draft, folders }
}

function deleteFolder(draft: TranscriptDraft, edit: Extract<TranscriptEdit, { kind: 'deleteFolder' }>): TranscriptDraft {
  if (!draft.folders.some(folder => folder.id === edit.id)) return draft
  const removed = new Set<FolderId>([edit.id])
  for (const folder of draft.folders) {
    if (folder.parentId !== null && removed.has(folder.parentId)) removed.add(folder.id)
  }
  const inRemovedFolder = (id: FolderId | undefined): boolean => id !== undefined && removed.has(id)
  const folders = draft.folders.filter(folder => !removed.has(folder.id))
  const assignments = Object.fromEntries(Object.entries(draft.assignments).filter(([, id]) => !inRemovedFolder(id)))
  const retained = draft.order.filter(key => !inRemovedFolder(draft.assignments[key]))
  const ordered = new Set(retained)
  const previousUnfiled = edit.unfiledOrder.filter(key => !ordered.has(key) && draft.assignments[key] === undefined)
  const moved = draft.order.filter(key => inRemovedFolder(draft.assignments[key]))
  return { ...draft, folders, assignments, order: [...retained, ...previousUnfiled, ...moved] }
}

function hasFolder(draft: TranscriptDraft, id: FolderId | null): boolean {
  return id === null || draft.folders.some(folder => folder.id === id)
}

/**
 * Apply one edit without overwriting unrelated fields of the stored draft.
 * @param draft - current committed or on-screen draft.
 * @param edit - edit anchored to stable identities.
 * @returns the updated draft.
 */
export function editTranscript(draft: TranscriptDraft, edit: TranscriptEdit): TranscriptDraft {
  switch (edit.kind) {
    case 'order': return { ...draft, order: mergeOrder(draft.order, edit.order) }
    case 'createFolder': return hasFolder(draft, edit.folder.id) || !hasFolder(draft, edit.folder.parentId) ? draft
      : { ...draft, folders: [...draft.folders, edit.folder] }
    case 'renameFolder': return {
      ...draft, folders: draft.folders.map(folder => folder.id === edit.id ? { ...folder, title: edit.title } : folder),
    }
    case 'moveFolder': return moveFolder(draft, edit)
    case 'deleteFolder': return deleteFolder(draft, edit)
    case 'file': {
      if (!hasFolder(draft, edit.folderId)) return draft
      const keys = edit.keys.filter(key => (draft.assignments[key] ?? null) !== edit.folderId)
      if (keys.length === 0) return draft
      const moving = new Set<string>(keys)
      const assignments = Object.fromEntries(Object.entries(draft.assignments).filter(([key]) => !moving.has(key)))
      if (edit.folderId !== null) {
        for (const key of keys) assignments[key] = edit.folderId
      }
      const order = draft.order.filter(key => !moving.has(key))
      const ordered = new Set(order)
      const missing = edit.destinationOrder.filter(key => !moving.has(key) && !ordered.has(key)
        && (assignments[key] ?? null) === edit.folderId)
      return { ...draft, assignments, order: [...order, ...missing, ...keys] }
    }
    case 'text': {
      const texts = { ...draft.texts, [edit.key]: edit.value }
      if (edit.value.trim() !== '' || draft.recognized[edit.key] === undefined) return { ...draft, texts }
      const { [edit.key]: _cleared, ...recognized } = draft.recognized
      return { ...draft, texts, recognized }
    }
    case 'color': {
      const { [edit.key]: _previous, ...rest } = draft.colors
      const colors = edit.value === undefined ? rest : { ...rest, [edit.key]: edit.value }
      return { ...draft, colors }
    }
    case 'recognized': {
      if (draft.recognized[edit.key] === 'text') return draft
      const text = edit.value.trim()
      const previous = draft.texts[edit.key] ?? ''
      return {
        ...draft,
        recognized: { ...draft.recognized, [edit.key]: text === '' ? 'empty' : 'text' },
        texts: { ...draft.texts, [edit.key]: previous.trim() === '' ? text : joinCardText(previous, text) },
      }
    }
  }
}

/**
 * Build the card list in edited order, appending new screenshots in capture order.
 * @param clips - committed screenshots in capture order.
 * @param draft - saved order and editable text.
 * @returns resolved screenshot cards.
 */
export function transcriptEntries<Clip extends { readonly id: number }>(
  clips: readonly Clip[],
  draft: TranscriptDraft,
): readonly TranscriptEntry<Clip>[] {
  const available = new Map<EntryKey, TranscriptEntry<Clip>>()
  for (const clip of clips) {
    const key = `clip:${clip.id}` as const
    available.set(key, { key, clip, text: draft.texts[key] ?? '', recognition: draft.recognized[key], color: draft.colors[key] })
  }
  const ordered = draft.order.flatMap((key) => {
    const entry = available.get(key)
    if (entry === undefined) return []
    available.delete(key)
    return [entry]
  })
  return [...ordered, ...available.values()]
}

/**
 * List folders depth-first in saved sibling order.
 * @param folders - the saved folder records.
 * @param collapsed - optional folders whose descendants should be hidden.
 * @returns visible folders with their indentation depth.
 */
export function folderRows(folders: readonly ReviewFolder[], collapsed?: ReadonlySet<FolderId>): readonly FolderRow[] {
  const groups = new Map<FolderId | null, ReviewFolder[]>()
  for (const folder of folders) {
    const siblings = groups.get(folder.parentId)
    if (siblings === undefined) groups.set(folder.parentId, [folder])
    else siblings.push(folder)
  }
  const rows: FolderRow[] = []
  const stack = (groups.get(null) ?? []).map(folder => ({ folder, depth: 0 })).reverse()
  while (true) {
    const pending = stack.pop()
    if (pending === undefined) return rows
    const { folder, depth } = pending
    const children = groups.get(folder.id)
    rows.push({ ...folder, depth, children: children !== undefined })
    if (children !== undefined && !collapsed?.has(folder.id)) {
      for (const child of [...children].reverse()) stack.push({ folder: child, depth: depth + 1 })
    }
  }
}

/**
 * Arrange chapters for both the complete transcript view and the HTML export.
 * @param entries - every card in saved order.
 * @param draft - saved folder order and card assignments.
 * @returns depth-first chapters followed by any unfiled cards.
 */
export function transcriptSections<Clip>(
  entries: readonly TranscriptEntry<Clip>[],
  draft: TranscriptDraft,
): readonly TranscriptSection<Clip>[] {
  const byFolder = new Map<FolderId | null, TranscriptEntry<Clip>[]>()
  for (const entry of entries) {
    const id = draft.assignments[entry.key] ?? null
    const group = byFolder.get(id)
    if (group === undefined) byFolder.set(id, [entry])
    else group.push(entry)
  }
  const sections: TranscriptSection<Clip>[] = folderRows(draft.folders)
    .map(folder => ({ kind: 'folder', folder, entries: byFolder.get(folder.id) ?? [] }))
  const unfiled = byFolder.get(null)
  if (unfiled !== undefined) sections.push({ kind: 'unfiled', heading: sections.length > 0, entries: unfiled })
  return sections
}

/**
 * Move one or more cards to a gap while preserving their current relative order.
 * @param order - existing visible order.
 * @param keys - cards being moved.
 * @param gap - insertion point before removing the moved cards.
 * @returns reordered keys or the same array if the position did not change.
 */
export function moveEntries(order: readonly EntryKey[], keys: readonly EntryKey[], gap: number): readonly EntryKey[] {
  const selected = new Set(keys)
  const moving = order.filter(key => selected.has(key))
  const next = order.filter(key => !selected.has(key))
  const at = order.slice(0, gap).filter(key => !selected.has(key)).length
  next.splice(at, 0, ...moving)
  return next.every((key, index) => key === order[index]) ? order : next
}
