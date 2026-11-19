// @vitest-environment jsdom
/** Review controls retain their source and surface capture or storage failures. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CaptureAction, REVIEW_KIND, ReviewTitle } from '../src/client/Review.tsx'
import { ReviewPanel } from '../src/client/TranscriptPanel.tsx'
import { editTranscript, EMPTY_DRAFT, type TranscriptDraft, type TranscriptEdit } from '../src/transcript.ts'
import { createRecognitionQueue } from '../src/client/recognition.ts'
import { en } from '../src/client/locales.ts'
import type { ReviewClip } from '../src/client/clip-store.ts'

const address = 'dsh-resource://file/session/session-one/notes.pdf'
const t = (key: keyof typeof en, params?: Record<string, unknown>): string =>
  en[key].replace('{name}', typeof params?.name === 'string' ? params.name : '')
const unshim: (() => void)[] = []
const revokeObjectURL = vi.fn()

function shim(target: object, key: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, value })
  unshim.push(() => {
    if (descriptor === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, descriptor)
  })
}

beforeEach(() => {
  shim(HTMLDialogElement.prototype, 'showModal', function (this: HTMLDialogElement) { this.open = true })
  shim(HTMLDialogElement.prototype, 'close', function (this: HTMLDialogElement) { this.open = false })
  shim(HTMLElement.prototype, 'setPointerCapture', vi.fn())
  shim(URL, 'createObjectURL', () => 'blob:review-clip')
  revokeObjectURL.mockClear()
  shim(URL, 'revokeObjectURL', revokeObjectURL)
})

afterEach(() => {
  cleanup()
  while (unshim.length > 0) unshim.pop()?.()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function captureAction() {
  const props = {
    sessionId: 'review-workbench-unit',
    resourceAddress: address, fileName: 'notes.pdf', t,
    getBounds: vi.fn<() => DOMRect | undefined>(() => new DOMRect(20, 30, 140, 100)),
    captureLocation: vi.fn<Parameters<typeof CaptureAction>[0]['captureLocation']>(),
    markCapture: vi.fn(),
    reportCaptureFrames: vi.fn(),
    readFrames: vi.fn(async () => []),
    useReviewRevision: (select: (revision: number) => unknown) => select(0),
    useAutoRecognition: (select: (on: boolean) => unknown) => select(true),
    hideCaptureFrame: vi.fn(),
    capture: vi.fn(async () => Uint8Array.of(137, 80, 78, 71)),
    save: vi.fn<Parameters<typeof CaptureAction>[0]['save']>(async () => 17),
    openTab: vi.fn(),
  }
  const view = render(<CaptureAction {...props as Parameters<typeof CaptureAction>[0]} />)
  return { ...view, ...props, click: () => { fireEvent.click(screen.getByRole('button', { name: en.capture })) } }
}

function pointer(target: Element, event: string, clientX: number, clientY: number, pointerId = 1, button = 0, isPrimary = true): void {
  fireEvent(target, new PointerEvent(event, { bubbles: true, clientX, clientY, pointerId, button, isPrimary }))
}

function area(): HTMLElement {
  const child = screen.getByRole('dialog').firstElementChild
  if (!(child instanceof HTMLElement)) throw new Error('Selection has no capture area')
  return child
}

function select(): void {
  const surface = area()
  pointer(surface, 'pointerdown', 35, 45)
  pointer(surface, 'pointermove', 85, 90)
  pointer(surface, 'pointerup', 85, 90)
}

it('saves the clamped selection as a PNG with its source position before opening Review', async () => {
  const action = captureAction()
  const location = { renderer: 'pdf', version: '1', area: { kind: 'scroll', rect: { x: 0, y: 0, width: 70, height: 40 } } } as const
  action.captureLocation.mockReturnValue(location)
  action.click()
  const surface = area()
  pointer(surface, 'pointerdown', 80, 65, 2, 0, false)
  pointer(surface, 'pointerdown', 80, 65, 1, 2)
  pointer(surface, 'pointermove', 40, 45)
  pointer(surface, 'pointerup', 40, 45)
  pointer(surface, 'pointerdown', 90, 70)
  pointer(surface, 'pointermove', 30, 40, 2)
  pointer(surface, 'pointerup', 90, 70, 2)
  pointer(surface, 'pointercancel', 90, 70, 2)
  pointer(surface, 'pointerup', 90, 70)
  expect(action.capture).not.toHaveBeenCalled()

  pointer(surface, 'pointerdown', 90, 70)
  pointer(surface, 'pointermove', 0, 10)
  pointer(surface, 'pointerup', 0, 10)
  await waitFor(() => { expect(action.openTab).toHaveBeenCalledExactlyOnceWith(REVIEW_KIND, { beside: true }) })
  expect(action.capture).toHaveBeenCalledExactlyOnceWith({ x: 20, y: 30, width: 70, height: 40 })
  expect(action.captureLocation).toHaveBeenCalledExactlyOnceWith({ x: 20, y: 30, width: 70, height: 40 })
  const captureId = action.save.mock.calls[0]?.[0].captureId
  expect(captureId).toMatch(/^[a-f0-9-]{36}$/u)
  expect(action.save).toHaveBeenCalledExactlyOnceWith({
    captureId,
    resourceAddress: address, fileName: 'notes.pdf', location, png: new Blob([Uint8Array.of(137, 80, 78, 71)], { type: 'image/png' }),
  }, REVIEW_KIND)
  expect(action.hideCaptureFrame.mock.calls).toEqual([[true], [false]])
  expect(action.markCapture).toHaveBeenCalledExactlyOnceWith(location, { key: REVIEW_KIND, id: 17 })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('ignores unavailable bounds and cancels pointer or native dialog cancellation', () => {
  const action = captureAction()
  action.getBounds.mockReturnValueOnce(undefined).mockReturnValueOnce(new DOMRect(25, 25, 1, 2))
  action.click()
  action.click()
  expect(screen.queryByRole('dialog')).toBeNull()
  action.click()
  pointer(area(), 'pointerdown', 40, 50)
  pointer(area(), 'pointercancel', 60, 70)
  action.click()
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(action.capture).not.toHaveBeenCalled()
})

it('keeps the action available when capture fails', async () => {
  const action = captureAction()
  action.capture.mockRejectedValueOnce(new Error('no pixels'))
  action.click()
  select()
  expect((await screen.findByRole('alert')).textContent).toBe(en.saveFailed)
  expect(action.save).not.toHaveBeenCalled()
  expect(action.openTab).not.toHaveBeenCalled()
  action.click()
  select()
  await waitFor(() => { expect(action.openTab).toHaveBeenCalledWith(REVIEW_KIND, { beside: true }) })
})

it('drops capture results when the source toolbar unmounts', async () => {
  const action = captureAction()
  const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>()
  action.capture.mockReturnValueOnce(pending.promise)
  action.click()
  select()
  await waitFor(() => { expect(action.capture).toHaveBeenCalledOnce() })
  action.unmount()
  await act(async () => { pending.resolve(Uint8Array.of(137)); await pending.promise })
  expect(action.save).not.toHaveBeenCalled()
  expect(action.openTab).not.toHaveBeenCalled()
})

it('does not capture if the toolbar closes before the next paint', async () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  const action = captureAction()
  action.click()
  select()
  action.unmount()
  await act(async () => {
    frames.shift()?.(1)
    frames.shift()?.(2)
  })
  expect(action.capture).not.toHaveBeenCalled()
})

it('does not navigate after a save settles for a closed toolbar', async () => {
  const action = captureAction()
  const pending = Promise.withResolvers<number>()
  action.save.mockReturnValueOnce(pending.promise)
  action.click()
  select()
  await waitFor(() => { expect(action.save).toHaveBeenCalledOnce() })
  action.unmount()
  await act(async () => { pending.resolve(17); await pending.promise })
  expect(action.openTab).not.toHaveBeenCalled()
})

it('draws the review tab title', () => {
  render(<ReviewTitle {...{ t } as Parameters<typeof ReviewTitle>[0]} />)
  expect(screen.getByText(en.transcript, { exact: true })).toBeDefined()
})

function panel(
  read: () => Promise<readonly ReviewClip[]>,
  recognize: (png: Blob, signal: AbortSignal) => Promise<string> = vi.fn(async () => '识别结果'),
  saved = EMPTY_DRAFT,
) {
  const openResource = vi.fn()
  const recognitionRevision = createSnapshotStore(0)
  const signal = new AbortController().signal
  let stored = saved
  const write = vi.fn(async (edit: TranscriptEdit) => {
    stored = editTranscript(stored, edit)
    return stored
  })
  const queue = createRecognitionQueue({
    signal,
    recognize: (clip, signal) => recognize(clip.png, signal),
    save: async (clip, value) => {
      await write({ kind: 'recognized', key: `clip:${clip.id}`, value })
      recognitionRevision.set(recognitionRevision.getSnapshot() + 1)
    },
  })
  const props = {
    t, read, readDraft: async () => stored, write, recognize: queue.enqueue, setAutoRecognition: vi.fn(),
    stageCard: vi.fn(() => true), saveExport: vi.fn(),
    useTabInfo: () => ({ tab: { actions: { openResource }, signal,
      visible: true, navigation: { address, params: undefined, revision: 0 } } }),
    useReviewRevision: (select: (revision: number) => unknown) => select(0),
    useAutoRecognition: (select: (on: boolean) => unknown) => select(true),
    useRecognitionRevision: (select: (revision: number) => unknown) =>
      select(useSyncExternalStore(fn => recognitionRevision.subscribe(fn), () => recognitionRevision.getSnapshot())),
    useRecognitionStatuses: (select: (status: ReturnType<typeof queue.statuses.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(fn => queue.statuses.subscribe(fn), () => queue.statuses.getSnapshot())),
  } as Parameters<typeof ReviewPanel>[0]
  return { ...render(<ReviewPanel {...props} />), openResource, write, recognize }
}

it('loads screenshots and reopens the resource address from its card', async () => {
  const view = panel(async () => [{
    id: 1, sessionId: 'session-one', resourceAddress: address, fileName: 'notes.pdf', png: new Blob(['png'], { type: 'image/png' }),
  }])
  const card = await screen.findByRole('button', { name: 'Open notes.pdf' })
  expect(screen.getByRole('button', { name: en.cardText }).querySelector('img')?.src).toBe('blob:review-clip')
  fireEvent.click(card)
  expect(view.openResource).toHaveBeenCalledExactlyOnceWith(address, { beside: true })
  vi.useFakeTimers()
  view.openResource.mockImplementationOnce(() => { throw new Error('no viewer') })
  fireEvent.click(card)
  expect(screen.getByRole('alert').textContent).toBe(en.openFailed)
  act(() => { vi.advanceTimersByTime(5_000) })
  expect(screen.queryByRole('alert')).toBeNull()
  view.unmount()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:review-clip')
})

it.each(['read', 'failure'])('drops a late %s when Review closes', async (outcome) => {
  const pending = Promise.withResolvers<readonly ReviewClip[]>()
  const read = vi.fn(() => pending.promise)
  const view = panel(read)
  expect(read).toHaveBeenCalledOnce()
  view.unmount()
  await act(async () => {
    if (outcome === 'read') pending.resolve([])
    else pending.reject(new Error('database failure'))
    await pending.promise.catch(() => undefined)
  })
  expect(screen.queryByRole('region', { name: 'Review' })).toBeNull()
})

it('offers retry after a failed read and explains an empty review list', async () => {
  const read = vi.fn(async () => []).mockRejectedValueOnce(new Error('local database unavailable'))
  panel(read)
  expect((await screen.findByRole('alert')).textContent).toBe(en.loadFailed)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText(en.empty)).toBeDefined()
  expect(screen.getByRole('button', { name: en.recognizeAll })).toHaveProperty('disabled', true)
})

it('appends recognition to the current text and lets the user recognize the card after clearing it', async () => {
  const png = new Blob(['png'], { type: 'image/png' })
  const pending = Promise.withResolvers<string>()
  const recognize = vi.fn(async () => '重新识别结果').mockImplementationOnce(() => pending.promise)
  const view = panel(async () => [{ id: 1, sessionId: 'session-one', resourceAddress: address, fileName: 'notes.pdf', png }], recognize)
  const preview = await screen.findByRole('button', { name: en.cardText })
  expect(screen.queryByRole('textbox', { name: en.cardText })).toBeNull()
  fireEvent.click(preview)
  const field = screen.getByRole('textbox', { name: en.cardText })
  expect(document.activeElement).toBe(field)
  fireEvent.change(field, { target: { value: '手写补充' } })
  const recognition = screen.getByRole('button', { name: en.recognize })
  fireEvent.click(recognition)
  expect(await screen.findByRole('button', { name: en.recognizing })).toBe(recognition)
  expect(recognition.getAttribute('aria-disabled')).toBe('true')
  fireEvent.change(field, { target: { value: '识别期间继续编辑' } })
  await act(async () => { pending.resolve('识别结果'); await pending.promise })
  await waitFor(() => { expect(field).toHaveProperty('value', '识别期间继续编辑\n\n识别结果') })
  expect(screen.queryByRole('button', { name: en.cardText })).toBeNull()
  expect(view.recognize).toHaveBeenCalledExactlyOnceWith(png, expect.any(AbortSignal))
  fireEvent.change(field, { target: { value: '修订后的文字' } })
  expect(screen.getByRole('button', { name: en.recognized })).toBe(recognition)
  expect(recognition.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(recognition)
  expect(view.recognize).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: en.allRecognized })).toHaveProperty('disabled', true)
  fireEvent.change(field, { target: { value: ' \n' } })
  fireEvent.blur(field)
  expect(screen.getByRole('button', { name: en.cardText })).toBeDefined()
  expect(screen.getByRole('button', { name: en.recognize })).toBe(recognition)
  expect(recognition.getAttribute('aria-disabled')).toBe('false')
  expect(screen.getByRole('button', { name: en.recognizeAll })).toHaveProperty('disabled', false)
  fireEvent.click(recognition)
  const retried = await screen.findByRole('textbox', { name: en.cardText })
  expect(retried).toHaveProperty('value', '重新识别结果')
  expect(view.recognize).toHaveBeenCalledTimes(2)
})

it('keeps a folder visible when saving its deletion fails and offers a retry', async () => {
  const folder = { id: 'folder:aa', parentId: null, title: 'Evidence' } as const
  const view = panel(async () => [{
    id: 1, sessionId: 'session-one', resourceAddress: address, fileName: 'notes.pdf', png: new Blob(['png'], { type: 'image/png' }),
  }], undefined, { ...EMPTY_DRAFT, folders: [folder], assignments: { 'clip:1': folder.id }, order: ['clip:1'] })
  await screen.findByRole('button', { name: 'Open notes.pdf' })
  fireEvent.click(screen.getByRole('button', { name: 'Folders' }))
  fireEvent.click(screen.getByRole('button', { name: 'Folder actions for Evidence' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: en.deleteFolder }))
  const dialog = within(screen.getByRole('dialog', { name: en.deleteFolderTitle }))
  const pending = Promise.withResolvers<TranscriptDraft>()
  view.write.mockReturnValueOnce(pending.promise)
  fireEvent.click(dialog.getByRole('button', { name: en.deleteFolder }))
  await waitFor(() => { expect(view.write).toHaveBeenCalledExactlyOnceWith({ kind: 'deleteFolder', id: folder.id, unfiledOrder: [] }) })
  expect(dialog.getByRole('button', { name: en.deletingFolder })).toHaveProperty('disabled', true)
  expect(view.container.querySelector('[data-review-folder="folder:aa"]')).not.toBeNull()
  await act(async () => {
    pending.reject(new Error('Storage unavailable'))
    await pending.promise.catch(() => undefined)
  })
  expect(dialog.getByRole('alert').textContent).toBe(en.deleteFolderFailed)
  expect(view.container.querySelector('[data-review-folder="folder:aa"]')).not.toBeNull()

  fireEvent.click(dialog.getByRole('button', { name: en.deleteFolder }))
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.deleteFolderTitle })).toBeNull() })
  expect(view.container.querySelector('[data-review-folder="folder:aa"]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Open notes.pdf' })).toBeDefined()
})
