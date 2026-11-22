/** Exercise the installed article bundle through the composed Web client. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { acknowledgeReloadConnectionLoss, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const localPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRfcAAAAASUVORK5CYII=',
  'base64',
)

const PROVIDER = 'wechat-writing-fixture'
const MODEL = 'writer'
const MODEL_EDIT = 'Draft produced by the writing conversation.'
const SECOND_FOLDER = '2026-11-19_1500_Second article'

class WritingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async listModels(provider: string) { return [{ provider, id: MODEL, name: MODEL }] }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.messages.some(message => message.role === 'tool')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The article is updated.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const id = ToolCallId('write-article')
    const name = 'edit'
    const args = JSON.stringify({
      file_path: `${SECOND_FOLDER}/article.md`, old_string: 'One more draft.',
      new_string: `One more draft.\n\n${MODEL_EDIT}`,
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

const FIRST_APP = 'wx0000000000000001'
const SECOND_APP = 'wx0000000000000002'

function mockWeChat() {
  const original = globalThis.fetch
  const requests: { path: string; token: string | null; body: unknown; type: string | null }[] = []
  let loseDraftResponse = false
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = URL.canParse(raw) ? new URL(raw) : undefined
    if (url?.origin !== 'https://api.weixin.qq.com') return await original(input, init)
    const data = init?.body
    const body: unknown = typeof data === 'string' ? JSON.parse(data) : data
    const path = url.pathname
    const token = url.searchParams.get('access_token')
    requests.push({ path, token, body, type: url.searchParams.get('type') })
    if (path === '/cgi-bin/stable_token' && typeof body === 'object' && body !== null && 'appid' in body) {
      if ('secret' in body && body.secret === 'ip-fixture-secret') {
        return Response.json({
          errcode: 40164,
          errmsg: 'invalid ip 198.51.100.9 ipv6 ::ffff:198.51.100.9, not in whitelist rid: internal-id',
        })
      }
      const appId = body.appid
      if (appId === FIRST_APP || appId === SECOND_APP) return Response.json({ access_token: appId, expires_in: 7200 })
    }
    if (path === '/cgi-bin/media/uploadimg') return Response.json({ url: 'https://mmbiz.qpic.cn/example/body.png' })
    if (path === '/cgi-bin/material/add_material') return Response.json({ media_id: 'wechat-cover' })
    if (path === '/cgi-bin/draft/add') {
      if (loseDraftResponse) {
        loseDraftResponse = false
        return new Response('response interrupted')
      }
      return Response.json({ media_id: 'wechat-draft' })
    }
    throw new Error('Unexpected WeChat fixture request')
  })
  onTestFinished(() => { mock.mockRestore() })
  return { requests, loseNextDraftResponse: () => { loseDraftResponse = true } }
}

it('previews workspace articles and syncs the selected file revision to WeChat', async () => {
  const wechat = mockWeChat()
  const scaffold = await launchWebScaffold({
    profile: { packages: [{
      dir: fileURLToPath(new URL('../../../packages/experimental/hongzhong/', import.meta.url)),
      enabled: true,
    }] },
  })
  onTestFinished(() => scaffold.close())
  const adapter = new WritingAdapter()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
  const browser = await chromium.launch({ channel: 'chromium' })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-hongzhong-editor'))
  const errors = watchConsole(page)

  const entry = page.getByRole('button', { name: 'WeChat article publishing', exact: true })
  const launcher = page.getByRole('region', { name: 'WeChat article publishing', exact: true })
  const editor = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').getByRole('region', {
    name: 'WeChat article publishing', exact: true,
  })
  const composer = page.locator('[data-composer-input]').first()
  const enterWorkspace = async () => {
    await entry.click()
    await launcher.getByRole('button', { name: /^WeChat writing/ }).click()
    await composer.waitFor()
  }
  const body = editor.getByRole('textbox', { name: 'Markdown body', exact: true })
  const preview = editor.getByRole('region', { name: 'Preview', exact: true })
  const articles = editor.getByRole('combobox', { name: 'Articles', exact: true })
  const refresh = editor.getByRole('button', { name: 'Refresh articles', exact: true })
  const bodyImage = preview.getByRole('img', { name: '配图', exact: true })
  const coverImage = editor.getByRole('img', { name: 'Article cover', exact: true })

  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  await workspace.setTitle('WeChat writing')
  const firstFolder = '2026-11-20_1902_写给读者的一封信'
  const secondFolder = SECOND_FOLDER
  const firstSource = '# 写给读者的一封信\n\n保留 **中文排版**。\n\n> 这是一段引用。\n'
  const secondSource = '# Second article\n\nOne more draft.\n\n![配图](./images/海边.png)\n'
  const firstDir = join(scaffold.workspaceCwd, firstFolder)
  const secondDir = join(scaffold.workspaceCwd, secondFolder)
  await mkdir(firstDir)
  await mkdir(join(secondDir, 'images'), { recursive: true })
  await writeFile(join(firstDir, 'article.md'), firstSource)
  await writeFile(join(secondDir, 'article.md'), secondSource)
  await writeFile(join(secondDir, 'cover.png'), localPng)
  await writeFile(join(secondDir, 'images', '海边.png'), localPng)

  await page.goto(scaffold.authenticatedUrl)
  await enterWorkspace()
  await preview.getByRole('heading', { name: '写给读者的一封信' }).waitFor()
  expect(await preview.locator('strong').textContent()).toBe('中文排版')
  expect(await body.inputValue()).toBe(firstSource)
  expect(await body.getAttribute('readonly')).toBeNull()
  expect(await composer.isVisible()).toBe(true)
  await expect.poll(async () => {
    const [bodyBox, previewBox] = await Promise.all([body.boundingBox(), preview.locator('article').locator('..').boundingBox()])
    return bodyBox !== null && previewBox !== null
      && previewBox.x >= bodyBox.x + bodyBox.width && Math.abs(previewBox.y - bodyBox.y) <= 1
  }).toBe(true)
  await compareOrRefreshGolden(
    fileURLToPath(new URL('./expected/hongzhong-editor.expected.md', import.meta.url)),
    await editor.ariaSnapshot(),
    webSnapshotMode(),
  )
  await articles.selectOption(secondFolder)
  await expect.poll(() => bodyImage.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
  await expect.poll(() => coverImage.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
  expect(await bodyImage.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  expect(await coverImage.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  expect(await body.inputValue()).toBe(secondSource)

  const modelContext = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/hongzhong/setActiveArticle')
    && response.request().postData()?.includes(secondFolder) === true)
  await articles.selectOption(firstFolder)
  await preview.getByRole('heading', { name: '写给读者的一封信' }).waitFor()
  await articles.selectOption(secondFolder)
  const contextResponse: unknown = await (await modelContext).json()
  expect(contextResponse).toMatchObject({ result: { ok: true, value: { ok: true, value: true } } })
  const modelDone = scaffold.whenTurnSettled()
  await writeComposerDraft(page, composer, 'Add a sentence to the open article.')
  await composer.press('Enter')
  await modelDone
  await preview.getByText(MODEL_EDIT, { exact: true }).waitFor()
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain(`${secondFolder}/article.md`)
  expect(await readFile(join(secondDir, 'article.md'), 'utf8')).toContain(MODEL_EDIT)

  const editorSave = editor.getByRole('button', { name: 'Save Markdown', exact: true })
  const custom = (await body.inputValue()) + '\nEdited in the workspace editor.\n'
  await body.fill(custom)
  await editorSave.click()
  await preview.getByText('Edited in the workspace editor.', { exact: true }).waitFor()
  expect(await readFile(join(secondDir, 'article.md'), 'utf8')).toBe(custom)

  const accounts = editor.getByText('WeChat accounts', { exact: true })
  await accounts.click()
  await editor.getByText('No WeChat accounts are bound.').waitFor()
  const showBinding = editor.getByRole('button', { name: 'Bind account', exact: true })
  const fillBinding = async (name: string, appId: string, appSecret: string) => {
    await editor.getByRole('textbox', { name: 'Account name', exact: true }).fill(name)
    await editor.getByRole('textbox', { name: 'AppID', exact: true }).fill(appId)
    await editor.getByLabel('AppSecret', { exact: true }).fill(appSecret)
    await editor.getByRole('button', { name: 'Save binding', exact: true }).click()
  }
  await showBinding.click()
  await fillBinding('Main account', FIRST_APP, 'ip-fixture-secret')
  await editor.getByText('WeChat saw the IP address 198.51.100.9.', { exact: true }).waitFor()
  expect(await editor.getByText(/WeChat saw the IP address/).textContent()).not.toContain('internal-id')
  await fillBinding('Main account', FIRST_APP, 'main-fixture-secret')
  await editor.getByRole('radio', { name: `Main account ${FIRST_APP}`, exact: true }).waitFor()
  await showBinding.click()
  await fillBinding('Secondary account', SECOND_APP, 'secondary-fixture-secret')
  await editor.getByRole('radio', { name: `Secondary account ${SECOND_APP}`, exact: true }).waitFor()
  await editor.getByRole('group', { name: 'Main account' }).getByRole('button', { name: 'Make default', exact: true }).click()
  await editor.getByText('Sync to Main account', { exact: true }).waitFor()
  const reloadWarnings = errors.warnings.length
  await page.reload()
  if (!await editor.isVisible()) await enterWorkspace()
  await editor.waitFor()
  await articles.selectOption(secondFolder)
  await preview.getByRole('heading', { name: 'Second article' }).waitFor()
  await accounts.click()
  await editor.getByRole('radio', { name: `Secondary account ${SECOND_APP}`, exact: true }).waitFor()
  const sync = editor.getByRole('button', { name: 'Sync to draft box', exact: true })
  expect(await sync.isEnabled()).toBe(true)
  expect(await editor.textContent()).not.toContain('fixture-secret')
  expect(await editor.getByRole('radio', { name: `Main account ${FIRST_APP}`, exact: true }).isChecked()).toBe(true)
  await editor.getByRole('combobox', { name: 'Style', exact: true }).selectOption('editorial')
  await expect.poll(() => preview.locator('h1').getAttribute('style')).toContain('#963f2c')
  const beforeSync = wechat.requests.length
  await body.fill(custom + '\nUnsaved local changes.\n')
  await writeFile(join(secondDir, 'article.md'), custom + '\nUpdated outside the workbench.\n')
  await editorSave.click()
  await editor.getByText(/The file changed while you were editing/).waitFor()
  expect(await body.inputValue()).toContain('Unsaved local changes.')
  await editor.getByRole('button', { name: 'Discard unsaved changes' }).click()
  await preview.getByText('Updated outside the workbench.', { exact: true }).waitFor()
  await expect.poll(() => sync.isEnabled()).toBe(true)
  await writeFile(join(secondDir, 'article.md'), custom + '\nUpdated by another session.\n')
  await sync.click()
  await editor.getByText('The workspace article changed. Refresh the preview before syncing.', { exact: true }).waitFor()
  expect(wechat.requests).toHaveLength(beforeSync)
  await refresh.click()
  await preview.getByText('Updated by another session.', { exact: true }).waitFor()
  await sync.click()
  await editor.getByText('Synced to the WeChat draft box.', { exact: true }).waitFor()

  const sent = wechat.requests.slice(beforeSync)
  expect(sent.map(({ path, token }) => [path, token])).toEqual([
    ['/cgi-bin/stable_token', null],
    ['/cgi-bin/media/uploadimg', FIRST_APP],
    ['/cgi-bin/material/add_material', FIRST_APP],
    ['/cgi-bin/draft/add', FIRST_APP],
  ])
  expect(sent[0]?.body).toMatchObject({ appid: FIRST_APP, secret: 'main-fixture-secret', force_refresh: false })
  expect(sent[2]?.type).toBe('image')
  for (const request of sent.slice(1, 3)) {
    expect(request.body).toBeInstanceOf(FormData)
    if (!(request.body instanceof FormData)) throw new Error('Expected a WeChat multipart body')
    const image = request.body.get('media')
    if (!(image instanceof Blob)) throw new Error('Expected the local image bytes')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(localPng)
  }
  expect(sent[3]?.body).toMatchObject({
    articles: [{
      title: 'Second article',
      thumb_media_id: 'wechat-cover',
    }],
  })
  expect(JSON.stringify(sent[3]?.body)).toContain('https://mmbiz.qpic.cn/example/body.png')
  expect(JSON.stringify(sent[3]?.body)).toContain('font-size:24px')
  expect(JSON.stringify(sent[3]?.body)).toContain('#963f2c')
  expect(JSON.stringify(sent[3]?.body)).not.toContain('images/')

  wechat.loseNextDraftResponse()
  await editor.getByRole('radio', { name: `Secondary account ${SECOND_APP}`, exact: true }).check()
  await sync.click()
  await editor.getByText('WeChat may have created a draft. Check the draft box before trying again.', { exact: true }).waitFor()
  expect(wechat.requests.at(-1)).toMatchObject({ path: '/cgi-bin/draft/add', token: SECOND_APP })
  expect(await bodyImage.getAttribute('src')).toMatch(/^data:image\/png;base64,/)

  await accounts.click()
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await refresh.click({ trial: true })
  await expect.poll(async () => {
    const [bodyBox, previewBox] = await Promise.all([body.boundingBox(), preview.boundingBox()])
    return bodyBox !== null && previewBox !== null && previewBox.y > bodyBox.y + bodyBox.height
  }).toBe(true)
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  acknowledgeReloadConnectionLoss(errors, reloadWarnings)
  expect(errors.pageErrors).toEqual([])
  expect(errors.warnings).toEqual([])

  const chinese = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 880 } })
  await chinese.goto(scaffold.authenticatedUrl)
  await chinese.getByRole('button', { name: '插件', exact: true }).click()
  const card = chinese.locator('[data-plugin-package="@deepseek-ai/dsh-hongzhong"]')
  await card.getByRole('button', { name: '查看 公众号自动发文', exact: true }).waitFor()
  await card.getByText('预览工作区文章并同步到选定公众号的草稿箱。', { exact: true }).waitFor()
  await chinese.getByRole('button', { name: '公众号自动发文', exact: true }).click()
  const heading = chinese.getByRole('heading', { name: '公众号自动发文', exact: true })
  await heading.waitFor()
  await chinese.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => heading.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await chinese.setViewportSize({ width: 1280, height: 880 })
  const unregistered = join(scaffold.workspaceCwd, '新写作目录')
  await mkdir(unregistered)
  await chinese.getByRole('button', { name: '选择文件夹…', exact: true }).click()
  const picker = chinese.getByRole('dialog', { name: '选择工作区目录' })
  await picker.getByRole('button', { name: '编辑路径', exact: true }).click()
  const path = picker.getByRole('textbox', { name: '编辑路径', exact: true })
  await path.fill(unregistered)
  await path.press('Enter')
  await picker.getByRole('button', { name: '打开', exact: true }).click()
  await chinese.getByText('在对话里请 AI 写一篇文章。保存到工作区后，文章会显示在这里', { exact: true }).waitFor()
  expect(await chinese.locator('[data-composer-input]').first().isVisible()).toBe(true)
  expect(scaffold.ctx.workspaceRegistry.list().some(item => item.path === unregistered)).toBe(true)
})
