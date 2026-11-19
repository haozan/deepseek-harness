/** Serializes review screenshot requests and keeps recognition results retryable until saved. */

import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ReviewClip } from './clip-store.ts'
import type { EntryKey } from '../transcript.ts'

/** Observable state for an individual screenshot request. */
export type RecognitionStatus = 'queued' | 'running' | 'failed' | 'saveFailed'

interface RecognitionOptions {
  readonly signal: AbortSignal
  readonly recognize: (clip: ReviewClip, signal: AbortSignal, pendingSignal?: AbortSignal) => Promise<string | undefined>
  readonly save: (clip: ReviewClip, text: string) => Promise<void>
}

interface RecognitionQueue {
  readonly statuses: ObservableSnapshot<Readonly<Partial<Record<EntryKey, RecognitionStatus>>>>
  readonly enqueue: (clips: readonly ReviewClip[], pendingSignal?: AbortSignal) => void
}

/**
 * Process screenshots in order, sharing in-flight work across capture and manual requests.
 * @param options - lifetime, recognition, and result storage. An undefined result means the card already has recognized text.
 * @returns the request queue. A pending signal can cancel requests that have yet to start.
 */
export function createRecognitionQueue(options: RecognitionOptions): RecognitionQueue {
  const { signal, recognize, save } = options
  const statuses = createSnapshotStore<Readonly<Partial<Record<EntryKey, RecognitionStatus>>>>({})
  const results = new Map<EntryKey, string>()
  let pending = Promise.resolve()
  const cancelled = (): boolean => signal.aborted

  const setStatus = (key: EntryKey, status: RecognitionStatus | undefined): void => {
    const { [key]: _previous, ...rest } = statuses.getSnapshot()
    statuses.set(status === undefined ? rest : { ...rest, [key]: status })
  }

  const enqueue: RecognitionQueue['enqueue'] = (clips, pendingSignal) => {
    for (const clip of clips) {
      const key = `clip:${clip.id}` as const
      const status = statuses.getSnapshot()[key]
      if (status === 'queued' || status === 'running') continue
      setStatus(key, 'queued')
      pending = pending.then(async () => {
        if (cancelled() || pendingSignal?.aborted === true) {
          setStatus(key, undefined)
          return
        }
        setStatus(key, 'running')
        try {
          const text = results.get(key) ?? await recognize(clip, signal, pendingSignal)
          if (!cancelled() && text !== undefined) {
            results.set(key, text)
            await save(clip, text)
            results.delete(key)
          }
          setStatus(key, undefined)
        } catch (_error: unknown) {
          setStatus(key, cancelled() ? undefined : results.has(key) ? 'saveFailed' : 'failed')
        }
      })
    }
  }
  return { statuses, enqueue }
}
