/** Local screenshot transactions and the persisted source records. */

import { IDBFactory } from 'fake-indexeddb'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { listClips, readDraft, readSavedReviews, saveClip, writeDraft } from '../src/client/clip-store.ts'

const clip = {
  sessionId: 'session-one',
  resourceAddress: 'dsh-resource://file/session/session-one/notes.pdf',
  fileName: 'notes.pdf',
  png: new Blob(['image'], { type: 'image/png' }),
}

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { vi.unstubAllGlobals() })

it('commits PNGs with their source and reads in capture order in the requested Session', async () => {
  await saveClip(clip)
  await saveClip({ ...clip, fileName: 'second.pdf' })
  await saveClip({ ...clip, sessionId: 'session-two' })
  const clips = await listClips(clip.sessionId)
  expect(clips.map(item => item.fileName)).toEqual(['notes.pdf', 'second.pdf'])
  expect(clips[0]?.resourceAddress).toBe(clip.resourceAddress)
  expect(await clips[0]?.png.text()).toBe('image')
  expect(await listClips('empty-session')).toEqual([])
})

it('finds saved evidence and headings while leaving empty reviews out', async () => {
  const evidence = SessionId('evidence')
  const outline = SessionId('outline')
  const empty = SessionId('empty')
  await saveClip({ ...clip, sessionId: evidence, destination: 'evidence' })
  await writeDraft(outline, { kind: 'createFolder', folder: { id: 'folder:1', parentId: null, title: 'Contracts' } })
  await writeDraft(empty, { kind: 'text', key: 'clip:1', value: ' ' })
  expect(await readSavedReviews([evidence, outline, empty])).toEqual(new Set([evidence, outline]))
})

it.each([
  { resourceAddress: 'https://example.test/' }, { resourceAddress: 7 }, { resourceAddress: undefined },
  { fileName: 7 }, { fileName: undefined },
  { png: '' }, { png: undefined }, { png: new Blob(['image']) }, { png: new Blob([], { type: 'image/png' }) },
  { id: 'invalid-key' }, { id: 0.5 },
])('reports an invalid persisted screenshot (%j)', async (patch) => {
  // Seed invalid data through the browser database, as a previous writer could.
  await saveClip(clip)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dsh-document-review')
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(new Error('could not open the test database')) }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const write = db.transaction('clips', 'readwrite')
      write.objectStore('clips').add({ ...clip, ...patch })
      write.oncomplete = () => { resolve() }
      write.onabort = () => { reject(new Error('could not seed the test record')) }
    })
  } finally { db.close() }
  await expect(listClips(clip.sessionId)).rejects.toThrow('invalid stored screenshot')
})

it('rejects a transaction that cannot commit and retains the first record', async () => {
  const existing = { ...clip, id: 42 }
  await saveClip(existing)
  await expect(saveClip(existing)).rejects.toMatchObject({ cause: { name: 'ConstraintError' } })
  expect(await listClips(clip.sessionId)).toHaveLength(1)
})

it('reports when the stored database version cannot be opened', async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('dsh-document-review', 3)
    request.onsuccess = () => { request.result.close(); resolve() }
    request.onerror = () => { reject(new Error('could not create the test database')) }
  })
  await expect(listClips(clip.sessionId)).rejects.toMatchObject({ cause: { name: 'VersionError' } })
})

it('preserves version-one screenshots and stores edits independently across sessions', async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('dsh-document-review', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('clips', { keyPath: 'id', autoIncrement: true })
      store.createIndex('sessionId', 'sessionId')
      store.add(clip)
    }
    request.onsuccess = () => { request.result.close(); resolve() }
    request.onerror = () => { reject(new Error('could not create the original database')) }
  })
  expect(await listClips(clip.sessionId)).toHaveLength(1)
  expect((await readDraft(clip.sessionId)).order).toEqual([])
  await writeDraft(clip.sessionId, { kind: 'text', key: 'clip:1', value: 'Note' })
  const recognized = { kind: 'recognized', key: 'clip:1', value: 'Extracted' } as const
  await Promise.all([
    writeDraft(clip.sessionId, recognized),
    writeDraft(clip.sessionId, recognized),
    writeDraft(clip.sessionId, { kind: 'createFolder', folder: { id: 'folder:aa', parentId: null, title: 'Evidence' } }),
    writeDraft(clip.sessionId, { kind: 'color', key: 'clip:1', value: 'blue' }),
  ])
  expect(await readDraft(clip.sessionId)).toEqual({
    version: 3, order: [], folders: [{ id: 'folder:aa', parentId: null, title: 'Evidence' }], assignments: {},
    texts: { 'clip:1': 'Note\n\nExtracted' }, recognized: { 'clip:1': 'text' }, colors: { 'clip:1': 'blue' },
  })
  await writeDraft(clip.sessionId, { kind: 'color', key: 'clip:1', value: undefined })
  expect((await readDraft(clip.sessionId)).colors).toEqual({})
  expect((await readDraft('other-session')).texts).toEqual({})
})

async function seedDraft(data: object): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dsh-document-review', 2)
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(new Error('could not open the legacy database', { cause: request.error })) }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('transcripts', 'readwrite')
      tx.objectStore('transcripts').put(data, clip.sessionId)
      tx.oncomplete = () => { resolve() }
      tx.onabort = () => { reject(new Error('could not seed the legacy draft', { cause: tx.error })) }
    })
  } finally { db.close() }
}

it('converts ordered legacy sections to folders and keeps unseen screenshots unfiled', async () => {
  await saveClip(clip)
  await saveClip({ ...clip, fileName: 'in-section.pdf' })
  await saveClip({ ...clip, fileName: 'later.pdf' })
  await seedDraft({
    order: ['clip:1', 'section:aa', 'clip:2', 'section:bb'],
    sections: { 'section:aa': 'Payment', 'section:bb': '' },
    extracts: { 'clip:2': 'Original' }, notes: { 'clip:1': 'Comment', 'clip:2': 'Check this' },
  })
  const draft = await readDraft(clip.sessionId)
  expect(draft.folders).toEqual([{ id: 'folder:aa', parentId: null, title: 'Payment' }, { id: 'folder:bb', parentId: null, title: '' }])
  expect(draft.assignments).toEqual({ 'clip:2': 'folder:aa' })
  expect(draft.order).toEqual(['clip:1', 'clip:2'])
  expect(draft.texts).toEqual({ 'clip:1': 'Comment', 'clip:2': 'Original\n\nCheck this' })
  expect(draft.recognized).toEqual({ 'clip:2': 'text' })
  await writeDraft(clip.sessionId, { kind: 'renameFolder', id: 'folder:bb', title: 'Witnesses' })
  expect((await readDraft(clip.sessionId)).folders.at(-1)?.title).toBe('Witnesses')
  expect((await listClips(clip.sessionId)).map(item => item.id)).toEqual([1, 2, 3])
})

it('restores recognition for a draft saved with cleared text and a completed status', async () => {
  await saveClip(clip)
  await seedDraft({
    version: 3, order: [], folders: [], assignments: {}, extracts: { 'clip:1': '', 'clip:2': 'Existing text' },
    notes: {}, recognized: { 'clip:1': 'text', 'clip:2': 'text' },
  })
  expect((await readDraft(clip.sessionId)).recognized).toEqual({ 'clip:2': 'text' })
  await writeDraft(clip.sessionId, { kind: 'recognized', key: 'clip:1', value: '' })
  expect((await readDraft(clip.sessionId)).recognized['clip:1']).toBe('empty')
  await writeDraft(clip.sessionId, { kind: 'recognized', key: 'clip:1', value: 'Recovered text' })
  const draft = await readDraft(clip.sessionId)
  expect(draft.texts).toEqual({ 'clip:1': 'Recovered text', 'clip:2': 'Existing text' })
  expect(draft.recognized).toEqual({ 'clip:1': 'text', 'clip:2': 'text' })
})
