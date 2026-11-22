/** Mount the WeChat Remote before the article editor that uses it. */

import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-hongzhong/remote'
import { mountEditor, WORKBENCH_SERVICES } from './register-editor.ts'

/** Services for the optional editor and its Remote. */
export const inject = ['remote', ...WORKBENCH_SERVICES]

/**
 * Mount the plugin's own RPC descriptors and remove them after the editor unloads.
 * @param ctx - Browser plugin context.
 * @returns Disposer for the editor and its Remote.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountEditor(ctx, remote)
}
