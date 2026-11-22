/** Identity shared by the writing launcher and its model context. */

/** Prefix assigned to conversations created by the writing workbench. */
export const WRITING_SESSION_PREFIX = 'wechat-writing-'

/**
 * Identify a conversation created by the writing workbench.
 * @param id - The DSH Session identity.
 * @returns Whether this conversation belongs to a writing workspace.
 */
export function isWritingSession(id: string): boolean {
  return id.startsWith(WRITING_SESSION_PREFIX)
}
