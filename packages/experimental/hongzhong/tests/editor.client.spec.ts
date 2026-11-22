// @vitest-environment jsdom
/** Exercise association and the editor's guarded draft state. */

import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { resolveSlotLabel, type OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { ArticleFolder, ArticlePreview, ArticleRevision, ArticleSourceVersion } from '../src/wechat-types.ts'
import { WorkspaceArticles } from '../src/client/ArticleEditor.tsx'
import { en } from '../src/client/locales.ts'
import type { Publishing, PublishingResult } from '../src/client/publish.ts'
import { mountEditor, registerEditor, WORKBENCH_SERVICES } from '../src/client/register-editor.ts'

const sessionId = brandString<SessionId>('wechat-writing-fixture')
const workspace: WorkspaceView = {
  workspaceId: brandString<WorkspaceId>('writing-workspace'),
  path: '/writing', title: 'Writing', sessionIds: [sessionId], createdAt: '', updatedAt: '',
}
const first = brandString<ArticleFolder>('2026-11-20_1902_First')
const second = brandString<ArticleFolder>('2026-11-19_1902_Second')
const preview: ArticlePreview = {
  title: 'First', markdown: '# First', html: '<h1>First</h1>',
  coverSrc: 'data:image/png;base64,iVBORw0KGgo=', missingImages: [],
  revision: brandString<ArticleRevision>('fixture'),
  sourceVersion: brandString<ArticleSourceVersion>('file-version'),
}
const nextVersion = brandString<ArticleSourceVersion>('next-version')
const t = makeTranslate(en)

afterEach(() => { cleanup() })

function fixturePublishing() {
  return {
    listArticles: vi.fn<Publishing['listArticles']>().mockResolvedValue({ ok: true, value: [first, second] }),
    readArticle: vi.fn<Publishing['readArticle']>().mockResolvedValue({ ok: true, value: preview }),
    setActiveArticle: vi.fn<Publishing['setActiveArticle']>().mockResolvedValue({ ok: true, value: true }),
    saveArticle: vi.fn<Publishing['saveArticle']>().mockResolvedValue({ ok: true, value: nextVersion }),
    list: vi.fn<Publishing['list']>().mockResolvedValue({ ok: true, value: [] }),
    bind: vi.fn<Publishing['bind']>().mockResolvedValue({ ok: false, failure: 'invalidAccount' }),
    remove: vi.fn<Publishing['remove']>().mockResolvedValue({ ok: true, value: true }),
    setDefault: vi.fn<Publishing['setDefault']>().mockResolvedValue({ ok: false, failure: 'accountMissing' }),
    sync: vi.fn<Publishing['sync']>().mockResolvedValue({ ok: false, failure: 'missingImage' }),
  }
}

async function testRuntime(items: readonly WorkspaceView[]) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const open = vi.fn<(id: SessionId) => void>()
  const beginNavigation = vi.fn(() => new AbortController().signal)
  runtime.ctx.provide('layout', { beginNavigation, panelInfo: runtime.panelInfo })
  const mounted = vi.fn<() => SessionId | undefined>().mockReturnValue(undefined)
  const active = vi.fn()
  const openTab = vi.fn()
  const registerTab = vi.fn<(definition: SidebarRightTabDefinition) => () => void>(() => () => {})
  runtime.ctx.provide('sidebarRight', { mounted: { getSnapshot: mounted }, active, openTab })
  runtime.ctx.provide('sidebarRightTabs', { register: registerTab })
  const pick = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
  runtime.ctx.provide('uiWorkspace', { registerSessionMode: () => () => {}, openSession: open })
  await runtime.workspaces.update((draft) => { draft.items = [...items]; draft.phase = 'ready' })
  await runtime.declare({
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: {
      tabInfo: () => () => { throw new Error('The article editor does not use tab metadata') },
    } } },
  })
  await runtime.mount({ inject: ['slots'], apply: (ctx: Context) => {
    ctx.slots.inject('workbench.workspace.directoryFlow', () => ctx.slots.register({
      name: 'workbench.workspace.directoryFlow',
    }, function Picker({ open, onPicked, onCancel, onError }: OwnerOf<'workbench.workspace.directoryFlow'>) {
      useEffect(() => {
        if (!open) return
        void pick().then((path) => {
          if (path === null) onCancel()
          else onPicked(path)
        }, onError)
      }, [open])
      return null
    }))
  } })
  return { runtime, open, pick, mounted, active, openTab, registerTab, beginNavigation }
}

it('opens the writing session associated with an existing workspace', async () => {
  const { runtime, open, pick } = await testRuntime([workspace])
  const publishing = fixturePublishing()
  const plugin = await runtime.mount({
    inject: WORKBENCH_SERVICES,
    apply: (ctx: Context) => { registerEditor(ctx, publishing) },
  })
  const [panel] = runtime.slots.entriesOfSlot('sidebar.panellist')
  expect(resolveSlotLabel(panel?.options.label)).toBe(en.panel)
  const icon = runtime.renderSlot('sidebar.panellist', { size: 16, active: true }, { only: 'hongzhong' })
  const { view } = runtime.renderSlot('main', {}, { entryKey: 'hongzhong' })
  expect(icon.container.querySelector('svg')).not.toBeNull()
  expect(view.getByRole('heading', { name: en.associateWorkspace })).toBeTruthy()
  fireEvent.click(view.getByText('Writing', { exact: true }))
  await waitFor(() => { expect(open).toHaveBeenCalledExactlyOnceWith(sessionId) })
  const connect = view.getByRole('button', { name: en.chooseFolder })
  await waitFor(() => { expect(connect).toMatchObject({ disabled: false }) })
  fireEvent.click(connect)
  await waitFor(() => { expect(pick).toHaveBeenCalledTimes(1) })
  await plugin.dispose()
  expect(icon.container.querySelector('svg')).toBeNull()
})

it('withdraws the Remote after the editor stops using it', async () => {
  const { runtime } = await testRuntime([workspace])
  const remote: TypertRemoteContribution = { package: '@fixture/article', descriptors: [] }
  const unmount = vi.fn(async () => {
    expect(runtime.slots.entriesOfSlot('sidebar.panellist')).toHaveLength(0)
  })
  const mount = vi.spyOn(runtime.remote, '$mount').mockResolvedValue(unmount)
  runtime.remote.provideNamespaces({ hongzhong: {} })
  const plugin = runtime.ctx.plugin({
    inject: ['remote', ...WORKBENCH_SERVICES],
    apply: (ctx: Context) => mountEditor(ctx, remote),
  })
  await plugin
  expect(mount).toHaveBeenCalledExactlyOnceWith(remote)
  expect(runtime.slots.entriesOfSlot('sidebar.panellist')).toHaveLength(1)
  await plugin.dispose()
  expect(unmount).toHaveBeenCalledOnce()
})

it('withdraws the Remote when editor registration fails', async () => {
  const { runtime } = await testRuntime([workspace])
  const unmount = vi.fn(async () => {})
  vi.spyOn(runtime.remote, '$mount').mockResolvedValue(unmount)
  runtime.remote.provideNamespaces({ hongzhong: {} })
  const slot = vi.spyOn(runtime.slots, 'inject').mockImplementationOnce(() => { throw new Error('Panel registration failed') })
  onTestFinished(() => { slot.mockRestore() })
  const boot = runtime.ctx.plugin({
    inject: ['remote', ...WORKBENCH_SERVICES],
    apply: (ctx: Context) => mountEditor(ctx, { package: '@fixture/article', descriptors: [] }),
  })
  await expect(boot).rejects.toThrow('Panel registration failed')
  expect(unmount).toHaveBeenCalledOnce()
})

it('keeps unsaved text when a native AI turn changes the base article', async () => {
  const publishing = fixturePublishing()
  const props = { workspace, sessionId, publishing, t }
  const view = render(createElement(WorkspaceArticles, { ...props, running: false }))
  const box = await view.findByRole('textbox', { name: en.source })
  expect(box).toMatchObject({ value: '# First', readOnly: false })
  fireEvent.change(box, { target: { value: 'Unsaved author version' } })
  await view.findByText(en.previewSaved)
  const next = { ...preview, markdown: 'Saved by AI', html: '<p>Saved by AI</p>', sourceVersion: nextVersion }
  publishing.readArticle.mockResolvedValue({ ok: true, value: next })
  view.rerender(createElement(WorkspaceArticles, { ...props, running: true }))
  view.rerender(createElement(WorkspaceArticles, { ...props, running: false }))
  await view.findByText(en.editConflict)
  expect(box).toMatchObject({ value: 'Unsaved author version' })
  expect(view.getByRole('button', { name: en.saveArticle })).toMatchObject({ disabled: true })
  expect(view.getByRole('button', { name: en.syncDraft })).toMatchObject({ disabled: true })
  fireEvent.click(view.getByRole('button', { name: en.discardArticleEdit }))
  await waitFor(() => { expect(box).toMatchObject({ value: 'Saved by AI' }) })

  fireEvent.change(box, { target: { value: 'Final article' } })
  publishing.readArticle.mockResolvedValue({ ok: true, value: { ...next, markdown: 'Final article', html: '<p>Final article</p>' } })
  fireEvent.click(view.getByRole('button', { name: en.saveArticle }))
  await view.findByText('Final article', { selector: 'p' })
  expect(publishing.saveArticle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ folder: first }),
    nextVersion, 'Final article', expect.any(AbortSignal))
})

it('ignores a stale preview after selecting another article', async () => {
  const publishing = fixturePublishing()
  const previous = Promise.withResolvers<PublishingResult<ArticlePreview>>()
  publishing.readArticle.mockReturnValueOnce(previous.promise)
  const view = render(createElement(WorkspaceArticles, { workspace, sessionId, running: false, publishing, t }))
  await waitFor(() => { expect(view.getByLabelText(en.articles)).toMatchObject({ value: first }) })
  fireEvent.change(view.getByLabelText(en.articles), { target: { value: second } })
  await view.findByRole('textbox', { name: en.source })
  await act(async () => {
    previous.resolve({ ok: true, value: { ...preview, markdown: '# Old response' } })
    await previous.promise
  })
  expect(view.getByLabelText(en.articles)).toMatchObject({ value: second })
  expect(view.getByRole('textbox', { name: en.source })).toMatchObject({ value: preview.markdown })
  expect(publishing.readArticle.mock.calls[0]?.[1].aborted).toBe(true)
})

it('shows workspace faults and recovers after a failed refresh', async () => {
  const publishing = fixturePublishing()
  publishing.listArticles.mockRejectedValueOnce(new Error('Workspace transport unavailable'))
  publishing.readArticle.mockRejectedValueOnce(new Error('Article transport unavailable'))
  const view = render(createElement(WorkspaceArticles, { workspace, sessionId, running: false, publishing, t }))
  await view.findByText(en.workspaceUnavailable)
  const refresh = view.getByRole('button', { name: en.refreshArticles })
  fireEvent.click(refresh)
  await view.findByText(en.articleUnavailable)
  fireEvent.click(refresh)
  await view.findByRole('textbox', { name: en.source })
})

it('joins a local folder and opens a fresh writing session', async () => {
  const { runtime, open, pick } = await testRuntime([{ ...workspace, sessionIds: [] }])
  runtime.workspaces.stub('create', async () => ({ ...workspace, sessionIds: [] }))
  pick.mockResolvedValueOnce(workspace.path)
  runtime.sessions.stubCreate(async (options) => {
    if (options?.sessionId === undefined) throw new Error('Expected an allocated Session')
    await runtime.sessions.add({ id: options.sessionId })
    return options.sessionId
  })
  const create = vi.spyOn(runtime.sessions, 'create')
  await runtime.mount({ inject: WORKBENCH_SERVICES, apply: (ctx: Context) => { registerEditor(ctx, fixturePublishing()) } })
  const { view } = runtime.renderSlot('main', {}, { entryKey: 'hongzhong' })
  fireEvent.click(view.getByRole('button', { name: en.chooseFolder }))
  await waitFor(() => { expect(open).toHaveBeenCalledWith(expect.stringMatching(/^wechat-writing-/)) })
  expect(create).toHaveBeenCalledWith({ workspaceId: workspace.workspaceId, sessionId: open.mock.calls[0]?.[0] })
})

it('reports a directory chooser error and lets the user try the picker again', async () => {
  const { runtime, open, pick } = await testRuntime([])
  pick.mockRejectedValueOnce(new Error('Folder selection is unavailable'))
  await runtime.mount({ inject: WORKBENCH_SERVICES, apply: (ctx: Context) => { registerEditor(ctx, fixturePublishing()) } })
  const { view } = runtime.renderSlot('main', {}, { entryKey: 'hongzhong' })
  const button = view.getByRole('button', { name: en.chooseFolder })
  fireEvent.click(button)
  await view.findByRole('alert')
  fireEvent.click(button)
  await waitFor(() => { expect(button).toMatchObject({ disabled: false }) })
  expect(view.queryByRole('alert')).toBeNull()
  expect(open).not.toHaveBeenCalled()
})

it('resumes the latest known unarchived writing session in its workspace', async () => {
  const older = brandString<SessionId>('wechat-writing-older')
  const archived = brandString<SessionId>('wechat-writing-archived')
  const unlisted = brandString<SessionId>('wechat-writing-unlisted')
  const anotherUnlisted = brandString<SessionId>('wechat-writing-also-unlisted')
  const other = brandString<SessionId>('ordinary-session')
  const { runtime, open } = await testRuntime([{
    ...workspace, sessionIds: [unlisted, older, anotherUnlisted, sessionId, archived, other],
  }])
  await runtime.sessions.add({ id: older, summary: { updatedAt: 1 } })
  await runtime.sessions.add({ id: sessionId, summary: { updatedAt: 2 } })
  await runtime.sessions.add({ id: archived, summary: { updatedAt: 3 } })
  await runtime.sessions.add({ id: other, summary: { updatedAt: 4 } })
  await runtime.workspaces.update((draft) => { draft.archivedSessionIds = [archived] })
  await runtime.mount({ inject: WORKBENCH_SERVICES, apply: (ctx: Context) => { registerEditor(ctx, fixturePublishing()) } })
  const { view } = runtime.renderSlot('main', {}, { entryKey: 'hongzhong' })
  fireEvent.click(view.getByText('Writing', { exact: true }))
  await waitFor(() => { expect(open).toHaveBeenCalledExactlyOnceWith(sessionId) })
})

it('reports when a workspace disappears between selection and opening', async () => {
  const { runtime, open, beginNavigation } = await testRuntime([workspace])
  beginNavigation.mockImplementationOnce(() => {
    vi.spyOn(runtime.workspaces.list, 'getSnapshot').mockReturnValueOnce({
      ...runtime.workspaces.list.getSnapshot(), items: [],
    })
    return new AbortController().signal
  })
  await runtime.mount({ inject: WORKBENCH_SERVICES, apply: (ctx: Context) => { registerEditor(ctx, fixturePublishing()) } })
  const { view } = runtime.renderSlot('main', {}, { entryKey: 'hongzhong' })
  fireEvent.click(view.getByText('Writing', { exact: true }))
  await view.findByRole('alert')
  expect(open).not.toHaveBeenCalled()
})

it('stops opening an associated workspace when the launcher closes during registration', async () => {
  const { runtime, open, pick } = await testRuntime([])
  const registration = Promise.withResolvers<WorkspaceView>()
  const create = vi.fn(() => registration.promise)
  runtime.workspaces.stub('create', create)
  pick.mockResolvedValueOnce(workspace.path)
  await runtime.mount({ inject: WORKBENCH_SERVICES, apply: (ctx: Context) => { registerEditor(ctx, fixturePublishing()) } })
  const launcher = runtime.renderSlot('main', {}, { entryKey: 'hongzhong' })
  fireEvent.click(launcher.view.getByRole('button', { name: en.chooseFolder }))
  await waitFor(() => { expect(create).toHaveBeenCalledWith({ path: workspace.path }) })
  launcher.update({}, { entryKey: 'another-workbench' })
  await act(async () => { registration.resolve(workspace); await registration.promise })
  expect(open).not.toHaveBeenCalled()
})

it('does not open a writing session if the user navigates away while it is being created', async () => {
  const { runtime, open, beginNavigation } = await testRuntime([{ ...workspace, sessionIds: [] }])
  const navigation = new AbortController()
  await runtime.sessions.add({ id: sessionId })
  beginNavigation.mockReturnValueOnce(navigation.signal)
  const creation = Promise.withResolvers<SessionId>()
  runtime.sessions.stubCreate(() => creation.promise)
  const create = vi.spyOn(runtime.sessions, 'create')
  await runtime.mount({ inject: WORKBENCH_SERVICES, apply: (ctx: Context) => { registerEditor(ctx, fixturePublishing()) } })
  const { view } = runtime.renderSlot('main', {}, { entryKey: 'hongzhong' })
  fireEvent.click(view.getByText('Writing', { exact: true }))
  await waitFor(() => { expect(create).toHaveBeenCalledOnce() })
  navigation.abort()
  await act(async () => { creation.resolve(sessionId); await creation.promise })
  expect(open).not.toHaveBeenCalled()
  expect(view.queryByRole('alert')).toBeNull()
})

it('registers the editor tab with the native writing conversation', async () => {
  const { runtime, mounted, openTab, registerTab } = await testRuntime([])
  const publishing = fixturePublishing()
  await runtime.sessions.add({ id: sessionId })
  const reference = runtime.sessions.retainFor(runtime.ctx, sessionId, { source: 'mainView' })
  onTestFinished(() => { reference.release() })
  await reference.ready
  await runtime.mount({ inject: WORKBENCH_SERVICES, apply: (ctx: Context) => { registerEditor(ctx, publishing) } })
  expect(registerTab.mock.calls[0]?.[0].kind).toBe('wechat-article')
  expect(registerTab.mock.calls[0]?.[0].title('')).toBe(en.articleEditor)
  const dock = {} as OwnerOf<'conversation.input.dock'>
  const before = runtime.renderSlot('conversation.input.dock', dock, { session: reference })
  expect(openTab).not.toHaveBeenCalled()
  before.update(dock, { session: reference, only: 'another-dock-entry' })
  mounted.mockReturnValue(sessionId)
  runtime.renderSlot('conversation.input.dock', dock, { session: reference })
  expect(openTab).toHaveBeenCalledWith('wechat-article')
  const tab = runtime.renderSlot('sidebar.right.pane.tab', {}, {
    session: reference, entryKey: '@deepseek-ai/dsh-hongzhong', hookContext: {},
  })
  await tab.view.findByText(en.openingWorkspace)
  await act(async () => {
    runtime.sessions.list.update((draft) => { draft.byId = {} })
    await runtime.workspaces.update((draft) => { draft.items = [workspace] })
  })
  await tab.view.findByRole('textbox', { name: en.source })
})

it('sets writing context when the first AI turn produces an article', async () => {
  const publishing = fixturePublishing()
  publishing.listArticles.mockResolvedValueOnce({ ok: true, value: [] })
  publishing.setActiveArticle.mockRejectedValueOnce(new Error('Context service unavailable'))
  const props = { workspace, sessionId, publishing, t }
  const view = render(createElement(WorkspaceArticles, { ...props, running: true }))
  await view.findByText(en.empty)
  await view.findByText(en.articleContextFailed)
  expect(publishing.setActiveArticle).toHaveBeenCalledWith(sessionId, null)
  view.rerender(createElement(WorkspaceArticles, { ...props, running: false }))
  await view.findByRole('textbox', { name: en.source })
  expect(publishing.setActiveArticle).toHaveBeenLastCalledWith(sessionId, { workspaceId: workspace.workspaceId, folder: first })
  expect(view.queryByText(en.articleContextFailed)).toBeNull()
})

it('retains an unsaved edit after a write failure and recovers the preview after a failed reread', async () => {
  const publishing = fixturePublishing()
  publishing.saveArticle.mockRejectedValueOnce(new Error('Disk is read-only'))
  const view = render(createElement(WorkspaceArticles, { workspace, sessionId, running: false, publishing, t }))
  const editor = await view.findByRole('textbox', { name: en.source })
  fireEvent.change(editor, { target: { value: '# Draft to retry' } })
  fireEvent.click(view.getByRole('button', { name: en.saveArticle }))
  await view.findByText(en.articleSaveFailed)
  expect(editor).toHaveProperty('value', '# Draft to retry')

  publishing.readArticle.mockRejectedValueOnce(new Error('The saved article cannot be displayed yet'))
  fireEvent.click(view.getByRole('button', { name: en.saveArticle }))
  await view.findByText(en.articleUnavailable)
  expect(editor).toHaveProperty('value', '# Draft to retry')
  expect(view.getByRole('button', { name: en.syncDraft })).toMatchObject({ disabled: true })
  publishing.readArticle.mockResolvedValueOnce({ ok: true, value: { ...preview, markdown: '# Draft to retry', sourceVersion: nextVersion } })
  fireEvent.click(view.getByRole('button', { name: en.refreshArticles }))
  await waitFor(() => { expect(view.queryByText(en.articleUnavailable)).toBeNull() })
  expect(editor).toHaveProperty('value', '# Draft to retry')
})

it('refreshes after a rejected write and keeps the unsaved Markdown until it is reverted', async () => {
  const publishing = fixturePublishing()
  publishing.saveArticle.mockResolvedValueOnce({ ok: false, failure: 'articleChanged' })
  const view = render(createElement(WorkspaceArticles, { workspace, sessionId, running: false, publishing, t }))
  const editor = await view.findByRole('textbox', { name: en.source })
  fireEvent.change(editor, { target: { value: '# Local edit' } })
  publishing.readArticle.mockResolvedValueOnce({ ok: true, value: { ...preview, markdown: '# Newer revision', sourceVersion: nextVersion } })
  fireEvent.click(view.getByRole('button', { name: en.saveArticle }))
  await view.findByText(en.editConflict)
  await waitFor(() => { expect(view.getByRole('button', { name: en.saveArticle })).toMatchObject({ disabled: true }) })
  expect(editor).toHaveProperty('value', '# Local edit')
  fireEvent.change(editor, { target: { value: '# Newer revision' } })
  expect(view.queryByText(en.editConflict)).toBeNull()
  expect(view.getByRole('button', { name: en.saveArticle })).toMatchObject({ disabled: true })
})

it('ignores replaced article lists and writing context responses', async () => {
  const publishing = fixturePublishing()
  const listing = Promise.withResolvers<PublishingResult<ArticleFolder[]>>()
  const context = Promise.withResolvers<PublishingResult<boolean>>()
  publishing.listArticles.mockReturnValueOnce(listing.promise)
  publishing.setActiveArticle.mockReturnValueOnce(context.promise)
  const view = render(createElement(WorkspaceArticles, { workspace, sessionId, running: false, publishing, t }))
  fireEvent.click(view.getByRole('button', { name: en.refreshArticles }))
  await view.findByRole('textbox', { name: en.source })
  fireEvent.change(view.getByRole('combobox', { name: en.articles }), { target: { value: second } })
  await view.findByRole('textbox', { name: en.source })
  await act(async () => {
    listing.resolve({ ok: true, value: [] })
    context.resolve({ ok: false, failure: 'workspaceUnavailable' })
    await Promise.all([listing.promise, context.promise])
  })
  expect(view.getByRole('combobox', { name: en.articles })).toHaveProperty('value', second)
  expect(view.queryByText(en.articleContextFailed)).toBeNull()
})

it.each(['write', 'reread'])('abandons an in-flight %s when the editor is unmounted', async (stage) => {
  const publishing = fixturePublishing()
  const write = Promise.withResolvers<PublishingResult<ArticleSourceVersion>>()
  const reread = Promise.withResolvers<PublishingResult<ArticlePreview>>()
  const view = render(createElement(WorkspaceArticles, { workspace, sessionId, running: false, publishing, t }))
  const editor = await view.findByRole('textbox', { name: en.source })
  if (stage === 'write') publishing.saveArticle.mockReturnValueOnce(write.promise)
  else publishing.readArticle.mockReturnValueOnce(reread.promise)
  fireEvent.change(editor, { target: { value: '# Pending edit' } })
  fireEvent.click(view.getByRole('button', { name: en.saveArticle }))
  if (stage === 'reread') await waitFor(() => { expect(publishing.readArticle).toHaveBeenCalledTimes(2) })
  view.unmount()
  await act(async () => {
    write.resolve({ ok: true, value: nextVersion })
    reread.resolve({ ok: true, value: preview })
    await Promise.all([write.promise, reread.promise])
  })
  expect(publishing.saveArticle.mock.calls[0]?.[3].aborted).toBe(true)
  expect(publishing.readArticle).toHaveBeenCalledTimes(stage === 'write' ? 1 : 2)
})

it('selects a theme and leaves missing image paths visible', async () => {
  const publishing = fixturePublishing()
  publishing.readArticle.mockResolvedValue({ ok: true, value: { ...preview, missingImages: ['./missing.png'], coverSrc: null } })
  const view = render(createElement(WorkspaceArticles, { workspace, sessionId, running: false, publishing, t }))
  await view.findByText(/missing.png/)
  fireEvent.change(view.getByRole('combobox', { name: en.theme }), { target: { value: 'editorial' } })
  await waitFor(() => {
    expect(publishing.readArticle).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'editorial' }), expect.any(AbortSignal))
  })
})
