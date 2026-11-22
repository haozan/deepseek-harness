/** Send the opened article identity and revision without resending its files. */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-hongzhong/remote'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { expect, it, vi } from 'vitest'
import type { ArticleFolder, ArticleRevision, ArticleSourceVersion, WeChatAppId } from '../src/wechat-types.ts'
import { createPublishing, type OpenArticle } from '../src/client/publish.ts'

const appId = brandString<WeChatAppId>('wx0000000000000001')
const account = { appId, name: 'Testing account' }
const workspaceId = brandString<WorkspaceId>('writing')
const folder = brandString<ArticleFolder>('2026-11-20_1902_Example')
const draft: OpenArticle = {
  location: { workspaceId, folder },
  preview: {
    title: 'Example', markdown: '# Example', html: '<h1>Example</h1>', coverSrc: null, missingImages: [],
    revision: brandString<ArticleRevision>('opened-version'), sourceVersion: brandString<ArticleSourceVersion>('file-version'),
  },
}

function mockRemote() {
  type Remote = ClientRemote['hongzhong']
  return {
    listArticles: vi.fn<Remote['listArticles']>().mockResolvedValue({ ok: true, value: { ok: true, value: [folder] } }),
    readArticle: vi.fn<Remote['readArticle']>().mockResolvedValue({ ok: true, value: { ok: true, value: draft.preview } }),
    setActiveArticle: vi.fn<Remote['setActiveArticle']>().mockResolvedValue({ ok: true, value: { ok: true, value: true } }),
    saveArticle: vi.fn<Remote['saveArticle']>().mockResolvedValue({ ok: true, value: { ok: true, value: draft.preview.sourceVersion } }),
    setDefaultAccount: vi.fn<Remote['setDefaultAccount']>().mockResolvedValue({ ok: true, value: { ok: true, value: account } }),
    listAccounts: vi.fn<Remote['listAccounts']>().mockResolvedValue({ ok: true, value: { ok: true, value: [account] } }),
    bindAccount: vi.fn<Remote['bindAccount']>().mockResolvedValue({ ok: true, value: { ok: true, value: account } }),
    removeAccount: vi.fn<Remote['removeAccount']>().mockResolvedValue({ ok: true, value: { ok: true, value: true } }),
    syncArticle: vi.fn<Remote['syncArticle']>().mockResolvedValue({ ok: true, value: { ok: true, value: 'wechat-draft' } }),
  }
}

it('lists and opens workspace articles and syncs the exact opened revision', async () => {
  const remote = mockRemote()
  const publishing = createPublishing(remote)
  const signal = new AbortController().signal
  await expect(publishing.listArticles(workspaceId, signal)).resolves.toEqual({ ok: true, value: [folder] })
  await expect(publishing.readArticle(draft.location, signal)).resolves.toEqual({ ok: true, value: draft.preview })
  expect(remote.listArticles).toHaveBeenCalledExactlyOnceWith(workspaceId, signal)
  expect(remote.readArticle).toHaveBeenCalledExactlyOnceWith(draft.location, signal)
  const session = brandString<SessionId>('wechat-writing-fixture')
  await expect(publishing.setActiveArticle(session, draft.location)).resolves.toEqual({ ok: true, value: true })
  await expect(publishing.saveArticle(draft.location, draft.preview.sourceVersion, 'Edited', signal))
    .resolves.toEqual({ ok: true, value: draft.preview.sourceVersion })
  await expect(publishing.setDefault(appId)).resolves.toEqual({ ok: true, value: account })
  await expect(publishing.sync(appId, draft)).resolves.toMatchObject({ ok: true, value: 'wechat-draft' })
  expect(remote.syncArticle).toHaveBeenCalledExactlyOnceWith(appId, draft.location, draft.preview.revision)
})

it('reports a lost sync response separately from account connection failures', async () => {
  const remote = mockRemote()
  const publishing = createPublishing(remote)
  const failure = { ok: false, error: new RemoteError('gateway/internal', 'Fixture connection failure', {}, {}) } as const
  remote.listAccounts.mockResolvedValueOnce(failure)
  remote.syncArticle.mockResolvedValueOnce(failure)
  await expect(publishing.list()).resolves.toEqual({ ok: false, failure: 'publishingUnavailable' })
  await expect(publishing.list()).resolves.toEqual({ ok: true, value: [account] })
  await expect(publishing.bind({ ...account, appSecret: 'fixture-secret' })).resolves.toEqual({ ok: true, value: account })
  await expect(publishing.remove(appId)).resolves.toEqual({ ok: true, value: true })
  await expect(publishing.sync(appId, draft)).resolves.toEqual({ ok: false, failure: 'draftOutcomeUnknown' })
})
