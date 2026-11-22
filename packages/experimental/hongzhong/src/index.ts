/** Host commands for bound WeChat accounts and draft creation. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import z from '@deepseek-ai/schemastery'
import { WeChatApi, WeChatError, type BoundAccount } from './host/wechat-api.ts'
import { prepareDraft } from './host/wechat-draft.ts'
import {
  ArticleError, articlePath, listWorkspaceArticles, readWorkspaceArticle, saveWorkspaceArticle, selectedDraft, type ArticleLimits,
} from './host/workspace-articles.ts'
import type {
  ArticleFolder, ArticleLocation, ArticlePreview, ArticleRevision, ArticleSelection, ArticleSourceVersion,
  WeChatAccount, WeChatAppId, WeChatBinding, WeChatResult,
} from './wechat-types.ts'
import { isWritingSession } from './writing-session.ts'

/** Workspace file bounds and WeChat request timeout. */
export interface Config extends ArticleLimits {
  /** Maximum duration of each request to WeChat, in milliseconds. */
  readonly timeoutMs: number
}

const OWNER = 'hongzhong'
const APP_ID = /^wx[a-z0-9]{16}$/i
const DEFAULT_ACCOUNT = credentialKey(OWNER, 'default-account')

function preferredAccount(record: CredentialRecord | undefined): string | undefined {
  if (record?.kind !== 'grant') return undefined
  const value = record.payload
  return typeof value === 'object' && value !== null && 'appId' in value && typeof value.appId === 'string' ? value.appId : undefined
}

function bindingAccount(binding: WeChatBinding): BoundAccount & WeChatAccount {
  const appId = binding.appId.trim().toLowerCase()
  const name = binding.name.trim()
  const appSecret = binding.appSecret.trim()
  if (!APP_ID.test(appId) || name === '' || appSecret === '') throw new WeChatError('invalidAccount')
  return { appId: brandString<WeChatAppId>(appId), name, appSecret }
}

function storedAccount(record: CredentialRecord | undefined): (BoundAccount & WeChatAccount) | undefined {
  if (record?.kind !== 'grant') return undefined
  const value = record.payload
  if (typeof value !== 'object' || value === null
    || !('appId' in value) || typeof value.appId !== 'string' || !APP_ID.test(value.appId)
    || !('name' in value) || typeof value.name !== 'string' || value.name.trim() === ''
    || !('appSecret' in value) || typeof value.appSecret !== 'string' || value.appSecret.trim() === '') {
    throw new WeChatError('invalidAccount')
  }
  return { appId: brandString<WeChatAppId>(value.appId), name: value.name, appSecret: value.appSecret }
}

async function outcome<T>(operation: () => Promise<T>): Promise<WeChatResult<T>> {
  try { return { ok: true, value: await operation() } }
  catch (error: unknown) {
    if (error instanceof ArticleError) return { ok: false, failure: error.failure }
    if (!(error instanceof WeChatError)) throw error
    return {
      ok: false,
      failure: error.failure,
      ...(error.wechatCode === undefined ? {} : { wechatCode: error.wechatCode }),
      ...(error.outboundIp === undefined ? {} : { outboundIp: error.outboundIp }),
    }
  }
}

/** Owner-only WeChat operations. Article text and images are submitted only on sync. */
export default class Hongzhong extends TypertRemoteService {
  static inject = ['typert', 'credentials', 'workspaceRegistry', 'fs', 'systemPrompt']
  static Config = z.object({
    timeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
    maxMarkdownBytes: z.number().step(1).min(1).default(1024 * 1024).description('Maximum bytes in an article Markdown file.'),
    maxImageBytes: z.number().step(1).min(1).default(16 * 1024 * 1024).description('Maximum combined bytes of all article images.'),
  })
  private readonly api: WeChatApi
  private readonly activeArticles = new Map<SessionId, string>()

  /** @param ctx - Host services. @param config - Workspace read limits and WeChat request timeout. */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'hongzhong')
    this.api = new WeChatApi(config.timeoutMs)
    ctx.systemPrompt.context({
      name: 'wechat:writing-workbench',
      order: 230,
      interpolate: false,
      text: ({ agent }) => {
        const id = agent?.session.id
        if (id === undefined || !isWritingSession(id)) return ''
        const active = this.activeArticles.get(id)
        const guidance = 'Save articles to the workspace so the editor can display them. '
          + 'For each new article, create a separate folder named YYYY-MM-DD_HHmm_Title at the workspace root and write article.md inside it. '
          + 'Keep images in the article folder and reference them by relative paths. Use cover.jpg or cover.png for a cover when supplied.'
        return active === undefined ? guidance
          : `${guidance} When revising the open article, use this workspace-relative file: ${JSON.stringify(active)}.`
      },
    })
  }

  private workspacePath(id: WorkspaceId): string {
    const workspace = this.ctx.workspaceRegistry.get(id)
    if (workspace === undefined) throw new ArticleError('workspaceUnavailable')
    return workspace.path
  }

  /**
   * Find article folders in a registered workspace, including before its first session.
   * @param workspaceId - Registered workspace.
   * @param signal - Lifetime of the listing.
   * @returns Direct article folder names.
   */
  @Remote
  listArticles(workspaceId: WorkspaceId, signal: AbortSignal): Promise<WeChatResult<ArticleFolder[]>> {
    this.requireOwner('hongzhong/listArticles')
    return outcome(() => listWorkspaceArticles(this.ctx.fs, this.workspacePath(workspaceId), signal))
  }

  /**
   * Read and preview the Markdown and local images of one workspace article.
   * @param location - Registered workspace and direct article folder.
   * @param signal - Lifetime of the preview request.
   * @returns Preview of the current article files.
   */
  @Remote
  readArticle(location: ArticleSelection, signal: AbortSignal): Promise<WeChatResult<ArticlePreview>> {
    this.requireOwner('hongzhong/readArticle')
    return outcome(async () => {
      const path = this.workspacePath(location.workspaceId)
      const article = await readWorkspaceArticle(this.ctx.fs, path, location.folder, this.config, signal, location.theme)
      return article.preview
    })
  }

  /**
   * Record the article path available to this writing conversation.
   * @param sessionId - Writing Session in the registered workspace.
   * @param location - Selected article, or null when no article is open.
   * @returns Whether the active article context was accepted.
   */
  @Remote
  setActiveArticle(sessionId: SessionId, location: ArticleLocation | null): Promise<WeChatResult<boolean>> {
    this.requireOwner('hongzhong/setActiveArticle')
    return outcome(() => {
      if (!isWritingSession(sessionId)) throw new ArticleError('workspaceUnavailable')
      if (location === null) this.activeArticles.delete(sessionId)
      else {
        const workspace = this.ctx.workspaceRegistry.get(location.workspaceId)
        if (!workspace?.sessionIds.includes(sessionId)) throw new ArticleError('workspaceUnavailable')
        this.activeArticles.set(sessionId, articlePath(location.folder))
      }
      return Promise.resolve(true)
    })
  }

  /**
   * Guardedly save the Markdown shown in the workbench.
   * @param location - Registered workspace article.
   * @param sourceVersion - File version the edit was based on.
   * @param markdown - Replacement Markdown.
   * @param signal - Cancellation before publication.
   * @returns The new filesystem version.
   */
  @Remote
  saveArticle(
    location: ArticleLocation, sourceVersion: ArticleSourceVersion, markdown: string, signal: AbortSignal,
  ): Promise<WeChatResult<ArticleSourceVersion>> {
    this.requireOwner('hongzhong/saveArticle')
    return outcome(async () => {
      const path = this.workspacePath(location.workspaceId)
      const version = await saveWorkspaceArticle(
        this.ctx.fs, path, location.folder, brandString<FsVersion>(sourceVersion), markdown, this.config.maxMarkdownBytes, signal,
      )
      return brandString<ArticleSourceVersion>(version)
    })
  }

  private requireOwner(action: string): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('remote-access/denied', 'Only the Host owner may access WeChat accounts.', {
        action, reason: 'no-allow',
      })
    }
  }

  /**
   * List accounts bound on the Host without returning any credential.
   * @returns The saved account names and app IDs.
   */
  @Remote
  listAccounts(): Promise<WeChatResult<WeChatAccount[]>> {
    this.requireOwner('hongzhong/listAccounts')
    return outcome(async () => {
      const rows = await this.ctx.credentials.listRecords()
      const preferred = preferredAccount(await this.ctx.credentials.readRecord(DEFAULT_ACCOUNT))
      const accounts: WeChatAccount[] = []
      for (const row of rows) {
        if (!row.key.startsWith(`${OWNER}/`) || row.key === DEFAULT_ACCOUNT) continue
        const account = storedAccount(await this.ctx.credentials.readRecord(row.key))
        if (account !== undefined) accounts.push({
          appId: account.appId, name: account.name, ...(preferred === account.appId ? { preferred: true } : {}),
        })
      }
      return accounts.sort((a, b) => a.name.localeCompare(b.name) || a.appId.localeCompare(b.appId))
    })
  }

  /**
   * Save one bound account as the Host's default draft destination.
   * @param appId - Existing account binding.
   * @returns The account with its default designation.
   */
  @Remote
  setDefaultAccount(appId: WeChatAppId): Promise<WeChatResult<WeChatAccount>> {
    this.requireOwner('hongzhong/setDefaultAccount')
    return outcome(async () => {
      if (!APP_ID.test(appId)) throw new WeChatError('invalidAccount')
      const key = credentialKey(OWNER, appId.toLowerCase())
      const account = storedAccount(await this.ctx.credentials.readRecord(key))
      if (account === undefined) throw new WeChatError('accountMissing')
      await this.ctx.credentials.modifyRecord(DEFAULT_ACCOUNT, async () => {
        if (storedAccount(await this.ctx.credentials.readRecord(key)) === undefined) throw new WeChatError('accountMissing')
        return { kind: 'grant', payload: { appId: account.appId } }
      })
      return { appId: account.appId, name: account.name, preferred: true }
    })
  }

  /**
   * Validate credentials with WeChat and save them under their app ID.
   * @param binding - The account label, app ID, and app secret.
   * @param signal - Cancellation before the credential write.
   * @returns The saved account's display fields or the reason it could not bind.
   */
  @Remote
  bindAccount(binding: WeChatBinding, signal: AbortSignal): Promise<WeChatResult<WeChatAccount>> {
    this.requireOwner('hongzhong/bindAccount')
    return outcome(async () => {
      const account = bindingAccount(binding)
      await this.api.token(account, signal)
      signal.throwIfAborted()
      await this.ctx.credentials.modifyRecord(credentialKey(OWNER, account.appId), () => Promise.resolve({
        kind: 'grant', payload: account,
      }))
      return { appId: account.appId, name: account.name }
    })
  }

  /**
   * Remove the Host's saved credential for one account.
   * @param appId - Account whose local binding to remove.
   * @returns Whether the removal succeeded.
   */
  @Remote
  removeAccount(appId: WeChatAppId): Promise<WeChatResult<boolean>> {
    this.requireOwner('hongzhong/removeAccount')
    return outcome(async () => {
      if (!APP_ID.test(appId)) throw new WeChatError('invalidAccount')
      await this.ctx.credentials.deleteRecord(credentialKey(OWNER, appId.toLowerCase()))
      await this.ctx.credentials.modifyRecord(DEFAULT_ACCOUNT, record => Promise.resolve(
        preferredAccount(record) === appId.toLowerCase() ? { kind: 'grant', payload: { appId: null } } : undefined,
      ))
      return true
    })
  }

  /**
   * Upload the previewed workspace revision directly to a WeChat draft box.
   * @param appId - One bound account that owns the media and draft.
   * @param location - Registered workspace and direct article folder.
   * @param revision - The exact version shown in the preview.
   * @param signal - Cancellation of the operation.
   * @returns The media ID of the created draft, or a failure that distinguishes an uncertain write.
   */
  @Remote
  syncArticle(
    appId: WeChatAppId, location: ArticleSelection, revision: ArticleRevision, signal: AbortSignal,
  ): Promise<WeChatResult<string>> {
    this.requireOwner('hongzhong/syncArticle')
    return outcome(async () => {
      if (!APP_ID.test(appId)) throw new WeChatError('invalidAccount')
      const account = storedAccount(await this.ctx.credentials.readRecord(credentialKey(OWNER, appId.toLowerCase())))
      if (account === undefined) throw new WeChatError('accountMissing')
      const path = this.workspacePath(location.workspaceId)
      const article = await readWorkspaceArticle(this.ctx.fs, path, location.folder, this.config, signal, location.theme)
      const prepared = prepareDraft(selectedDraft(article, revision), location.theme)
      const token = await this.api.token(account, signal)
      const uploads = new Map<string, string>()
      for (const [path, image] of prepared.images) {
        uploads.set(path, await this.api.upload(image, token, 'body', signal))
      }
      const content = prepared.render(uploads)
      const cover = await this.api.upload(prepared.cover, token, 'cover', signal)
      return await this.api.createDraft({ title: prepared.title, content, thumb_media_id: cover }, token, signal)
    })
  }
}
