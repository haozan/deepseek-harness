// @vitest-environment jsdom
/** Review registrations retire with the Client plugin, including late slot contributions. */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { EVIDENCE_KIND, REVIEW_KIND, type CaptureDestination } from '../src/client/Review.tsx'
import type { ReviewClip } from '../src/client/clip-store.ts'
import { EMPTY_DRAFT } from '../src/transcript.ts'

const archive = vi.hoisted(() => ({ listClips: vi.fn(async () => []), saveClip: vi.fn(async () => 17) }))
vi.mock('../src/client/archive-store.ts', () => ({
  ReviewArchiveStore: class {
    listClips = archive.listClips
    saveClip = archive.saveClip
    readDraft = async () => EMPTY_DRAFT
    writeDraft = async () => {}
  },
}))

afterEach(() => { vi.unstubAllGlobals() })

async function mount() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const tabs = new Map<string, SidebarRightTabDefinition>()
  const recognize = vi.fn(async () => ({ ok: true, value: 'Invoice total' }) as const)
  const stageImageDraft = vi.fn(() => true)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('remote', { documentReview: { recognize } } as never)
  ctx.provide('remote.documentReview', { recognize })
  ctx.provide('fileActions', {} as never)
  ctx.provide('conversation', { stageImageDraft } as never)
  ctx.provide('sidebarRight', {} as never)
  ctx.provide('layout', {} as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('workspaces', {} as never)
  ctx.provide('uiWorkspace', { registerSessionMode: () => () => {} } as never)
  ctx.provide('sidebarRightTabs', { register: (definition: SidebarRightTabDefinition) => {
    tabs.set(definition.kind, definition)
    return () => { tabs.delete(definition.kind) }
  } } as never)
  const slots = {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
    'sidebar.right.tab.document.contentActions': { kind: 'list', scope: 'session' },
    'sidebar.right.tab.document.captureAction': { kind: 'keyed', scope: 'session' },
    'sidebar.right.tab.files.actions': { kind: 'list', scope: 'session' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
  } as const
  const plugin = ctx.plugin({ inject, apply })
  await plugin.await()
  ctx.slots.register({ name: 'root', children: slots } as never, () => null)
  return { ctx, plugin, tabs, recognize, stageImageDraft }
}

it('leaves browser UI absent without the Desktop capture bridge', async () => {
  const { ctx, plugin, tabs } = await mount()
  try {
    expect(tabs.get(REVIEW_KIND)).toBeUndefined()
    expect(tabs.get(EVIDENCE_KIND)).toBeUndefined()
    expect(ctx.slots.entries('sidebar.right.tab.document.contentActions')).toHaveLength(0)
  } finally { await plugin.dispose() }
})

it('does not register the Client plugin in a non-browser process', () => {
  vi.stubGlobal('window', undefined)
  apply(new Context())
})

it('registers the Desktop review tab and controls until the plugin unloads', async () => {
  vi.stubGlobal('dshDesktop', { capturePageRegion: vi.fn() })
  const { ctx, plugin, tabs } = await mount()
  const entries = () => [
    ctx.slots.entries('main').length,
    ctx.slots.entries('sidebar.panellist').length,
    ctx.slots.entries('conversation.input.dock').length,
    ctx.slots.entries('sidebar.right.tab.document.contentActions').length,
    ctx.slots.entries('sidebar.right.tab.document.captureAction').length,
    ctx.slots.entries('sidebar.right.tab.files.actions').length,
    ctx.slots.entries('sidebar.right.pane.tab').length,
    ctx.slots.entries('sidebar.right.pane.tab.title').length,
  ]
  try {
    expect(tabs.get(REVIEW_KIND)?.title('')).toBe('Review transcript')
    expect(tabs.get(REVIEW_KIND)?.guide).toBeUndefined()
    expect(tabs.get(EVIDENCE_KIND)?.title('')).toBe('Evidence directory')
    expect(entries()).toEqual([1, 1, 1, 1, 2, 0, 2, 2])
  } finally { await plugin.dispose() }
  expect(tabs.get(REVIEW_KIND)).toBeUndefined()
  expect(tabs.get(EVIDENCE_KIND)).toBeUndefined()
  expect(entries()).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
})

it('binds reads and saves to the Session', async () => {
  const capturePageRegion = vi.fn()
  vi.stubGlobal('dshDesktop', { capturePageRegion })
  const { ctx, plugin, recognize, stageImageDraft } = await mount()
  try {
    const capture = ctx.slots.entries('sidebar.right.tab.document.contentActions')[0]?.inject as
      (sessionId: string) => {
        capture: typeof capturePageRegion
        save: (clip: Omit<ReviewClip, 'id' | 'sessionId' | 'destination'>, destination: CaptureDestination) => Promise<number>
      }
    const panel = ctx.slots.entries('sidebar.right.pane.tab')[0]?.inject as (sessionId: string) => {
      hooks: { reviewRevision: { getSnapshot: () => number }; recognitionRevision: { getSnapshot: () => number } }
      read: () => Promise<readonly ReviewClip[]>
      stageCard: (clip: ReviewClip, text: string) => boolean
    }
    const clip = { fileName: 'notes.txt', resourceAddress: 'dsh-resource://file/session/one/notes.txt', png: new Blob(['png']) }
    const actions = capture('one')
    const review = panel('one')
    expect(actions.capture).toBe(capturePageRegion)
    expect(await actions.save(clip, REVIEW_KIND)).toBe(17)
    expect(archive.saveClip).toHaveBeenCalledExactlyOnceWith({ ...clip, sessionId: 'one' })
    expect(review.hooks.reviewRevision.getSnapshot()).toBe(1)
    await review.read()
    expect(archive.listClips).toHaveBeenCalledExactlyOnceWith('one')
    await vi.waitFor(() => { expect(review.hooks.recognitionRevision.getSnapshot()).toBe(1) })
    expect(recognize).toHaveBeenCalledExactlyOnceWith('one', 'cG5n', expect.any(AbortSignal))
    expect(await actions.save(clip, EVIDENCE_KIND)).toBe(17)
    expect(archive.saveClip).toHaveBeenLastCalledWith({ ...clip, sessionId: 'one', destination: 'evidence' })
    expect(review.stageCard({ ...clip, id: 17, sessionId: 'one' }, 'Invoice total\n\nCompare')).toBe(true)
    expect(stageImageDraft).toHaveBeenCalledExactlyOnceWith('one', 'Invoice total\n\nCompare',
      expect.objectContaining({ name: 'notes.txt.png', size: clip.png.size }))
  } finally { await plugin.dispose() }
})
