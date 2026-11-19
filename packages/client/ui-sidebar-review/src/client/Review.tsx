/** File toolbar controls and the Session's saved screenshots. */

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button, IconChecklistOutlineRegular,
  IconLoadingOutlineRegular, IconWarningOutlineRegular, Menu, Toast, Tooltip, type IconProps, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentCaptureFrame } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { SidebarRightTabActions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CapturePageRegion, CaptureRegion } from '../types.ts'
import type { ReviewClip } from './clip-store.ts'
import { Selection } from './Selection.tsx'
import { isWorkbenchSession } from '../workbench.ts'
import type {} from './locales.ts'
import css from './Review.module.css'

/** Page kind used to open the Session's screenshot list. */
export const REVIEW_KIND = 'review-clips'

/** Page kind for the Session's evidence screenshots. */
export const EVIDENCE_KIND = 'evidence-clips'

/** Tab that owns a saved capture. */
export type CaptureDestination = typeof REVIEW_KIND | typeof EVIDENCE_KIND

/** One crop with its retry identity, before a card number has been assigned. */
export type PendingCapture = Omit<ReviewClip, 'id' | 'sessionId' | 'destination'> & { readonly captureId: string }

/**
 * Find the tab that owns a capture, including records saved before evidence capture was added.
 * @param clip - the stored capture destination.
 * @returns the owning tab kind.
 */
export function captureTab(clip: Pick<ReviewClip, 'destination'>): CaptureDestination {
  return clip.destination === 'evidence' ? EVIDENCE_KIND : REVIEW_KIND
}

/**
 * Open a capture's source beside its owning tab and reveal the saved frame.
 * @param actions - tab actions for the pane displaying the capture.
 * @param clip - screenshot with its source address and optional position.
 */
export function openCaptureSource(actions: SidebarRightTabActions, clip: ReviewClip): void {
  actions.openResource(clip.resourceAddress, { beside: true,
    params: clip.location === undefined ? undefined : {
      captureLocation: clip.location, captureTarget: { key: captureTab(clip), id: clip.id },
    },
  })
}

/**
 * Display a saved PNG with an object URL scoped to the rendered image.
 * @param props - the PNG data.
 * @returns the screenshot image.
 */
export function Screenshot({ png }: { readonly png: Blob }): ReactNode {
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const node = image.current
    /* v8 ignore next -- the image ref is attached before its effect. */
    if (node === null) return
    const url = URL.createObjectURL(png)
    node.src = url
    return () => { node.removeAttribute('src'); URL.revokeObjectURL(url) }
  }, [png])
  return <img className={css.screenshot} ref={image} alt="" loading="lazy" draggable={false} data-review-screenshot />
}

interface CaptureFace {
  readonly hooks: { readonly reviewRevision: ObservableSnapshot<number>; readonly autoRecognition: ObservableSnapshot<boolean> }
  readonly capture: CapturePageRegion
  readonly save: (clip: PendingCapture, destination: CaptureDestination) => Promise<number>
  readonly readFrames: (address: string) => Promise<readonly DocumentCaptureFrame[]>
}

type Copy = PropsLocale<'sidebarReview'>
type CaptureProps = PropsRuntime<'sidebar.right.tab.document.contentActions'> & InjectFace<CaptureFace> & Copy
type CaptureState = { readonly kind: 'idle' | 'failed' }
  | { readonly kind: 'selecting'; readonly bounds: CaptureRegion; readonly destination: CaptureDestination }
  | { readonly kind: 'saving'; readonly destination: CaptureDestination }
  | { readonly kind: 'retry'; readonly clip: PendingCapture; readonly destination: CaptureDestination }
type CaptureMenuItem = MenuItem & { captureId: number; destination: CaptureDestination }

function revealCapture(openTab: SidebarRightTabActions['openTab'], destination: CaptureDestination, id: number): void {
  if (destination === EVIDENCE_KIND) openTab(EVIDENCE_KIND, { beside: true, params: { evidenceEntry: id } })
  else openTab(REVIEW_KIND, { beside: true, params: { reviewEntry: `clip:${id}` } })
}

/**
 * Draw the frame shared by the review capture action, shortcut, and tab.
 * @param props - display size and optional CSS class.
 * @returns the decorative capture icon.
 */
export function CaptureRegionIcon({ className, size = 16 }: IconProps): ReactNode {
  return <svg className={className} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor">
    <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6m4 0h2.5a1 1 0 0 1 1 1V6m0 4v2.5a1 1 0 0 1-1 1H10m-4 0H3.5a1 1 0 0 1-1-1V10" />
    <rect x="5.5" y="5.5" width="5" height="5" rx="0.5" />
  </svg>
}
/**
 * Offer capture for the currently visible document preview.
 * @param props - document address, viewport callback, and capture and save operations.
 * @returns the action and its active selection or feedback.
 */
export function CaptureAction({ sessionId, resourceAddress, fileName, getBounds, captureLocation, markCapture, reportCaptureFrames,
  hideCaptureFrame, openTab, capture, save, readFrames, useReviewRevision, useAutoRecognition, t }: CaptureProps): ReactNode {
  const reviewTrigger = useRef<HTMLButtonElement>(null)
  const evidenceTrigger = useRef<HTMLButtonElement>(null)
  const [state, setState] = useState<CaptureState>({ kind: 'idle' })
  const [framesFailed, setFramesFailed] = useState(false)
  const revision = useReviewRevision(value => value)
  const autoRecognition = useAutoRecognition(value => value)
  useEffect(() => () => { reportCaptureFrames([]) }, [reportCaptureFrames])
  useEffect(() => {
    let active = true
    void readFrames(resourceAddress).then((frames) => {
      if (!active) return
      setFramesFailed(false)
      reportCaptureFrames(frames)
    }, () => { if (active) setFramesFailed(true) })
    return () => { active = false }
  }, [readFrames, reportCaptureFrames, resourceAddress, revision])
  const cancel = useCallback(() => { setState({ kind: 'idle' }) }, [])
  const begin = (destination: CaptureDestination): void => {
    const bounds = getBounds()
    if (bounds === undefined) return
    const x = Math.max(0, bounds.left)
    const y = Math.max(0, bounds.top)
    const width = Math.min(window.innerWidth, bounds.right) - x
    const height = Math.min(window.innerHeight, bounds.bottom) - y
    if (width >= 4 && height >= 4) setState({ kind: 'selecting', destination, bounds: { x, y, width, height } })
  }
  const saveCapture = async (clip: PendingCapture, destination: CaptureDestination): Promise<void> => {
    const trigger = destination === EVIDENCE_KIND ? evidenceTrigger : reviewTrigger
    const button = trigger.current
    const mounted = (): boolean => button?.isConnected === true && trigger.current === button
    setState({ kind: 'saving', destination })
    let id: number
    try { id = await save(clip, destination) }
    catch (_error: unknown) {
      setState({ kind: 'retry', clip, destination })
      return
    }
    setState({ kind: 'idle' })
    if (!mounted()) return
    if (clip.location !== undefined) markCapture(clip.location, { key: destination, id })
    if (destination === EVIDENCE_KIND) revealCapture(openTab, destination, id)
    else openTab(REVIEW_KIND, { beside: true })
  }
  const saveSelection = async (region: CaptureRegion, destination: CaptureDestination): Promise<void> => {
    const trigger = destination === EVIDENCE_KIND ? evidenceTrigger : reviewTrigger
    const button = trigger.current
    const mounted = (): boolean => button?.isConnected === true && trigger.current === button
    const location = captureLocation(region)
    setState({ kind: 'saving', destination })
    hideCaptureFrame(true)
    let bytes: Uint8Array<ArrayBuffer>
    try {
      // Wait for the compositor to drop both the selection dialog and the previous frame.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve() })))
      if (!mounted()) return
      bytes = await capture(region)
      if (!mounted()) return
    } catch (_error: unknown) {
      setState({ kind: 'failed' })
      return
    } finally {
      hideCaptureFrame(false)
    }
    await saveCapture({ captureId: randomUUID(), resourceAddress, fileName, png: new Blob([bytes], { type: 'image/png' }),
      ...(location === undefined ? {} : { location }) }, destination)
  }

  const frameError = framesFailed
    && <Toast icon={<IconWarningOutlineRegular />} text={t('loadFailed')} onDone={() => { setFramesFailed(false) }} />
  if (!isWorkbenchSession(sessionId)) return frameError

  const saving = state.kind === 'saving'
  const captureDisabled = saving || state.kind === 'retry'
  const savingReview = saving && state.destination === REVIEW_KIND
  const savingEvidence = saving && state.destination === EVIDENCE_KIND
  return <>
    <Tooltip label={t('capture')} portal>
      <Button ref={reviewTrigger} size="sm" className={css.toolbarAction} disabled={captureDisabled} aria-busy={savingReview}
        aria-label={t('capture')} aria-description={autoRecognition ? t('autoRecognitionHint') : undefined}
        onClick={() => { begin(REVIEW_KIND) }} data-review-capture>
        {savingReview ? <IconLoadingOutlineRegular /> : <CaptureRegionIcon />}
      </Button>
    </Tooltip>
    <Tooltip label={t('captureEvidence')} portal>
      <Button ref={evidenceTrigger} size="sm" className={css.toolbarAction} disabled={captureDisabled} aria-busy={savingEvidence}
        aria-label={t('captureEvidence')} onClick={() => { begin(EVIDENCE_KIND) }} data-evidence-capture>
        {savingEvidence ? <IconLoadingOutlineRegular /> : <IconChecklistOutlineRegular size={16} />}
      </Button>
    </Tooltip>
    {state.kind === 'selecting' && <Selection key={resourceAddress} bounds={state.bounds} label={t('selecting')}
      onCancel={cancel} onSelect={(region) => { void saveSelection(region, state.destination) }} />}
    {state.kind === 'failed' && <Toast icon={<IconWarningOutlineRegular />} text={t('saveFailed')} onDone={cancel} />}
    {state.kind === 'retry' && <Button size="sm" variant="outline" onClick={() => { void saveCapture(state.clip, state.destination) }}>
      {t('retryCapture')}
    </Button>}
    {frameError}
  </>
}

/**
 * Reveal the frame's saved capture from the source pane. Its center passes pointer input to the preview.
 * @param props - saved capture identifier, pane-aware opener, and accessible label.
 * @returns one keyboard control with four pointer hit areas.
 */
export function CaptureFrameLink({ destination, id, openTab, t }:
  PropsRuntime<'sidebar.right.tab.document.captureAction'> & InjectFace<{ readonly destination: CaptureDestination }> & Copy,
): ReactNode {
  const label = t(destination === EVIDENCE_KIND ? 'locateEvidence' : 'locateCard')
  const trigger = useRef<HTMLButtonElement>(null)
  const [overlap, setOverlap] = useState<{
    x: number
    y: number
    items: readonly CaptureMenuItem[]
  }>()
  const focusTrigger = useCallback(() => trigger.current, [])
  const activate = (event: MouseEvent<HTMLButtonElement>): void => {
    const viewport = event.currentTarget.closest('[data-document-capture-frames]')
    if (event.detail > 0 && viewport !== null) {
      const x = event.clientX
      const y = event.clientY
      const hit = new Set(document.elementsFromPoint(x, y).map(edge => edge.closest('button[data-review-frame-id]')))
      const buttons = Array.from(viewport.querySelectorAll<HTMLButtonElement>('button[data-review-frame-id]'))
      const items = buttons.flatMap<CaptureMenuItem>((button, index) => {
        const recordId = Number(button.dataset.reviewFrameId)
        const kind = button.dataset.reviewFrameKind
        return hit.has(button) && Number.isSafeInteger(recordId) && (kind === REVIEW_KIND || kind === EVIDENCE_KIND)
          ? [{ id: String(recordId), captureId: recordId, destination: kind, label: t('captureNumber', { number: index + 1 }) }] : []
      })
      if (items.length > 1) {
        setOverlap({ x, y, items })
        return
      }
    }
    revealCapture(openTab, destination, id)
  }
  return <>
    <button ref={trigger} type="button" className={css.frameLink} aria-label={label} title={label}
      data-review-frame-id={id} data-review-frame-kind={destination} onClick={activate}>
      <span data-edge="top" aria-hidden="true" />
      <span data-edge="right" aria-hidden="true" />
      <span data-edge="bottom" aria-hidden="true" />
      <span data-edge="left" aria-hidden="true" />
    </button>
    {overlap !== undefined && <Menu open anchor={null} anchorPoint={overlap} autoFocus portal contextual returnFocus={focusTrigger}
      items={overlap.items} onClose={() => { setOverlap(undefined) }} onSelect={(chosen) => {
        const target = overlap.items.find(item => item.id === chosen)
        setOverlap(undefined)
        if (target !== undefined) revealCapture(openTab, target.destination, target.captureId)
      }} />}
  </>
}

/**
 * Identify the review tab with the same region icon as the capture action.
 * @param props - live tab information and locale supplied by the sidebar.
 * @returns the tab chip title.
 */
export function ReviewTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & Copy): ReactNode {
  return <><CaptureRegionIcon className={css.titleIcon} />{t('transcript')}</>
}

/**
 * Identify the evidence tab with the same list icon as the capture action.
 * @param props - live tab information and locale supplied by the sidebar.
 * @returns the tab chip title.
 */
export function EvidenceTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & Copy): ReactNode {
  return <><IconChecklistOutlineRegular size={16} className={css.titleIcon} />{t('evidenceDirectory')}</>
}
