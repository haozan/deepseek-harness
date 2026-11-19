/** Conversation shortcuts for the review workspace and transcript tasks. */

import { useState, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { EVIDENCE_KIND, REVIEW_KIND, type CaptureDestination } from './Review.tsx'
import { isWorkbenchSession } from '../workbench.ts'
import type {} from './locales.ts'
import css from './ReviewShortcuts.module.css'

type Copy = PropsLocale<'sidebarReview'>
interface ReviewShortcutActions {
  readonly openWorkspace: (destination: CaptureDestination) => void
  readonly prepareTranscriptDraft: (prompt: string) => void
}

/**
 * Place shortcuts above a review conversation's composer.
 * @param props - workspace navigation and draft initialization for this Session.
 * @returns the shortcuts for this review conversation.
 */
export function ReviewShortcuts({ sessionId, openWorkspace, prepareTranscriptDraft, t }:
  PropsRuntime<'conversation.input.dock'> & InjectFace<ReviewShortcutActions> & Copy): ReactNode {
  const [openFailed, setOpenFailed] = useState(false)
  if (!isWorkbenchSession(sessionId)) return null
  const open = (destination: CaptureDestination): void => {
    try { openWorkspace(destination) }
    catch (_error: unknown) { setOpenFailed(true) }
  }
  return <div className={css.shortcuts} data-review-shortcuts>
    <Button variant="ghost" onClick={() => { open(REVIEW_KIND) }}>{t('openTranscript')}</Button>
    <Button variant="ghost" onClick={() => { open(EVIDENCE_KIND) }}>{t('openEvidence')}</Button>
    <Button variant="outline" onClick={() => { prepareTranscriptDraft(t('transcriptPrompt')) }}>{t('useTranscript')}</Button>
    {openFailed && <Toast icon={<IconWarningOutlineRegular />} text={t('workspaceOpenFailed')} onDone={() => { setOpenFailed(false) }} />}
  </div>
}
