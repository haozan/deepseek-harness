/** Workspace association and the Markdown editor beside a native DSH conversation. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorkspaceSource, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { Button, IconEditOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArticleFolder, ArticleLocation, ArticleSourceVersion, ArticleTheme } from '../wechat-types.ts'
import { isWritingSession } from '../writing-session.ts'
import type { OpenArticle, Publishing } from './publish.ts'
import { WeChatPanel } from './WeChatPanel.tsx'
import css from './ArticleEditor.module.css'

type Workspaces = { hooks: { articleWorkspaces: WorkspaceSource } }
type LauncherProps = PropsRuntime<'main'> & PropsLocale<'hongzhong'> & PropsRenderSlots<'workbench.workspace.directoryFlow'> & InjectFace<{
  hooks: Workspaces['hooks'] & { directoryFlow: HostObservable<boolean> }
  associate(workspace: { workspaceId: WorkspaceId } | { path: string }, signal: AbortSignal): Promise<void>
}>
type EditorProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'hongzhong'> & InjectFace<Workspaces & {
  sessionId: SessionId
  publishing: Publishing
  hooks: Workspaces['hooks'] & { writingSessions: {
    getSnapshot(): SessionListState
    subscribe(listener: () => void): () => void
  } }
}>

interface WorkingDraft {
  readonly baseVersion: ArticleSourceVersion
  readonly markdown: string
}

const THEMES = [
  ['classic', 'themeClassic'], ['editorial', 'themeEditorial'], ['clean', 'themeClean'],
] as const

/**
 * Render the navigation glyph at the sidebar's requested size.
 * @param props - Icon size supplied by the sidebar.
 * @returns The workbench icon.
 */
export function EditorIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconEditOutlineRegular size={size} />
}

/**
 * Associate an existing workspace or register a local folder before opening the writing conversation.
 * @param props - Registered workspaces and the association action.
 * @returns The workbench entry.
 */
export function WorkbenchLauncher({ t, useArticleWorkspaces, useDirectoryFlow, renderSlot, associate }: LauncherProps): ReactNode {
  const { items, archivedSessionIds, state } = useArticleWorkspaces(value => value)
  const pickerAvailable = useDirectoryFlow(value => value)
  const request = useRef<AbortController>()
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const pending = busy || picking
  const [failed, setFailed] = useState(false)
  useEffect(() => () => { request.current?.abort() }, [])

  function open(workspace: { workspaceId: WorkspaceId } | { path: string }): void {
    const operation = new AbortController()
    request.current = operation
    setBusy(true)
    setFailed(false)
    void associate(workspace, operation.signal).catch((_error: unknown) => {
      if (!operation.signal.aborted) setFailed(true)
    }).finally(() => {
      request.current = undefined
      if (!operation.signal.aborted) setBusy(false)
    })
  }

  return <section className={css.launcher} aria-label={t('panel')}>
    <div className={css.launcherBody}>
      <h1>{t('panel')}</h1>
      <h2>{t('associateWorkspace')}</h2>
      <Button variant="primary" disabled={pending || !pickerAvailable} onClick={() => {
        setFailed(false)
        setPicking(true)
      }}>{t('chooseFolder')}</Button>
      {renderSlot('workbench.workspace.directoryFlow', {
        open: picking,
        busy,
        onPicked: (path) => { setPicking(false); open({ path }) },
        onCancel: () => { setPicking(false) },
        onError: () => { setPicking(false); setFailed(true) },
      })}
      {items.length > 0 && <ul className={css.workspaces}>{items.map((workspace) => {
        const continuing = workspace.sessionIds.some(id => isWritingSession(id) && !archivedSessionIds.includes(id))
        return <li key={workspace.workspaceId}>
          <Button variant="outline" className={css.workspace} title={workspace.path} disabled={pending}
            onClick={() => { open({ workspaceId: workspace.workspaceId }) }}>
            <span>{workspace.title}</span><small>{continuing ? t('continueWriting') : workspace.path}</small>
          </Button>
        </li>
      })}</ul>}
      {busy && <p className={css.status} role="status">{t('openingWorkspace')}</p>}
      {(failed || state === 'error') && <p className={css.error} role="alert">{t('workspaceUnavailable')}</p>}
    </div>
  </section>
}

/**
 * Edit and preview articles in a writing session's workspace.
 * @param props - Workspace files, turn status, localization, and publishing operations.
 * @returns The active article and its editing and synchronization controls.
 */
export function WorkspaceArticles({ workspace, sessionId, running, publishing, t }: PropsLocale<'hongzhong'> & {
  readonly workspace: WorkspaceView
  readonly sessionId: SessionId
  readonly running: boolean
  readonly publishing: Publishing
}): ReactNode {
  const [folders, setFolders] = useState<readonly ArticleFolder[]>()
  const [folder, selectFolder] = useState<ArticleFolder>()
  const [theme, setTheme] = useState<ArticleTheme>('classic')
  const [article, setArticle] = useState<OpenArticle>()
  const [edit, setEdit] = useState<WorkingDraft>()
  const [listFailed, setListFailed] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [contextFailed, setContextFailed] = useState(false)
  const [saveError, setSaveError] = useState<'articleSaveFailed' | 'articleChanged'>()
  const [generation, reload] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveRequest = useRef<AbortController>()
  const wasRunning = useRef(running)
  const workspaceId = workspace.workspaceId
  const available = folder !== undefined && folders?.includes(folder) ? folder : folders?.[0]
  const selected = edit === undefined ? available : article?.location.folder
  const listingReady = folders !== undefined
  const shown = article?.location.folder === selected ? article : undefined
  const preview = shown?.preview
  const dirty = edit !== undefined && edit.markdown !== preview?.markdown
  const conflicted = dirty && !readFailed && preview !== undefined && edit.baseVersion !== preview.sourceVersion

  useEffect(() => () => { saveRequest.current?.abort() }, [])

  useEffect(() => {
    if (wasRunning.current && !running) reload(value => value + 1)
    wasRunning.current = running
  }, [running])

  useEffect(() => {
    const request = new AbortController()
    void publishing.listArticles(workspaceId, request.signal).catch(() => undefined).then((result) => {
      if (request.signal.aborted) return
      if (result?.ok) {
        setFolders(result.value)
        setListFailed(false)
      } else setListFailed(true)
    })
    return () => { request.abort() }
  }, [workspaceId, publishing, generation])

  useEffect(() => {
    if (!listingReady) return
    const request = new AbortController()
    const location = selected === undefined ? null : { workspaceId, folder: selected }
    void publishing.setActiveArticle(sessionId, location).catch(() => undefined).then((result) => {
      if (!request.signal.aborted) setContextFailed(result?.ok !== true)
    })
    return () => { request.abort() }
  }, [workspaceId, sessionId, selected, publishing, listingReady, generation])

  useEffect(() => {
    if (selected === undefined) return
    const request = new AbortController()
    const location = { workspaceId, folder: selected, theme }
    setLoading(true)
    void publishing.readArticle(location, request.signal).catch(() => undefined).then((result) => {
      if (request.signal.aborted) return
      if (result?.ok) setArticle({ location, preview: result.value })
      setReadFailed(result?.ok !== true)
      setLoading(false)
    })
    return () => { request.abort() }
  }, [workspaceId, publishing, selected, theme, generation])

  function save(location: ArticleLocation, draft: WorkingDraft): void {
    const request = new AbortController()
    const cancelled = () => request.signal.aborted
    saveRequest.current = request
    setSaving(true)
    setSaveError(undefined)
    void publishing.saveArticle(location, draft.baseVersion, draft.markdown, request.signal)
      .catch(() => undefined)
      .then(async (result) => {
        if (cancelled()) return
        if (!result?.ok) {
          setSaveError(result?.failure === 'articleChanged' ? 'articleChanged' : 'articleSaveFailed')
          if (result?.failure === 'articleChanged') reload(value => value + 1)
          return
        }
        const savedLocation = { ...location, theme }
        const saved = await publishing.readArticle(savedLocation, request.signal).catch(() => undefined)
        if (cancelled()) return
        if (!saved?.ok) {
          setReadFailed(true)
          setEdit({ ...draft, baseVersion: result.value })
          return
        }
        setArticle({ location: savedLocation, preview: saved.value })
        setReadFailed(false)
        setEdit(undefined)
        reload(value => value + 1)
      }).finally(() => {
        if (!request.signal.aborted) setSaving(false)
      })
  }

  const syncReady = !dirty && !loading && !readFailed && !saving && shown?.location.theme === theme
  return (
    <>
      <div className={css.toolbar}>
        <label className={css.field}>
          {t('articles')}
          <select
            value={selected ?? ''} disabled={!folders?.length || dirty || saving}
            onChange={(event) => {
              selectFolder(event.currentTarget.value as ArticleFolder)
              setEdit(undefined)
              setReadFailed(false)
              setSaveError(undefined)
            }}
          >
            {!folders?.length && <option value="">—</option>}
            {folders?.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <Button variant="outline" disabled={saving} onClick={() => { reload(value => value + 1) }}>{t('refreshArticles')}</Button>
      </div>
      {listFailed && <p className={css.error} role="alert">{t('workspaceUnavailable')}</p>}
      {readFailed && <p className={css.error} role="alert">{t('articleUnavailable')}</p>}
      {contextFailed && <p className={css.error} role="alert">{t('articleContextFailed')}</p>}
      {folders?.length === 0 && <p className={css.status}>{t('empty')}</p>}
      {preview === undefined && !listFailed && !readFailed && (folders === undefined || selected !== undefined)
        && <p className={css.status} role="status">{t('loadingArticle')}</p>}
      {shown !== undefined && (
        <>
          {shown.preview.missingImages.length > 0 && (
            <p className={css.error} role="alert">{t('imageReadFailed')} {shown.preview.missingImages.join(', ')}</p>
          )}
          {(conflicted || saveError !== undefined) && <p className={css.error} role="alert">
            {t(conflicted || saveError === 'articleChanged' ? 'editConflict' : 'articleSaveFailed')}
          </p>}
          <div className={css.panes}>
            <div className={css.field}>
              <label className={css.field}>
                <span className={css.sourceLabel}>{t('source')}</span>
                <textarea value={edit?.markdown ?? shown.preview.markdown} spellCheck={false} readOnly={saving}
                  onChange={(event) => {
                    const markdown = event.currentTarget.value
                    setEdit(markdown === shown.preview.markdown ? undefined
                      : { markdown, baseVersion: edit?.baseVersion ?? shown.preview.sourceVersion })
                    setSaveError(undefined)
                  }} />
              </label>
              <div className={css.editorActions}>
                <Button size="sm" variant="outline" disabled={!dirty || conflicted || saving}
                  onClick={edit === undefined ? undefined : () => { save(shown.location, edit) }}>
                  {t(saving ? 'savingArticle' : 'saveArticle')}
                </Button>
                {dirty && <Button size="sm" disabled={saving} onClick={() => {
                  setEdit(undefined)
                  setSaveError(undefined)
                  reload(value => value + 1)
                }}>{t('discardArticleEdit')}</Button>}
              </div>
            </div>
            <section className={css.field} aria-label={t('preview')}>
              <div className={css.previewHeader}>
                <h2>{t('preview')}</h2>
                <label className={css.field}>
                  {t('theme')}
                  <select value={theme} disabled={saving} onChange={(event) => { setTheme(event.currentTarget.value as ArticleTheme) }}>
                    {THEMES.map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
                  </select>
                </label>
              </div>
              {dirty && <p className={css.status}>{t('previewSaved')}</p>}
              <div className={css.preview} aria-busy={loading}>
                {shown.preview.coverSrc !== null && <img src={shown.preview.coverSrc} className={css.cover} alt={t('coverImage')} />}
                <article dangerouslySetInnerHTML={{ __html: shown.preview.html }} />
              </div>
            </section>
          </div>
        </>
      )}
      <WeChatPanel draft={syncReady ? shown : undefined} publishing={publishing} t={t} />
    </>
  )
}

/**
 * Render the article editor in the writing Session's docked tab.
 * @param props - Session-scoped file and account operations.
 * @returns Markdown editing and preview.
 */
export function ArticleEditor({ t, useArticleWorkspaces, useWritingSessions, sessionId, publishing }: EditorProps): ReactNode {
  const workspace = useArticleWorkspaces(value => value.items.find(item => item.sessionIds.includes(sessionId)))
  const running = useWritingSessions(value => value.byId[sessionId]?.running ?? false)
  return <section className={css.page} aria-label={t('panel')}>
    {workspace === undefined ? <p className={css.status} role="status">{t('openingWorkspace')}</p>
      : <WorkspaceArticles key={workspace.workspaceId} workspace={workspace} sessionId={sessionId} running={running}
        publishing={publishing} t={t} />}
  </section>
}
