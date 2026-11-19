/** Workspace association and navigation for a new review conversation. */

import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconFolderCloseRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { CaptureRegionIcon } from './Review.tsx'
import type { ArchiveSummary } from '../types.ts'
import type {} from './locales.ts'
import css from './WorkbenchLauncher.module.css'

type LauncherFace = {
  readonly hooks: {
    readonly workbenchWorkspaces: ObservableSnapshot<WorkspaceSnapshot>
    readonly workbenchSessions: ObservableSnapshot<SessionListState>
    readonly reviewRevision: ObservableSnapshot<number>
  }
  readonly listReviews: (workspace: WorkspaceView) => Promise<ArchiveSummary[]>
  readonly associate: (workspaceId: WorkspaceId | undefined, signal: AbortSignal) => Promise<void>
  readonly reopen: (workspace: WorkspaceView, id: string, signal: AbortSignal) => Promise<void>
}

type ReviewHistory = {
  readonly archives: ReadonlyMap<WorkspaceId, readonly ArchiveSummary[]>
  readonly failed: boolean
}

/**
 * Show the workbench's navigation icon in the sidebar.
 * @param props - sidebar icon dimensions.
 * @returns the workbench glyph.
 */
export function WorkbenchIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <CaptureRegionIcon size={size} />
}

/**
 * Associate a directory before creating a new review conversation.
 * @param props - available workspaces and the association operation.
 * @returns the workbench entry panel.
 */
export function WorkbenchLauncher({
  useWorkbenchWorkspaces, useWorkbenchSessions, useReviewRevision, listReviews, associate, reopen, t,
}: PropsRuntime<'main'> & PropsLocale<'sidebarReview'> & InjectFace<LauncherFace>): ReactNode {
  const { items, archivedSessionIds } = useWorkbenchWorkspaces(snapshot => snapshot)
  const phase = useWorkbenchSessions(snapshot => snapshot.phase)
  const revision = useReviewRevision(value => value)
  const [history, setHistory] = useState<ReviewHistory>()
  useEffect(() => {
    let active = true
    const entries = items.map(async workspace => [workspace.workspaceId, await listReviews(workspace)] as const)
    void Promise.allSettled(entries).then((results) => {
      if (!active) return
      const archives = new Map(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))
      setHistory({ archives, failed: results.some(result => result.status === 'rejected') })
    })
    return () => { active = false }
  }, [listReviews, items, archivedSessionIds, phase, revision])

  const previous = items.flatMap((workspace) => {
    const [latest, ...older] = history?.archives.get(workspace.workspaceId) ?? []
    return latest === undefined ? [] : [{ workspace, latest, older }]
  }).sort((a, b) => b.latest.updatedAt - a.latest.updatedAt)
  const [pending, setPending] = useState<AbortController>()
  const [failed, setFailed] = useState(false)
  const startTitle = useId()
  useEffect(() => () => { pending?.abort() }, [pending])

  const open = async (request: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (pending !== undefined) return
    const operation = new AbortController()
    setPending(operation)
    setFailed(false)
    try { await request(operation.signal) }
    catch (_error: unknown) { if (!operation.signal.aborted) setFailed(true) }
    finally { if (!operation.signal.aborted) setPending(undefined) }
  }

  return <section className={css.page} aria-label={t('workbench')} data-review-launcher>
    <div className={css.panel}>
      <h1>{t('workbench')}</h1>
      <section className={css.start} aria-labelledby={startTitle}>
        <h2 id={startTitle}>{t('startFromWorkspace')}</h2>
        <Button variant="primary" disabled={pending !== undefined} icon={<IconFolderCloseRegular />}
          onClick={() => { void open(signal => associate(undefined, signal)) }}>
          {t('chooseWorkspaceFolder')}
        </Button>
        {items.length > 0 && <ul className={css.workspaces}>{items.map(workspace => <li key={workspace.workspaceId}>
          <Button variant="outline" className={css.workspace} disabled={pending !== undefined}
            title={workspace.path} onClick={() => { void open(signal => associate(workspace.workspaceId, signal)) }}>
            <strong>{workspace.title}</strong><span>{workspace.path}</span>
          </Button>
        </li>)}</ul>}
        {pending !== undefined && <p role="status">{t('openingWorkbench')}</p>}
        {failed && <p role="alert" className={css.error}>{t('workbenchFailed')}</p>}
      </section>
      {history !== undefined && previous.length === 0 && <div className={css.historyEmpty}>
        <h2>{t('continueReview')}</h2>
        {history.failed
          ? <p role="alert" className={css.error}>{t('reviewHistoryFailed')}</p>
          : <p>{t('reviewHistoryEmpty')}</p>}
      </div>}
      {history?.failed === true && previous.length > 0 && <div className={css.historyEmpty}>
        <p role="alert" className={css.error}>{t('reviewHistoryFailed')}</p>
      </div>}
      {previous.length > 0 && <details className={`${css.previous} ${css.disclosure}`}>
        <summary>
          <IconChevronRightOutlineRegular className={css.disclosureChevron} size={14} aria-hidden="true" />
          {t('continueReview')}
        </summary>
        <ul className={css.workspaces}>{previous.map(({ workspace, latest, older }) => <li
          key={workspace.workspaceId} data-review-workspace>
          <Button variant="outline" className={css.workspace} disabled={pending !== undefined}
            title={workspace.path} data-review-session={latest.id}
            onClick={() => { void open(signal => reopen(workspace, latest.id, signal)) }}>
            <strong>{workspace.title}</strong>
            <span>{new Date(latest.updatedAt).toLocaleString()}</span>
          </Button>
          {older.length > 0 && <details className={`${css.history} ${css.disclosure}`}>
            <summary>
              <IconChevronRightOutlineRegular className={css.disclosureChevron} size={14} aria-hidden="true" />
              {t('olderReviews')}
            </summary>
            <ul className={css.historyList}>{older.map(session => <li key={session.id}>
              <Button variant="outline" data-review-session={session.id} disabled={pending !== undefined}
                onClick={() => { void open(signal => reopen(workspace, session.id, signal)) }}>
                {new Date(session.updatedAt).toLocaleString()}
              </Button>
            </li>)}</ul>
          </details>}
        </li>)}</ul>
      </details>}
    </div>
  </section>
}
