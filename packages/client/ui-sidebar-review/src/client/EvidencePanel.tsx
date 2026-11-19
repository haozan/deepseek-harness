/** Evidence screenshots and their source links. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconRightUpOutlineRegular, IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewClip } from './clip-store.ts'
import { openCaptureSource, Screenshot } from './Review.tsx'
import type {} from './locales.ts'
import css from './Review.module.css'

type EvidenceProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'sidebarReview'> & InjectFace<{
  readonly hooks: { readonly reviewRevision: ObservableSnapshot<number> }
  readonly read: () => Promise<readonly ReviewClip[]>
}>

type LoadState = { readonly kind: 'loading' | 'failed' }
  | { readonly kind: 'ready'; readonly clips: readonly ReviewClip[] }

/**
 * List the Session's evidence screenshots and reveal the one requested by its source frame.
 * @param props - Session-scoped screenshot loader and pane actions.
 * @returns the evidence directory tab.
 */
export function EvidencePanel({ useTabInfo, useReviewRevision, read, t }: EvidenceProps): ReactNode {
  const { tab } = useTabInfo()
  const { params, revision: navigationRevision } = tab.navigation
  const requested = params !== undefined && 'evidenceEntry' in params ? params.evidenceEntry : undefined
  const panel = useRef<HTMLElement>(null)
  const revealed = useRef<number>()
  const revision = useReviewRevision(value => value)
  const [retry, setRetry] = useState(0)
  const [list, setList] = useState<LoadState>({ kind: 'loading' })
  const [sourceFailed, setSourceFailed] = useState(false)

  useEffect(() => {
    let active = true
    void read().then((clips) => {
      if (active) setList({ kind: 'ready', clips })
    }, () => { if (active) setList({ kind: 'failed' }) })
    return () => { active = false }
  }, [read, revision, retry])

  useEffect(() => {
    if (!tab.visible || requested === undefined || revealed.current === navigationRevision) return
    const item = panel.current?.querySelector<HTMLButtonElement>(`[data-evidence-entry="${requested}"]`)
    if (item === null || item === undefined) return
    revealed.current = navigationRevision
    item.scrollIntoView({ block: 'nearest' })
    item.focus({ preventScroll: true })
  }, [list, navigationRevision, requested, tab.visible])

  return <section ref={panel} className={css.panel} aria-label={t('evidenceDirectory')} data-evidence-panel>
    {list.kind !== 'ready' || list.clips.length === 0
      ? <div className={css.empty}>
        <p>{t(list.kind === 'loading' ? 'loading' : list.kind === 'failed' ? 'loadFailed' : 'evidenceEmpty')}</p>
        {list.kind === 'failed' && <Button size="sm" onClick={() => {
          setList({ kind: 'loading' })
          setRetry(value => value + 1)
        }}>{t('retry')}</Button>}
      </div>
      : <ul className={css.evidenceList}>
        {list.clips.map(clip => <li key={clip.id}>
          <button type="button" className={css.evidenceItem} data-evidence-entry={clip.id}
            aria-label={t('openSource', { name: clip.fileName })} aria-current={requested === clip.id ? 'true' : undefined}
            onClick={() => {
              try { openCaptureSource(tab.actions, clip) }
              catch (_error: unknown) { setSourceFailed(true) }
            }}>
            <Screenshot png={clip.png} />
            <span title={clip.fileName}>{clip.fileName}</span>
            <IconRightUpOutlineRegular />
          </button>
        </li>)}
      </ul>}
    {sourceFailed && <Toast icon={<IconWarningOutlineRegular />} text={t('openFailed')} onDone={() => { setSourceFailed(false) }} />}
  </section>
}
