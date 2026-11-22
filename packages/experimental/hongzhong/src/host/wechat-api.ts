/** The Host's direct requests to the WeChat Official Account API. */

import { isIP } from 'node:net'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { DraftImage, WeChatAppId, WeChatFailure } from '../wechat-types.ts'

const API = 'https://api.weixin.qq.com/cgi-bin/'

/** A request failure safe to report without sending credentials or article content to the client. */
export class WeChatError extends HarnessError {
  /**
   * @param failure - Recovery category.
   * @param wechatCode - Upstream error number, when available.
   * @param outboundIp - Validated address that WeChat reports for an allowlist rejection.
   */
  constructor(readonly failure: WeChatFailure, readonly wechatCode?: number, readonly outboundIp?: string) {
    super('The WeChat operation did not complete.', 'HONGZHONG_WECHAT')
  }
}

/** Host-only credential selected by application ID. */
export interface BoundAccount {
  readonly appId: WeChatAppId
  readonly appSecret: string
}

/** A body image ready to upload with its verified type and bytes. */
export interface UploadImage {
  readonly mime: DraftImage['mime']
  readonly bytes: Uint8Array<ArrayBuffer>
}

type Payload = Readonly<Record<string, unknown>>

function record(value: unknown, failure: WeChatFailure): Payload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WeChatError(failure)
  return value as Payload
}

function resultString(value: unknown, failure: WeChatFailure): string {
  if (typeof value !== 'string' || value.length === 0) throw new WeChatError(failure)
  return value
}

function reportedIp(details: unknown): string | undefined {
  if (typeof details !== 'string') return undefined
  const address = /\binvalid ip\s+([\da-f:.]+)(?=[\s,]|$)/i.exec(details)?.[1]
  return address !== undefined && isIP(address) !== 0 ? address : undefined
}

/** The operations for creating a news draft with account-owned media. */
export class WeChatApi {
  /** @param timeoutMs - Per-request timeout. @param send - HTTP transport; production uses the composed Host fetch. */
  constructor(private readonly timeoutMs: number, private readonly send: typeof fetch = fetch) {}

  private async post(
    path: string, data: Payload | FormData, signal: AbortSignal, token?: string, cover = false,
  ): Promise<Payload> {
    const url = new URL(path, API)
    if (token !== undefined) url.searchParams.set('access_token', token)
    if (cover) url.searchParams.set('type', 'image')
    const body = data instanceof FormData ? data : JSON.stringify(data)
    let raw: unknown
    try {
      const response = await this.send(url, {
        method: 'POST',
        body,
        ...(typeof body === 'string' ? { headers: { 'content-type': 'application/json' } } : {}),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      })
      if (!response.ok) throw new WeChatError('wechatUnavailable')
      raw = await response.json()
    } catch (_error: unknown) {
      // A POST can have been committed before the connection or response failed.
      throw new WeChatError(path === 'draft/add' ? 'draftOutcomeUnknown' : 'wechatUnavailable')
    }
    const output = record(raw, path === 'draft/add' ? 'draftOutcomeUnknown' : 'wechatUnavailable')
    const code = output.errcode
    if (typeof code === 'number' && code !== 0) {
      if (code === 40164) throw new WeChatError('ipRestricted', code, reportedIp(output.errmsg))
      if (code === 40001 || code === 40013 || code === 40125) throw new WeChatError('credentialRejected', code)
      throw new WeChatError('wechatRejected', code)
    }
    return output
  }

  /**
   * Get a stable token without rotating a token already used by the account.
   * @param account - Bound account credentials.
   * @param signal - Cancellation of the requesting operation.
   * @returns The token for this account.
   */
  async token(account: BoundAccount, signal: AbortSignal): Promise<string> {
    const output = await this.post('stable_token', {
      grant_type: 'client_credential', appid: account.appId, secret: account.appSecret, force_refresh: false,
    }, signal)
    return resultString(output.access_token, 'wechatUnavailable')
  }

  /**
   * Upload a local image to WeChat for the chosen use.
   * @param image - The verified image bytes.
   * @param token - The selected account's token.
   * @param role - Body images return URLs; covers return permanent media IDs.
   * @param signal - Cancellation of the requesting operation.
   * @returns The image address or media ID from WeChat.
   */
  async upload(image: UploadImage, token: string, role: 'body' | 'cover', signal: AbortSignal): Promise<string> {
    const cover = role === 'cover'
    const form = new FormData()
    form.set('media', new Blob([image.bytes], { type: image.mime }), image.mime === 'image/png' ? 'image.png' : 'image.jpg')
    const output = await this.post(cover ? 'material/add_material' : 'media/uploadimg', form, signal, token, cover)
    return resultString(cover ? output.media_id : output.url, 'wechatUnavailable')
  }

  /**
   * Write an article to the chosen account's draft box.
   * @param draft - The title, HTML body, and uploaded cover ID.
   * @param token - The selected account's token.
   * @param signal - Cancellation of the requesting operation.
   * @returns The new draft's media ID.
   */
  async createDraft(
    draft: { title: string; content: string; thumb_media_id: string },
    token: string,
    signal: AbortSignal,
  ): Promise<string> {
    const output = await this.post('draft/add', { articles: [draft] }, signal, token)
    return resultString(output.media_id, 'draftOutcomeUnknown')
  }
}
