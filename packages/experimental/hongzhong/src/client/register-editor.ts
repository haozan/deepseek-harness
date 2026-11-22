/** Register the article library as a top-level navigation panel. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { HostObservable, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { useEffect } from 'react'
import { isWritingSession, WRITING_SESSION_PREFIX } from '../writing-session.ts'
import { ArticleEditor, EditorIcon, WorkbenchLauncher } from './ArticleEditor.tsx'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'
import { createPublishing, type Publishing } from './publish.ts'

const PANEL_ID = 'hongzhong'
const TAB_ID = '@deepseek-ai/dsh-hongzhong'
const TAB_KIND = 'wechat-article'
const DIRECTORY_FLOW = 'workbench.workspace.directoryFlow'

/** Standard DSH services for the writing launcher and its conversation tab. */
export const WORKBENCH_SERVICES = ['slots', 'locale', 'workspaces', 'sessions', 'layout', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs']

function newWritingSession(): SessionId {
  return brandString<SessionId>(`${WRITING_SESSION_PREFIX}${randomUUID()}`)
}

function RevealWritingTab({ reveal }: PropsRuntime<'conversation.input.dock'> & { readonly reveal: () => void }): null {
  useEffect(() => { reveal() }, [reveal])
  return null
}

/**
 * Add the editor to the application's main navigation.
 * @param ctx - Browser plugin context.
 * @param publishing - WeChat account and draft actions.
 */
export function registerEditor(ctx: Context, publishing: Publishing): void {
  const workspaces = ctx.workspaces.list
  const sessions = ctx.sessions.list
  const t = ctx.locale.bind(NS)
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'hongzhong: navigation lifetime')

  async function associate(target: { workspaceId: WorkspaceId } | { path: string }, signal: AbortSignal): Promise<void> {
    const navigation = AbortSignal.any([ctx.layout.beginNavigation(), lifetime.signal, signal])
    const workspace = 'path' in target
      ? await ctx.workspaces.create({ path: target.path })
      : workspaces.getSnapshot().items.find(item => item.workspaceId === target.workspaceId)
    if (workspace === undefined) throw new Error('The writing workspace is unavailable')
    navigation.throwIfAborted()
    const archived = workspaces.getSnapshot().archivedSessionIds
    const known = sessions.getSnapshot().byId
    const prior = workspace.sessionIds.filter(id => isWritingSession(id) && !archived.includes(id))
      .sort((a, b) => (known[b]?.updatedAt ?? 0) - (known[a]?.updatedAt ?? 0))[0]
    const id = prior ?? await ctx.sessions.create({ workspaceId: workspace.workspaceId, sessionId: newWritingSession() })
    if (navigation.aborted) return
    ctx.uiWorkspace.openSession(id)
  }
  const directoryFlow: HostObservable<boolean> = {
    getSnapshot: () => ctx.slots.entries(DIRECTORY_FLOW).length > 0,
    subscribe: listener => ctx.slots.subscribe(DIRECTORY_FLOW, listener),
  }

  ctx.effect(() => ctx.locale.register(NS, { en, zh, de, es, fr, ja, pt, ru }), 'hongzhong: dictionaries')
  ctx.effect(() => ctx.uiWorkspace.registerSessionMode({ matches: isWritingSession, createId: newWritingSession }),
    'hongzhong: writing conversations')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID, kind: TAB_KIND, keepMounted: true, title: () => t('articleEditor'),
  }), 'hongzhong: writing tab')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: TAB_ID, order: 29,
    inject: sessionId => ({
      reveal: () => {
        if (isWritingSession(sessionId) && ctx.sidebarRight.mounted.getSnapshot() === sessionId
          && ctx.sidebarRight.active()?.kind !== TAB_KIND) {
          ctx.sidebarRight.openTab(TAB_KIND)
        }
      },
    }),
  }, RevealWritingTab))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS,
    children: { 'workbench.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
    inject: () => ({ associate, hooks: { articleWorkspaces: workspaces, directoryFlow } }),
  }, WorkbenchLauncher))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS,
    inject: sessionId => ({ sessionId, publishing, hooks: { articleWorkspaces: workspaces, writingSessions: sessions } }),
  }, ArticleEditor))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, locale: NS, order: 22, label: () => t('panel'),
  }, EditorIcon))
}

/**
 * Register the Remote and its editor, then withdraw the editor before the Remote.
 * @param ctx - Browser plugin context.
 * @param contribution - Generated WeChat Remote descriptors.
 * @returns Disposer for the editor and Remote.
 */
export async function mountEditor(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.hongzhong', ...WORKBENCH_SERVICES], (client) => {
    registerEditor(client, createPublishing(client.remote.hongzhong))
  })
  try {
    await ui
  } catch (error: unknown) {
    await ui.dispose()
    await unmount()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmount()
  }
}
