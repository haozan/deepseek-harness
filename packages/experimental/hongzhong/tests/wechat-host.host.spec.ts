/** Owner-only bindings use the Host credential provider and selected account. */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import SystemPrompt, { type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import Hongzhong from '../src/index.ts'
import { listWorkspaceArticles, readWorkspaceArticle, saveWorkspaceArticle } from '../src/host/workspace-articles.ts'
import type { ArticleFolder, ArticleRevision, WeChatAppId } from '../src/wechat-types.ts'

const first = brandString<WeChatAppId>('wx0000000000000001')
const second = brandString<WeChatAppId>('wx0000000000000002')
const workspaceId = brandString<WorkspaceId>('workspace')
const folder = brandString<ArticleFolder>('2026-11-20_1902_Example')
const location = { workspaceId, folder }
const writingSession = brandString<SessionId>('wechat-writing-fixture')
const revision = brandString<ArticleRevision>('old-revision')
const limits = { timeoutMs: 500, maxMarkdownBytes: 1024, maxImageBytes: 8192 }

async function boot() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-hongzhong-test-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
  await ctx.plugin(LocalFileSystem, { cwd: home })
  await ctx.plugin(SystemPrompt, {})
  ctx.provide('workspaceRegistry', { get: (id: WorkspaceId) => id === workspaceId ? { path: home, sessionIds: [writingSession] } : undefined })
  await mkdir(join(home, folder))
  const article = join(home, folder, 'article.md')
  await writeFile(article, '# **Fixture**\n\n![Body](./cover.png)')
  await writeFile(join(home, folder, 'cover.png'), Buffer.from('iVBORw0KGgo=', 'base64'))
  const signal = new AbortController().signal
  const invocation: RemoteInvocation = {
    request: { namespace: 'hongzhong', method: 'fixture', args: {} },
    service: 'hongzhong', signal,
    peer: { ctx, id: brandString<PeerId>('test'), principal: { kind: 'owner' }, signal, interactions: 'none',
      dispose: async () => {},
    },
    async *uplink() {},
  }
  let requested = false
  ctx.accessor('invocation', { get: () => requested ? invocation : undefined })
  const request = vi.spyOn(globalThis, 'fetch')
  const requests: URL[] = []
  request.mockImplementation(async (input) => {
    if (!(input instanceof URL) || input.origin !== 'https://api.weixin.qq.com') {
      throw new Error('Unexpected request in the WeChat Host fixture')
    }
    requests.push(input)
    if (input.pathname.endsWith('/stable_token')) return Response.json({ access_token: 'mock-account-token' })
    if (input.pathname.endsWith('/uploadimg')) return Response.json({ url: 'https://mmbiz.qpic.cn/local.png' })
    if (input.pathname.endsWith('/add_material')) return Response.json({ media_id: 'mock-cover' })
    return Response.json({ media_id: 'mock-draft' })
  })
  onTestFinished(() => { request.mockRestore() })
  let service: Hongzhong | undefined
  await ctx.plugin({
    inject: ['credentials', 'fs', 'workspaceRegistry', 'systemPrompt'],
    apply: (scope: Context) => { service = new Hongzhong(scope, limits) },
  })
  if (service === undefined) throw new Error('Expected the article service')
  return { ctx, home, article, service, signal, requests, request, owner: () => { requested = true } }
}

it('requires a Host owner and keeps each account under its own credential key', async () => {
  const { ctx, service, signal, requests, owner } = await boot()
  expect(() => service.listAccounts()).toThrow('Only the Host owner')
  owner()
  await ctx.credentials.modifyRecord(credentialKey('other', 'record'), () => Promise.resolve({ kind: 'api-key', key: 'other-test' }))
  await ctx.credentials.modifyRecord(credentialKey('hongzhong', 'unused'), () => Promise.resolve({ kind: 'api-key', key: 'unused-test' }))
  await expect(service.bindAccount({ appId: first, name: 'Zeta', appSecret: 'zeta-fixture' }, signal))
    .resolves.toEqual({ ok: true, value: { appId: first, name: 'Zeta' } })
  await expect(service.bindAccount({ appId: second.toUpperCase(), name: 'Alpha', appSecret: 'alpha-fixture' }, signal))
    .resolves.toEqual({ ok: true, value: { appId: second, name: 'Alpha' } })
  await expect(service.listAccounts()).resolves.toEqual({
    ok: true, value: [{ appId: second, name: 'Alpha' }, { appId: first, name: 'Zeta' }],
  })
  await service.bindAccount({ appId: first, name: 'Alpha', appSecret: 'zeta-fixture' }, signal)
  await expect(service.listAccounts()).resolves.toEqual({
    ok: true, value: [{ appId: first, name: 'Alpha' }, { appId: second, name: 'Alpha' }],
  })
  await expect(service.listArticles(workspaceId, signal)).resolves.toEqual({ ok: true, value: [folder] })
  const preview = await service.readArticle(location, signal)
  expect(preview).toMatchObject({ ok: true, value: { title: 'Fixture', missingImages: [] } })
  if (!preview.ok) throw new Error('Expected the article preview')
  await expect(service.syncArticle(second, location, preview.value.revision, signal))
    .resolves.toEqual({ ok: true, value: 'mock-draft' })
  expect(requests.slice(4).map(url => url.searchParams.get('access_token')))
    .toEqual(['mock-account-token', 'mock-account-token', 'mock-account-token'])
  await expect(service.removeAccount(first)).resolves.toEqual({ ok: true, value: true })
  await expect(service.syncArticle(first, location, revision, signal)).resolves.toEqual({ ok: false, failure: 'accountMissing' })
  expect(await ctx.credentials.readRecord(credentialKey('hongzhong', second))).toMatchObject({ kind: 'grant' })
  expect(await ctx.credentials.readRecord(credentialKey('other', 'record'))).toBeDefined()
})

it('surfaces the WeChat allowlist address and saves no rejected binding', async () => {
  const { service, signal, request, owner } = await boot()
  owner()
  request.mockResolvedValueOnce(Response.json({
    errcode: 40164, errmsg: 'invalid ip 198.51.100.9 ipv6 ::ffff:198.51.100.9, not in whitelist rid: fixture',
  }))
  await expect(service.bindAccount({ appId: first, name: 'Rejected', appSecret: 'fixture' }, signal))
    .resolves.toEqual({ ok: false, failure: 'ipRestricted', outboundIp: '198.51.100.9', wechatCode: 40164 })
  await expect(service.listAccounts()).resolves.toEqual({ ok: true, value: [] })

  const malformed = brandString<WeChatAppId>('wrong')
  await expect(service.bindAccount({ appId: malformed, name: 'Invalid', appSecret: 'fixture' }, signal))
    .resolves.toEqual({ ok: false, failure: 'invalidAccount' })
  await expect(service.removeAccount(malformed)).resolves.toEqual({ ok: false, failure: 'invalidAccount' })
  await expect(service.syncArticle(malformed, location, revision, signal)).resolves.toEqual({ ok: false, failure: 'invalidAccount' })
  expect(request).toHaveBeenCalledTimes(1)
})

it('rejects stale and incomplete articles before contacting WeChat', async () => {
  const { home, article, service, signal, request, owner } = await boot()
  owner()
  await service.bindAccount({ appId: first, name: 'Author', appSecret: 'fixture' }, signal)
  const original = await service.readArticle(location, signal)
  if (!original.ok) throw new Error('Expected the original article')
  await writeFile(join(home, folder, 'cover.png'), Buffer.from('iVBORw0KGgoA', 'base64'))
  await expect(service.syncArticle(first, location, original.value.revision, signal))
    .resolves.toEqual({ ok: false, failure: 'articleChanged' })
  await writeFile(article, '![Unreadable](./missing.png)')
  const changed = await service.readArticle(location, signal)
  if (!changed.ok) throw new Error('Expected preview with a missing image')
  expect(changed.value.missingImages).toEqual(['./missing.png'])
  await expect(service.syncArticle(first, location, changed.value.revision, signal))
    .resolves.toEqual({ ok: false, failure: 'missingImage' })
  expect(request).toHaveBeenCalledTimes(1)
})

it('lists sorted article folders and identifies missing workspaces and source files', async () => {
  const { ctx, home, service, signal, owner } = await boot()
  owner()
  const newer = brandString<ArticleFolder>('2026-11-21_0800_第二篇')
  await mkdir(join(home, newer))
  await mkdir(join(home, 'not-an-article'))
  await mkdir(join(home, '.ignored'))
  await writeFile(join(home, newer, 'article.md'), '## Subheading\n\nNo cover yet.')
  await writeFile(join(home, '.ignored', 'article.md'), '# Hidden')
  await expect(service.listArticles(workspaceId, signal)).resolves.toEqual({ ok: true, value: [newer, folder] })
  await expect(service.listArticles(brandString<WorkspaceId>('missing'), signal))
    .resolves.toEqual({ ok: false, failure: 'workspaceUnavailable' })
  await expect(service.readArticle({ ...location, folder: newer }, signal)).resolves.toMatchObject({
    ok: true, value: { title: '第二篇', missingImages: [], coverSrc: null },
  })
  for (const invalid of ['../secrets', 'not-an-article', 'removed-article']) {
    await expect(service.readArticle({ ...location, folder: brandString<ArticleFolder>(invalid) }, signal))
      .resolves.toEqual({ ok: false, failure: 'articleUnavailable' })
  }
  const missing = join(home, 'deleted-workspace')
  await expect(listWorkspaceArticles(ctx.fs, missing, signal)).rejects.toMatchObject({ failure: 'workspaceUnavailable' })
  await expect(readWorkspaceArticle(ctx.fs, missing, folder, limits, signal)).rejects.toMatchObject({ failure: 'articleUnavailable' })
})

it('does not follow article aliases or image directories outside the article', async () => {
  const { home, article, service, signal, owner } = await boot()
  owner()
  const remotePictures = join(home, 'private-images')
  await mkdir(remotePictures)
  await writeFile(join(remotePictures, 'private.png'), Buffer.from('iVBORw0KGgo=', 'base64'))
  await symlink(remotePictures, join(home, folder, 'linked'), 'junction')
  const internalAlias = brandString<ArticleFolder>('alias')
  await symlink(join(home, folder), join(home, internalAlias), 'junction')
  await writeFile(article, '![Outside](./linked/private.png)\n\n![Parent](../private-images/private.png)')
  await expect(service.listArticles(workspaceId, signal)).resolves.toEqual({ ok: true, value: [folder] })
  await expect(service.readArticle({ ...location, folder: internalAlias }, signal))
    .resolves.toEqual({ ok: false, failure: 'articleUnavailable' })
  const opened = await service.readArticle(location, signal)
  if (!opened.ok) throw new Error('Expected the source to remain available')
  expect(opened.value.missingImages).toEqual(['./linked/private.png', '../private-images/private.png'])
  expect(opened.value.html).not.toContain('src=')
})

it('uses a verified JPEG cover and keeps over-limit images out of the preview', async () => {
  const { ctx, home, article, service, signal, owner, request } = await boot()
  owner()
  await rm(join(home, folder, 'cover.png'))
  await service.bindAccount({ appId: first, name: 'Author', appSecret: 'fixture' }, signal)
  const draft = await service.readArticle(location, signal)
  if (!draft.ok) throw new Error('Expected an article without a cover')
  await expect(service.syncArticle(first, location, draft.value.revision, signal))
    .resolves.toEqual({ ok: false, failure: 'missingImage' })
  expect(request).toHaveBeenCalledOnce()
  await writeFile(join(home, folder, 'cover.jpg'), Buffer.from('/9j/', 'base64'))
  await writeFile(join(home, folder, 'body.png'), Buffer.from('iVBORw0KGgo=', 'base64'))
  await writeFile(article, '# Example\n\n![Cover in body](cover.jpg)\n\n![Over limit](body.png)')
  const result = await readWorkspaceArticle(ctx.fs, home, folder, { ...limits, maxImageBytes: 5 }, signal)
  expect(result.preview.coverSrc).toBe('data:image/jpeg;base64,/9j/')
  expect(result.preview.html).toContain('data:image/jpeg;base64,/9j/')
  expect(result.preview.missingImages).toEqual(['body.png'])
})

it('reports invalid stored grants and propagates failures of the credential provider', async () => {
  const { ctx, service, owner } = await boot()
  owner()
  await ctx.credentials.modifyRecord(credentialKey('hongzhong', first), () => Promise.resolve({
    kind: 'grant', payload: { appId: first, name: 'Missing secret' },
  }))
  await expect(service.listAccounts()).resolves.toEqual({ ok: false, failure: 'invalidAccount' })
  const list = vi.spyOn(ctx.credentials, 'listRecords').mockRejectedValueOnce(new Error('Fixture credential store failed'))
  onTestFinished(() => { list.mockRestore() })
  await expect(service.listAccounts()).rejects.toThrow('Fixture credential store failed')
})

it('rejects an intervening Markdown change and saves edited text to the workspace', async () => {
  const { service, signal, owner, article } = await boot()
  owner()
  const before = await service.readArticle(location, signal)
  if (!before.ok) throw new Error('Expected an article')
  const next = '# Updated in the editor'
  await expect(service.saveArticle(location, before.value.sourceVersion, next, signal)).resolves.toMatchObject({ ok: true })
  expect(await readFile(article, 'utf8')).toBe(next)
  await writeFile(article, '# Updated from a session')
  await expect(service.saveArticle(location, before.value.sourceVersion, 'Old edit', signal))
    .resolves.toEqual({ ok: false, failure: 'articleChanged' })
  await expect(service.saveArticle(location, before.value.sourceVersion, 'a'.repeat(2000), signal))
    .resolves.toEqual({ ok: false, failure: 'articleSaveFailed' })
  expect(await readFile(article, 'utf8')).toBe('# Updated from a session')
})

it('selects and clears the default account without exposing credentials', async () => {
  const { service, owner, signal } = await boot()
  owner()
  await expect(service.setDefaultAccount(brandString<WeChatAppId>('bad')))
    .resolves.toEqual({ ok: false, failure: 'invalidAccount' })
  await expect(service.setDefaultAccount(first)).resolves.toEqual({ ok: false, failure: 'accountMissing' })
  const account = { appId: first, name: 'Fixture' }
  await service.bindAccount({ ...account, appSecret: 'not-a-real-secret' }, signal)
  await expect(service.setDefaultAccount(first)).resolves.toEqual({ ok: true, value: { ...account, preferred: true } })
  await expect(service.listAccounts()).resolves.toEqual({ ok: true, value: [{ ...account, preferred: true }] })
  await service.removeAccount(first)
  await service.bindAccount({ ...account, appSecret: 'not-a-real-secret' }, signal)
  await expect(service.listAccounts()).resolves.toEqual({ ok: true, value: [account] })
})

it('rejects a Markdown read when the source disappears, changes during the read, or becomes unreadable', async () => {
  const { ctx, home, signal } = await boot()
  const source = join(home, folder, 'article.md')
  const read = () => readWorkspaceArticle(ctx.fs, home, folder, limits, signal)
  vi.spyOn(ctx.fs, 'stat').mockResolvedValueOnce(undefined)
  await expect(read()).rejects.toMatchObject({ failure: 'articleUnavailable' })
  const bytes = ctx.fs.readBytes.bind(ctx.fs)
  vi.spyOn(ctx.fs, 'readBytes').mockImplementationOnce(async (path, abort, limit) => {
    const result = await bytes(path, abort, limit)
    await writeFile(source, '# Changed while reading')
    return result
  })
  await expect(read()).rejects.toMatchObject({ failure: 'articleChanged' })
  vi.spyOn(ctx.fs, 'readBytes').mockRejectedValueOnce(new Error('Volume unavailable'))
  await expect(read()).rejects.toMatchObject({ failure: 'articleUnavailable' })
  const file = await ctx.fs.stat(await ctx.fs.resolve(source, { signal }), signal)
  if (file?.type !== 'file') throw new Error('Missing fixture Markdown file')
  vi.spyOn(ctx.fs, 'writeText').mockRejectedValueOnce(new Error('Volume is read-only'))
  await expect(saveWorkspaceArticle(ctx.fs, home, folder, file.version, '# Replacement', limits.maxMarkdownBytes, signal))
    .rejects.toMatchObject({ failure: 'articleSaveFailed' })
})

it('does not set a default for an account unbound during the update', async () => {
  const { ctx, service, owner, signal } = await boot()
  owner()
  const account = { appId: first, name: 'Fixture' }
  await service.bindAccount({ ...account, appSecret: 'not-a-real-secret' }, signal)
  const started = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
  vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementationOnce(async (key, mutate) => {
    started.resolve(undefined)
    await resume.promise
    return modify(key, mutate)
  })
  const setting = service.setDefaultAccount(first)
  await started.promise
  await service.removeAccount(first)
  resume.resolve(undefined)
  await expect(setting).resolves.toEqual({ ok: false, failure: 'accountMissing' })
  await service.bindAccount({ ...account, appSecret: 'not-a-real-secret' }, signal)
  await expect(service.listAccounts()).resolves.toEqual({ ok: true, value: [account] })
})

it('accepts only an article in the writing session’s registered workspace', async () => {
  const { service, owner, ctx } = await boot()
  owner()
  const mode = { agent: { session: { id: writingSession } } } as AssembleContext
  const read = async () => (await ctx.systemPrompt.assemble(mode)).contexts.find(entry => entry.name === 'wechat:writing-workbench')?.text
  expect(await read()).toContain('For each new article, create a separate folder')
  await expect(service.setActiveArticle(writingSession, location)).resolves.toEqual({ ok: true, value: true })
  expect(await read()).toContain(`${folder}/article.md`)
  await expect(service.setActiveArticle(writingSession, null)).resolves.toEqual({ ok: true, value: true })
  expect(await read()).not.toContain(`${folder}/article.md`)
  await expect(service.setActiveArticle(brandString<SessionId>('ordinary-session'), location))
    .resolves.toEqual({ ok: false, failure: 'workspaceUnavailable' })
  await expect(service.setActiveArticle(writingSession, { ...location, workspaceId: brandString<WorkspaceId>('other') }))
    .resolves.toEqual({ ok: false, failure: 'workspaceUnavailable' })
  const ordinary = { agent: { session: { id: brandString<SessionId>('ordinary-session') } } } as AssembleContext
  const output = await ctx.systemPrompt.assemble(ordinary)
  expect(output.contexts.find(entry => entry.name === 'wechat:writing-workbench')?.text).toBe('')
  expect((await ctx.systemPrompt.assemble()).contexts.find(entry => entry.name === 'wechat:writing-workbench')?.text).toBe('')
})
