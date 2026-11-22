/** Client commands for workspace articles and their WeChat destinations. */

import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-hongzhong/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  ArticleFolder, ArticleLocation, ArticlePreview, ArticleSelection, ArticleSourceVersion,
  WeChatAccount, WeChatAppId, WeChatBinding, WeChatResult,
} from '../wechat-types.ts'

/** A workspace location and the exact revision opened by the author. */
export interface OpenArticle {
  readonly location: ArticleSelection
  readonly preview: ArticlePreview
}

/** Domain result or a failure to reach the Host for the operation. */
export type PublishingResult<Value> = WeChatResult<Value> | {
  readonly ok: false
  readonly failure: 'publishingUnavailable'
}

/** Commands used by the article browser and account panel. */
export interface Publishing {
  listArticles(workspaceId: WorkspaceId, signal: AbortSignal): Promise<PublishingResult<ArticleFolder[]>>
  readArticle(location: ArticleSelection, signal: AbortSignal): Promise<PublishingResult<ArticlePreview>>
  setActiveArticle(sessionId: SessionId, location: ArticleLocation | null): Promise<PublishingResult<boolean>>
  saveArticle(
    location: ArticleLocation, version: ArticleSourceVersion, markdown: string, signal: AbortSignal,
  ): Promise<PublishingResult<ArticleSourceVersion>>
  list(): Promise<PublishingResult<WeChatAccount[]>>
  bind(binding: WeChatBinding): Promise<PublishingResult<WeChatAccount>>
  remove(id: WeChatAppId): Promise<PublishingResult<boolean>>
  setDefault(id: WeChatAppId): Promise<PublishingResult<WeChatAccount>>
  sync(id: WeChatAppId, article: OpenArticle): Promise<PublishingResult<string>>
}

function fromRemote<T>(response: RemoteResult<WeChatResult<T>>): PublishingResult<T> {
  return response.ok ? response.value : { ok: false, failure: 'publishingUnavailable' }
}

/**
 * Bind the UI commands to this Host's generated Remote.
 * @param remote - Generated article and publishing commands.
 * @returns Operations available to the browser.
 */
export function createPublishing(remote: ClientRemote['hongzhong']): Publishing {
  return {
    listArticles: async (workspaceId, signal) => fromRemote(await remote.listArticles(workspaceId, signal)),
    readArticle: async (location, signal) => fromRemote(await remote.readArticle(location, signal)),
    setActiveArticle: async (sessionId, location) => fromRemote(await remote.setActiveArticle(sessionId, location)),
    saveArticle: async (location, version, markdown, signal) => fromRemote(await remote.saveArticle(location, version, markdown, signal)),
    list: async () => fromRemote(await remote.listAccounts()),
    bind: async binding => fromRemote(await remote.bindAccount(binding)),
    remove: async id => fromRemote(await remote.removeAccount(id)),
    setDefault: async id => fromRemote(await remote.setDefaultAccount(id)),
    sync: async (id, article) => {
      const result = await remote.syncArticle(id, article.location, article.preview.revision)
      return result.ok ? result.value : { ok: false, failure: 'draftOutcomeUnknown' }
    },
  }
}
