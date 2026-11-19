/** Desktop document review registrations. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-file-actions/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CapturePageRegion } from '../types.ts'
import type { ReviewClip } from './clip-store.ts'
import { ReviewArchiveStore } from './archive-store.ts'
import { CaptureAction, CaptureFrameLink, captureTab, EVIDENCE_KIND, EvidenceTitle, REVIEW_KIND, ReviewTitle,
  type CaptureDestination, type PendingCapture } from './Review.tsx'
import { EvidencePanel } from './EvidencePanel.tsx'
import { ReviewShortcuts } from './ReviewShortcuts.tsx'
import { ReviewPanel } from './TranscriptPanel.tsx'
import { WorkbenchIcon, WorkbenchLauncher } from './WorkbenchLauncher.tsx'
import { archiveIdFor, isWorkbenchSession, newWorkbenchSession } from '../workbench.ts'
import { imageBase64 } from './image-base64.ts'
import { createRecognitionQueue } from './recognition.ts'
import { type EntryKey, type TranscriptEdit } from '../transcript.ts'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

const PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar-review'
const EVIDENCE_TAB_ID = `${PACKAGE}:evidence`
const PANEL_ID = 'review-workbench'
const AUTO_RECOGNITION_KEY = 'dsh.document-review.auto-recognition'

function readAutoRecognition(): boolean {
  try { return window.localStorage.getItem(AUTO_RECOGNITION_KEY) !== 'off' }
  catch (_error: unknown) { return false }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The capture to reveal in the Session's transcript. */
    'review-clips': { readonly reviewEntry: EntryKey }
    /** The capture to reveal in the Session's evidence directory. */
    'evidence-clips': { readonly evidenceEntry: number }
  }
}

/** Services used by the review tabs, capture actions, and card tools. */
export const inject = [
  'slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.documentReview', 'fileActions', 'conversation',
  'layout', 'sessions', 'workspaces', 'uiWorkspace',
]

/**
 * Register review UI when the owning Desktop application exposes region capture.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: ClientContext): void {
  if (typeof window === 'undefined') return
  const capture = (window as Window & { dshDesktop?: { capturePageRegion?: CapturePageRegion } }).dshDesktop?.capturePageRegion
  if (capture === undefined) return

  const revision = createSnapshotStore(0)
  const recognitionRevision = createSnapshotStore(0)
  const autoRecognition = createSnapshotStore(readAutoRecognition())
  let pendingAutomatic = new AbortController()
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'sidebar-review: recognition requests')
  const createdWorkspaces = new Map<SessionId, WorkspaceId>()
  const archive = new ReviewArchiveStore(ctx.remote.documentReview, (id) => {
    const key = SessionId(id)
    const { items } = ctx.workspaces.list.getSnapshot()
    return items.find(item => item.sessionIds.includes(key))
      ?? items.find(item => item.workspaceId === createdWorkspaces.get(key))
      ?? items.find(item => item.path === ctx.sessions.list.getSnapshot().byId[key]?.cwd)
  }, id => ctx.sessions.list.getSnapshot().byId[id]?.updatedAt, lifetime.signal)
  const legacySessions = (workspace: WorkspaceView): SessionId[] => {
    const sessions = ctx.sessions.list.getSnapshot()
    const workspaces = ctx.workspaces.list.getSnapshot().items
    const assigned = new Set(workspaces.flatMap(item => item.sessionIds))
    return [...workspace.sessionIds, ...sessions.ids.filter(id => !assigned.has(id) && sessions.byId[id]?.cwd === workspace.path)]
  }
  const listReviews = async (workspace: WorkspaceView) => {
    const sessions = legacySessions(workspace)
    const summaries = await archive.list(workspace, sessions)
    const archived = new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds)
    return summaries.filter(({ id }) => {
      const local = sessions.filter(session => archiveIdFor(session) === id)
      return local.length === 0 || local.some(session => !archived.has(session))
    })
  }
  const openReview = async (workspace: WorkspaceView, id: string | undefined, navigation: AbortSignal): Promise<void> => {
    const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds
    const local = id === undefined ? undefined
      : workspace.sessionIds.find(session => isWorkbenchSession(session) && !archived.includes(session) && archiveIdFor(session) === id)
    navigation.throwIfAborted()
    const sessionId = local ?? await ctx.sessions.create({ workspaceId: workspace.workspaceId, sessionId: newWorkbenchSession(id) })
    createdWorkspaces.set(sessionId, workspace.workspaceId)
    if (!navigation.aborted) ctx.uiWorkspace.openSession(sessionId)
  }
  const recognition = createRecognitionQueue({
    signal: lifetime.signal,
    recognize: async (clip, signal, pendingSignal) => {
      const saved = await archive.readDraft(clip.sessionId)
      if (saved.recognized[`clip:${clip.id}`] === 'text' || signal.aborted) return undefined
      const encoded = await imageBase64(clip.png)
      signal.throwIfAborted()
      if (pendingSignal?.aborted === true) return undefined
      const result = await ctx.remote.documentReview.recognize(SessionId(clip.sessionId), encoded, signal)
      if (!result.ok) throw result.error
      return result.value
    },
    save: async (clip, value) => {
      await archive.writeDraft(clip.sessionId, { kind: 'recognized', key: `clip:${clip.id}`, value })
      recognitionRevision.set(recognitionRevision.getSnapshot() + 1)
    },
  })
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, zh, ja, es, fr, de, ru, pt }), 'sidebar-review: dictionaries')
  ctx.effect(() => ctx.uiWorkspace.registerSessionMode({
    matches: isWorkbenchSession,
    createId: newWorkbenchSession,
  }), 'sidebar-review: dedicated conversations')
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, locale: NS, label: () => t('workbench'), order: 21,
  }, WorkbenchIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS,
    inject: () => ({
      hooks: { workbenchWorkspaces: ctx.workspaces.list, workbenchSessions: ctx.sessions.list, reviewRevision: revision },
      listReviews,
      reopen: (workspace: WorkspaceView, id: string, signal: AbortSignal) =>
        openReview(workspace, id, AbortSignal.any([ctx.layout.beginNavigation(), lifetime.signal, signal])),
      associate: async (existing: WorkspaceId | undefined, signal: AbortSignal) => {
        const navigation = AbortSignal.any([ctx.layout.beginNavigation(), lifetime.signal, signal])
        if (existing === undefined) {
          const path = await ctx.uiWorkspace.pickDirectory()
          if (path === null) return
          navigation.throwIfAborted()
          const before = new Set(ctx.workspaces.list.getSnapshot().items.map(workspace => workspace.workspaceId))
          const workspace = await ctx.workspaces.create({ path })
          const latest = before.has(workspace.workspaceId) ? undefined : (await listReviews(workspace))[0]
          await openReview(workspace, latest?.id, navigation)
          return
        }
        const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === existing)
        if (workspace === undefined) throw new Error('The selected workspace is unavailable')
        await openReview(workspace, undefined, navigation)
      },
    }),
  }, WorkbenchLauncher))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PACKAGE, kind: REVIEW_KIND, priority: 'builtin', title: () => t('transcript'),
  }), 'sidebar-review: tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: EVIDENCE_TAB_ID, kind: EVIDENCE_KIND, priority: 'builtin', title: () => t('evidenceDirectory'),
  }), 'sidebar-review: evidence tab type')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: PACKAGE, locale: NS, order: 30,
    inject: sessionId => ({
      openWorkspace: (destination: CaptureDestination) => {
        if (!isWorkbenchSession(sessionId) || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
        ctx.sidebarRight.openTabWorkspace('files', [REVIEW_KIND, EVIDENCE_KIND], destination)
      },
      prepareTranscriptDraft: (prompt: string) => {
        const id = SessionId(sessionId)
        const binding = ctx.sessions.binding(id)
        const { blocks, input } = ctx.conversation
        if (binding === undefined || blocks.storeFor(id).getSnapshot() !== undefined) return
        if (input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'keep' }) !== 'blocked') {
          input.for(binding.ctx).focus()
        }
      },
    }),
  }, ReviewShortcuts))

  ctx.slots.inject('sidebar.right.tab.document.contentActions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.contentActions', id: REVIEW_KIND, locale: NS,
    inject: sessionId => ({
      hooks: { reviewRevision: revision, autoRecognition },
      capture,
      readFrames: async (address: string) => (await archive.frames(sessionId, address)).flatMap(clip =>
        clip.location === undefined ? []
          : [{ location: clip.location, target: { key: captureTab(clip), id: clip.id } }]),
      save: async (clip: PendingCapture, destination: CaptureDestination) => {
        const id = await archive.saveClip({ ...clip, sessionId, ...(destination === EVIDENCE_KIND ? { destination: 'evidence' } : {}) })
        revision.set(revision.getSnapshot() + 1)
        if (destination === REVIEW_KIND && autoRecognition.getSnapshot()) {
          recognition.enqueue([{ ...clip, id, sessionId }], pendingAutomatic.signal)
        }
        return id
      },
    }),
  }, CaptureAction))

  for (const destination of [REVIEW_KIND, EVIDENCE_KIND] as const) {
    ctx.slots.inject('sidebar.right.tab.document.captureAction', () => ctx.slots.register({
      name: 'sidebar.right.tab.document.captureAction', key: destination, locale: NS, inject: () => ({ destination }),
    }, CaptureFrameLink))
  }

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: PACKAGE, locale: NS,
    inject: sessionId => ({
      hooks: { reviewRevision: revision, recognitionRevision, autoRecognition, recognitionStatuses: recognition.statuses },
      read: () => archive.listClips(sessionId),
      readDraft: () => archive.readDraft(sessionId),
      write: (edit: TranscriptEdit) => archive.writeDraft(sessionId, edit),
      stageCard: (clip: ReviewClip, text: string, fullscreenTrigger?: HTMLElement) => {
        const target = fullscreenTrigger === undefined ? undefined : ctx.sidebarRight.commandTarget(fullscreenTrigger)
        const image = new File([clip.png], `${clip.fileName}.png`, { type: clip.png.type })
        if (!ctx.conversation.stageImageDraft(SessionId(sessionId), text, image)) return false
        if (target !== undefined) ctx.sidebarRight.toggleFullscreen(target)
        return true
      },
      recognize: recognition.enqueue,
      setAutoRecognition: (enabled: boolean) => {
        window.localStorage.setItem(AUTO_RECOGNITION_KEY, enabled ? 'on' : 'off')
        autoRecognition.set(enabled)
        if (!enabled) {
          pendingAutomatic.abort()
          pendingAutomatic = new AbortController()
        }
      },
      saveExport: async (file: Blob, name: string) => {
        const url = URL.createObjectURL(file)
        try { await ctx.fileActions.save({ url, name, mediaType: file.type, read: () => Promise.resolve(file) }, 'saveAs') }
        finally { URL.revokeObjectURL(url) }
      },
    }),
  }, ReviewPanel))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: PACKAGE, locale: NS,
  }, ReviewTitle))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: EVIDENCE_TAB_ID, locale: NS,
    inject: sessionId => ({
      hooks: { reviewRevision: revision },
      read: () => archive.listClips(sessionId, 'evidence'),
    }),
  }, EvidencePanel))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: EVIDENCE_TAB_ID, locale: NS,
  }, EvidenceTitle))
}
