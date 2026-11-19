/** Automatic and manual recognition share the same serial queue. */

import { expect, it, vi } from 'vitest'
import type { ReviewClip } from '../src/client/clip-store.ts'
import { createRecognitionQueue } from '../src/client/recognition.ts'

const first: ReviewClip = {
  id: 1, sessionId: 'review', resourceAddress: 'dsh-resource://file/session/review/source.txt',
  fileName: 'source.txt', png: new Blob(['png'], { type: 'image/png' }),
}
const second = { ...first, id: 2 }

it('deduplicates the current capture and drops queued automatic work when the switch is turned off', async () => {
  const lifetime = new AbortController()
  const pendingAutomatic = new AbortController()
  const active = Promise.withResolvers<string>()
  const recognize = vi.fn(() => active.promise)
  const save = vi.fn(async () => {})
  const queue = createRecognitionQueue({ signal: lifetime.signal, recognize, save })
  queue.enqueue([first, second], pendingAutomatic.signal)
  await vi.waitFor(() => { expect(queue.statuses.getSnapshot()).toEqual({ 'clip:1': 'running', 'clip:2': 'queued' }) })
  queue.enqueue([first])
  pendingAutomatic.abort()
  active.resolve('Recognized')
  await vi.waitFor(() => { expect(queue.statuses.getSnapshot()).toEqual({}) })
  expect(recognize).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledExactlyOnceWith(first, 'Recognized')
})

it('retries saving a completed result without sending the screenshot again', async () => {
  const recognize = vi.fn(async () => 'Recognized')
  const save = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Storage unavailable'))
  const queue = createRecognitionQueue({ signal: new AbortController().signal, recognize, save })
  queue.enqueue([first])
  await vi.waitFor(() => { expect(queue.statuses.getSnapshot()).toEqual({ 'clip:1': 'saveFailed' }) })
  queue.enqueue([first])
  await vi.waitFor(() => { expect(queue.statuses.getSnapshot()).toEqual({}) })
  expect(recognize).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledTimes(2)
  expect(save).toHaveBeenLastCalledWith(first, 'Recognized')
})
