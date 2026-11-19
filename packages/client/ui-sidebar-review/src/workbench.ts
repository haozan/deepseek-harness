/** Durable identity for a conversation created from the review launcher. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

const PREFIX = 'review-workbench-'
const ARCHIVE_MARKER = '-archive-'

/**
 * Allocate a local Session that can reopen a portable review.
 * @param archiveId - existing portable review identity, or omit for a new review.
 * @returns a fresh local Session identity.
 */
export function newWorkbenchSession(archiveId?: string): SessionId {
  return brandString<SessionId>(`${PREFIX}${randomUUID()}${archiveId === undefined ? '' : ARCHIVE_MARKER + archiveId}`)
}

/**
 * Resolve a local review Session to the directory name used by its archive.
 * @param sessionId - local Session identity, including older Session ids.
 * @returns the stable review archive identity.
 */
export function archiveIdFor(sessionId: string): string {
  const marker = isWorkbenchSession(sessionId) ? sessionId.indexOf(ARCHIVE_MARKER, PREFIX.length) : -1
  return marker === -1 ? sessionId : sessionId.slice(marker + ARCHIVE_MARKER.length)
}

/**
 * Identify conversations explicitly created for reviewing a workspace.
 * @param sessionId - conversation identity assigned at launch.
 * @returns whether the review UI belongs to this conversation.
 */
export function isWorkbenchSession(sessionId: string): boolean {
  return sessionId.startsWith(PREFIX)
}
