/** Article and account fields carried by the WeChat draft commands. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** The direct child folder containing an article in a registered workspace. */
export type ArticleFolder = Branded<'HongzhongArticleFolder'>

/** Exact revision of the source and image bytes shown in the preview. */
export type ArticleRevision = Branded<'HongzhongArticleRevision'>

/** Opaque Markdown version used to guard a save against an intervening write. */
export type ArticleSourceVersion = Branded<'HongzhongArticleSourceVersion'>

/** Identify a workspace article without exposing the Host's absolute path. */
export interface ArticleLocation {
  readonly workspaceId: WorkspaceId
  readonly folder: ArticleFolder
}

/** Typography applied consistently to a preview and its WeChat draft. */
export type ArticleTheme = 'classic' | 'editorial' | 'clean'

/** A registered article and the optional theme to render. */
export interface ArticleSelection extends ArticleLocation {
  readonly theme?: ArticleTheme
}

/** A rendered article and its original Markdown. */
export interface ArticlePreview {
  readonly title: string
  readonly markdown: string
  readonly html: string
  readonly coverSrc: string | null
  readonly missingImages: readonly string[]
  readonly revision: ArticleRevision
  readonly sourceVersion: ArticleSourceVersion
}

/** Workspace failures with recovery in the editor. */
export type ArticleFailure = 'workspaceUnavailable' | 'articleUnavailable' | 'articleChanged' | 'articleSaveFailed'

/** WeChat application identifier, which also selects a stored binding. */
export type WeChatAppId = Branded<'HongzhongWeChatAppId'>

/** Account information safe to display in the editor. */
export interface WeChatAccount {
  readonly appId: WeChatAppId
  readonly name: string
  readonly preferred?: true
}

/** Credential input for registering or updating one WeChat account. */
export interface WeChatBinding {
  readonly appId: string
  readonly name: string
  readonly appSecret: string
}

/** An original local image encoded for direct upload through the Host. */
export interface DraftImage {
  readonly path: string
  readonly mime: 'image/jpeg' | 'image/png'
  readonly base64: string
}

/** Source fields for one draft and the local images it can reference. */
export interface WeChatDraft {
  readonly title: string
  readonly markdown: string
  readonly cover: string
  readonly images: readonly DraftImage[]
}

/** Expected failures for which the editor can offer different recovery. */
export type WeChatFailure =
  | 'invalidAccount'
  | 'accountMissing'
  | 'invalidDraft'
  | 'missingImage'
  | 'invalidImage'
  | 'ipRestricted'
  | 'credentialRejected'
  | 'wechatRejected'
  | 'wechatUnavailable'
  | 'draftOutcomeUnknown'

/** An article or account command outcome, with optional WeChat diagnostics. */
export type WeChatResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false
    readonly failure: WeChatFailure | ArticleFailure
    readonly wechatCode?: number
    readonly outboundIp?: string
  }
