/** Durable local screenshots and source addresses, scoped to the originating Session. */

import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentCaptureLocation } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { editTranscript, type TranscriptDraft, type TranscriptEdit } from '../transcript.ts'
import { decodeDraft, encodeDraft } from '../transcript-codec.ts'

/** One committed screenshot. The id identifies the record in the local database. */
export interface ReviewClip {
  readonly id: number
  readonly sessionId: string
  readonly resourceAddress: string
  readonly fileName: string
  readonly png: Blob
  /** Absence places the capture in the review transcript. */
  readonly destination?: 'evidence'
  /** Older captures carry only the source address. */
  readonly location?: DocumentCaptureLocation
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dsh-document-review', 2)
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        const clips = request.result.createObjectStore('clips', { keyPath: 'id', autoIncrement: true })
        clips.createIndex('sessionId', 'sessionId')
      }
      request.result.createObjectStore('transcripts')
    }
    request.onerror = () => { reject(new Error('Cannot open the review database', { cause: request.error })) }
    request.onsuccess = () => { resolve(request.result) }
  })
}

type ReviewStore = 'clips' | 'transcripts'

async function transact<Result>(
  stores: ReviewStore | ReviewStore[], mode: IDBTransactionMode,
  run: (transaction: IDBTransaction, complete: (result: Result) => void) => void,
): Promise<Result> {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(stores, mode)
      transaction.onabort = () => { reject(new Error('Review transaction aborted', { cause: transaction.error })) }
      run(transaction, (result) => {
        transaction.oncomplete = () => { resolve(result) }
      })
    })
  } finally {
    db.close()
  }
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

function surfacePoint(value: unknown): boolean {
  return record(value) && nonNegativeInteger(value.page) && finite(value.x) && finite(value.y)
}

function rowPoint(value: unknown): boolean {
  return record(value) && nonNegativeInteger(value.index) && finite(value.offset)
}

/**
 * Check a stored locator against the supported preview geometry.
 * @param value - location read from disk.
 * @returns whether it can be passed to a document viewer.
 */
export function captureLocation(value: unknown): value is DocumentCaptureLocation {
  if (!record(value) || typeof value.renderer !== 'string' || typeof value.version !== 'string' || !record(value.area)) return false
  const area = value.area
  switch (area.kind) {
    case 'surface': return surfacePoint(area.first) && surfacePoint(area.last)
    case 'rows': return rowPoint(area.first) && rowPoint(area.last) && finite(area.x) && positive(area.width)
      && (area.viewportWidth === undefined || positive(area.viewportWidth))
    case 'scroll': return record(area.rect) && finite(area.rect.x) && finite(area.rect.y)
      && positive(area.rect.width) && positive(area.rect.height)
    default: return false
  }
}

function isReviewClip(value: unknown, sessionId: string): value is Omit<ReviewClip, 'location'> & { readonly location?: unknown } {
  if (typeof value !== 'object' || value === null
    || !('id' in value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id)
    || !('sessionId' in value) || value.sessionId !== sessionId
    || !('fileName' in value) || typeof value.fileName !== 'string'
    || !('png' in value) || !(value.png instanceof Blob) || value.png.type !== 'image/png' || value.png.size === 0
    || !('resourceAddress' in value) || typeof value.resourceAddress !== 'string'
    || ('destination' in value && value.destination !== 'evidence')) return false
  const source = parseFileAddress(value.resourceAddress)
  return source?.scope === 'session'
}

/**
 * Commit the PNG and its source together before reporting success.
 * @param clip - screenshot and source details for the current Session.
 * @returns the committed capture's identifier.
 */
export function saveClip(clip: Omit<ReviewClip, 'id'>): Promise<number> {
  return transact<number>('clips', 'readwrite', (transaction, complete) => {
    const request = transaction.objectStore('clips').add(clip)
    request.onsuccess = () => {
      if (typeof request.result === 'number') complete(request.result)
      else transaction.abort()
    }
  })
}

/**
 * Read captures in saved order with their source addresses and supported positions.
 * @param sessionId - Session whose screenshots are requested.
 * @returns the Session's committed screenshot records.
 */
export async function listClips(sessionId: string): Promise<readonly ReviewClip[]> {
  const rows = await transact<readonly unknown[]>('clips', 'readonly', (transaction, complete) => {
    const request = transaction.objectStore('clips').index('sessionId').getAll(sessionId)
    request.onsuccess = () => { complete(request.result) }
  })
  const clips: ReviewClip[] = []
  for (const row of rows) {
    if (!isReviewClip(row, sessionId)) throw new Error('Document review: invalid stored screenshot')
    const { location, ...clip } = row
    clips.push(captureLocation(location) ? { ...clip, location } : clip)
  }
  return clips
}

/**
 * Read the saved draft for one Session, with an empty draft for screenshot-only Sessions.
 * @param sessionId - current Session.
 * @returns ordered entries and text edits.
 */
export async function readDraft(sessionId: string): Promise<TranscriptDraft> {
  const value = await transact<unknown>('transcripts', 'readonly', (transaction, complete) => {
    const request = transaction.objectStore('transcripts').get(sessionId)
    request.onsuccess = () => { complete(request.result) }
  })
  return decodeDraft(value)
}

/**
 * Identify reviews with saved work without reading the screenshot blobs.
 * @param sessionIds - workspace Sessions to check.
 * @returns Sessions containing captures, headings, or edited text.
 */
export async function readSavedReviews(sessionIds: readonly SessionId[]): Promise<ReadonlySet<SessionId>> {
  const saved = new Set<SessionId>()
  if (sessionIds.length === 0) return saved
  return transact<ReadonlySet<SessionId>>(['clips', 'transcripts'], 'readonly', (transaction, complete) => {
    const clips = transaction.objectStore('clips').index('sessionId')
    const transcripts = transaction.objectStore('transcripts')
    complete(saved)
    for (const sessionId of sessionIds) {
      const count = clips.count(sessionId)
      count.onsuccess = () => {
        if (count.result > 0) {
          saved.add(sessionId)
          return
        }
        const request = transcripts.get(sessionId)
        request.onsuccess = () => {
          const draft = decodeDraft(request.result)
          if (draft.folders.length > 0 || Object.values(draft.texts).some(text => text.trim() !== '')) saved.add(sessionId)
        }
      }
    }
  })
}

/**
 * Read, edit, and commit the latest draft in one transaction.
 * @param sessionId - current Session.
 * @param edit - one draft change.
 * @returns the draft committed by the transaction.
 */
export function writeDraft(sessionId: string, edit: TranscriptEdit): Promise<TranscriptDraft> {
  return transact<TranscriptDraft>('transcripts', 'readwrite', (transaction, complete) => {
    const store = transaction.objectStore('transcripts')
    const request = store.get(sessionId)
    request.onsuccess = () => {
      const updated = editTranscript(decodeDraft(request.result), edit)
      store.put(encodeDraft(updated), sessionId).onsuccess = () => { complete(updated) }
    }
  })
}
