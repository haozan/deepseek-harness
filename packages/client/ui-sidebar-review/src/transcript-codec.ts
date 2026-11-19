/** Decode portable and legacy review drafts with the same validation. */

import { CARD_COLORS, EMPTY_DRAFT, joinCardText, type CardColor, type EntryKey, type FolderId, type ReviewFolder, type TranscriptDraft } from './transcript.ts'

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringMap(value: unknown): value is Readonly<Record<string, string>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string')
}

function entryKey(value: unknown): value is EntryKey {
  return typeof value === 'string' && /^clip:[1-9]\d*$/u.test(value)
}

function folderId(value: unknown): value is FolderId {
  return typeof value === 'string' && /^folder:[a-f0-9-]+$/u.test(value)
}

/**
 * Decode a saved draft, including drafts written by earlier test builds.
 * @param value - stored draft.
 * @returns the editable review state.
 */
export function decodeDraft(value: unknown): TranscriptDraft {
  if (value === undefined) return EMPTY_DRAFT
  if (typeof value !== 'object' || value === null
    || !('order' in value) || !Array.isArray(value.order)
    || !('extracts' in value) || !stringMap(value.extracts)
    || !('notes' in value) || !stringMap(value.notes)) throw new Error('Invalid stored review transcript')
  const keys: readonly unknown[] = value.order
  const order: EntryKey[] = []
  const folders: ReviewFolder[] = []
  const assignments: Partial<Record<EntryKey, FolderId>> = {}
  const seen = new Set<FolderId>()
  if ('version' in value) {
    if (value.version !== 3 || !keys.every(entryKey)
      || !('folders' in value) || !Array.isArray(value.folders) || !('assignments' in value) || !stringMap(value.assignments)) {
      throw new Error('Invalid stored review folders')
    }
    const records: readonly unknown[] = value.folders
    for (const record of records) {
      if (typeof record !== 'object' || record === null
        || !('id' in record) || !folderId(record.id) || seen.has(record.id)
        || !('parentId' in record) || (record.parentId !== null && (!folderId(record.parentId) || !seen.has(record.parentId)))
        || !('title' in record) || typeof record.title !== 'string') throw new Error('Invalid stored review folder')
      seen.add(record.id)
      folders.push({ id: record.id, parentId: record.parentId, title: record.title })
    }
    for (const [key, id] of Object.entries(value.assignments)) {
      if (!entryKey(key) || !folderId(id) || !seen.has(id)) throw new Error('Invalid stored review folder assignment')
      assignments[key] = id
    }
    order.push(...keys)
  } else {
    if (!('sections' in value) || !stringMap(value.sections)) throw new Error('Invalid stored review sections')
    let current: FolderId | undefined
    for (const key of new Set(keys)) {
      if (entryKey(key)) {
        order.push(key)
        if (current !== undefined) assignments[key] = current
        continue
      }
      if (typeof key !== 'string' || !/^section:[a-f0-9-]+$/u.test(key)) throw new Error('Invalid stored review entry')
      if (!Object.hasOwn(value.sections, key)) continue
      current = `folder:${key.slice('section:'.length)}`
      folders.push({ id: current, parentId: null, title: value.sections[key] ?? '' })
    }
  }
  const { extracts, notes } = value
  const texts = Object.fromEntries([...new Set([...Object.keys(extracts), ...Object.keys(notes)])]
    .map(key => [key, joinCardText(extracts[key] ?? '', notes[key] ?? '')]))
  const recognized: Partial<Record<EntryKey, 'text' | 'empty'>> = {}
  if ('recognized' in value) {
    if (!record(value.recognized)) throw new Error('Invalid stored review recognition status')
    for (const [key, status] of Object.entries(value.recognized)) {
      if (!entryKey(key) || (status !== 'text' && status !== 'empty')) throw new Error('Invalid stored review recognition status')
      if (status === 'text' && (texts[key] ?? '').trim() === '') continue
      recognized[key] = status
    }
  } else {
    for (const [key, extract] of Object.entries(extracts)) {
      if (entryKey(key) && extract.trim() !== '') recognized[key] = 'text'
    }
  }
  const colors: Partial<Record<EntryKey, CardColor>> = {}
  if ('colors' in value) {
    if (!record(value.colors)) throw new Error('Invalid stored review card colors')
    for (const [key, saved] of Object.entries(value.colors)) {
      const color = CARD_COLORS.find(color => color === saved)
      if (!entryKey(key) || color === undefined) throw new Error('Invalid stored review card color')
      colors[key] = color
    }
  }
  return { version: 3, order: [...new Set(order)], folders, assignments, texts, recognized, colors }
}

/**
 * Encode a draft using the same fields as the local IndexedDB reader.
 * @param draft - editable review state.
 * @returns the durable draft fields.
 */
export function encodeDraft(draft: TranscriptDraft): Omit<TranscriptDraft, 'texts'> & {
  readonly extracts: TranscriptDraft['texts']
  readonly notes: Readonly<Record<string, string>>
} {
  const { texts, ...fields } = draft
  return { ...fields, extracts: texts, notes: {} }
}
