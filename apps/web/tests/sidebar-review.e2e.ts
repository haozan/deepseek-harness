/** Replay a Session with a file link and drive the review workflow through the composed Client. */

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { ARCHIVE_FOLDER, parseArchive } from '../../../packages/client/ui-sidebar-review/src/archive-format.ts'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

async function drag(page: Page, handle: Locator, destination: Locator): Promise<void> {
  const source = await handle.boundingBox()
  const target = await destination.boundingBox()
  if (source === null || target === null) throw new Error('Transcript rows are unavailable')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + 4, { steps: 14 })
  await page.mouse.up()
}

async function resizeSidebar(page: Page, width: number): Promise<void> {
  const panel = await page.locator('[data-sidebar-right-panel]').boundingBox()
  const grip = await page.locator('[data-side="rightbar"]').first().boundingBox()
  if (panel === null || grip === null) throw new Error('Sidebar resize handle is unavailable')
  const x = grip.x + grip.width / 2
  const y = grip.y + grip.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + panel.width - width, y, { steps: 10 })
  await page.mouse.up()
}

async function folderGeometry(button: Locator): Promise<{ ellipsized: boolean; fits: boolean }> {
  return await button.evaluate((element) => {
    const row = element.parentElement
    const label = element.querySelector('span')
    const count = row?.lastElementChild
    const control = row?.querySelector('button[aria-haspopup="menu"]')
    if (row === null || label === null || count == null || control == null) throw new Error('Folder geometry is unavailable')
    const rowBounds = row.getBoundingClientRect()
    const titleBounds = label.getBoundingClientRect()
    const countBounds = count.getBoundingClientRect()
    const controlBounds = control.getBoundingClientRect()
    return {
      ellipsized: label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis'
        && label.clientHeight <= Number.parseFloat(getComputedStyle(label).lineHeight),
      fits: titleBounds.right <= controlBounds.left && controlBounds.right <= countBounds.left
        && Math.abs(countBounds.right - rowBounds.right) <= 1 && controlBounds.width > 0,
    }
  })
}

it('files, reorders, edits, and exports a transcript that survives reload', async () => {
  const profile = { packages: [{
    dir: fileURLToPath(new URL('../../../packages/client/ui-sidebar-review/', import.meta.url)),
    enabled: true,
  }] }
  const scaffold = await launchWebScaffold({ profile })
  onTestFinished(() => scaffold.close())
  const seed = new URL('../../../snapshots/web/markdown-file-links/session.v3.jsonl', import.meta.url)
  await mkdir(join(scaffold.workspaceCwd, 'src'))
  await writeFile(join(scaffold.workspaceCwd, 'src/example.txt'), Array.from({ length: 180 }, (_, i) => `source line ${i + 1}\n`).join(''))
  await writeFile(join(scaffold.workspaceCwd, 'review.pdf'), pdfFixture(8))
  await writeFile(join(scaffold.workspaceCwd, 'review.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAGAAAABQCAIAAABpgOfCAAAAmElEQVR4nO3QMQ2AMAAAwZqoKATgib2SMIaDbqQ/XPICPjfmerVpHD+IBwgQIECAwgECBAgQoHCAAAECBCgcIECAAAEKBwgQIECAwgECBAgQoHCAAAECBCgcIECA/gW67kebAAECBAhQOECAAAECFA4QIECAAIUDBAgQIEDhAAECBAhQOECAAAECFA4QIECAAIUDBAgQoJN95RSBOzpM1cgAAAAASUVORK5CYII=', 'base64',
  ))
  const seeded = await seedSession(scaffold, await readFile(seed, 'utf8'), 'review-workbench-fixture')
  const originalWorkspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Review case')
  await originalWorkspace.attachSession(seeded)

  const browser = await chromium.launch({ channel: 'chromium' })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.addInitScript((sessionId) => {
    if (localStorage.getItem('dsh.sessions.current') === null) {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
    }
  }, seeded)
  const errors = watchConsole(page)
  let finishRecognition = (): void => { throw new Error('The recognition response gate is unavailable') }
  const recognitionGate = new Promise<void>((resolve) => { finishRecognition = resolve })
  let recognitionRequests = 0
  const fullCardText = 'Compare with the contract\n\nTransfer amount: 100'
  await page.route('**/api/directoryPicker/pick', async (route) => {
    const { rpcId } = route.request().postDataJSON() as { rpcId: string }
    await route.fulfill({ json: { type: 'server-response', rpcId, result: { ok: true, value: scaffold.workspaceCwd } } })
  })
  await page.route('**/api/documentReview/recognize', async (route) => {
    const { rpcId } = route.request().postDataJSON() as { rpcId: string }
    const request = ++recognitionRequests
    if (request === 2) await recognitionGate
    await route.fulfill({ json: { type: 'server-response', rpcId,
      result: { ok: true, value: request === 1 ? '' : request === 2 ? 'Transfer amount: 100' : 'Second screenshot text' } } })
  })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-review'))
  const selection = page.locator('[data-review-selection]')
  const frames = page.locator('[data-document-capture-frame]:visible')
  const frame = page.locator('[data-document-capture-frame][data-document-capture-active]:visible')
  const frameLink = frame.getByRole('button', { name: 'Go to review card' })
  let captures = 0
  await page.exposeFunction('testCaptureRegion', async (clip: { x: number; y: number; width: number; height: number }) => {
    captures++
    expect(await selection.isVisible()).toBe(false)
    expect(await frames.count()).toBe(0)
    return Array.from(await page.screenshot({ clip }))
  })
  let exported = ''
  await page.exposeFunction('testTranscriptExport', (text: string) => { exported = text })
  await page.addInitScript(() => {
    const bridge = globalThis as typeof globalThis & {
      testTranscriptExport(text: string): Promise<void>
      testCaptureRegion(clip: { x: number; y: number; width: number; height: number }): Promise<number[]>
    }
    Object.assign(globalThis, { dshDesktop: {
      protocolVersion: 1,
      fileActions: {
        save: async ({ url }: { url: string }) => {
          await bridge.testTranscriptExport(await (await fetch(url)).text())
          return { status: 'saved', path: '/test/transcript.html' }
        },
      },
      capturePageRegion: async (clip: { x: number; y: number; width: number; height: number }) =>
        new Uint8Array(await bridge.testCaptureRegion(clip)),
    } })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const link = page.getByRole('button', { name: 'src/example.txt:24–30', exact: true })
  await link.click()

  const column = page.locator('[data-rightbar-col]')
  const panes = column.locator('[data-dockkit-pane]')
  const split = column.locator('[data-dockkit-split-button]')
  const capture = page.getByRole('button', { name: 'Capture to review transcript', exact: true })
  const evidenceCapture = page.getByRole('button', { name: 'Capture to evidence directory', exact: true })
  await capture.waitFor()
  await evidenceCapture.waitFor()
  const captureActionsSnapshot = [await capture.ariaSnapshot(), await evidenceCapture.ariaSnapshot()].join('\n')
  await resizeSidebar(page, 310)
  await expect.poll(() => split.isEnabled()).toBe(false)
  await capture.click()
  await selection.waitFor()
  await page.keyboard.press('Escape')
  await selection.waitFor({ state: 'hidden' })
  expect(captures).toBe(0)
  await capture.click()
  await selection.waitFor()
  const source = page.locator('[data-textpreview-state]:visible')
  const address = await source.getAttribute('data-textpreview-url')
  const body = await source.locator('[data-textpreview-body]').boundingBox()
  if (body === null) throw new Error('Document body has no bounds')
  const x = Math.ceil(body.x) + 18
  const y = Math.ceil(body.y) + 32
  await page.mouse.move(x + 110, y + 70)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 5 })
  await page.mouse.up()

  const review = page.getByRole('region', { name: 'Review' })
  const exportButton = review.getByRole('button', { name: 'Export', exact: true })
  const exportMenu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Text and images', exact: true }) })
  const exportUsing = async (option: 'Text and images' | 'Text only'): Promise<void> => {
    await exportButton.click()
    await exportMenu.getByRole('menuitem', { name: option, exact: true }).click()
  }
  const card = review.getByRole('button', { name: 'Open example.txt' }).first()
  const cardRow = card.locator('xpath=ancestor::li[1]')
  const image = cardRow.locator('[data-review-screenshot]')
  await card.waitFor()
  const autoOCR = review.getByRole('switch', { name: 'Auto OCR', exact: true })
  const autoHint = page.getByRole('alert').filter({ hasText: /uses a vision model.*consumes tokens/u })
  expect(await autoOCR.getAttribute('aria-checked')).toBe('true')
  expect(await autoHint.count()).toBe(0)
  expect(await autoOCR.getAttribute('title')).toMatch(/vision model.*consumes tokens/u)
  await cardRow.getByText('No readable text found').waitFor()
  expect(recognitionRequests).toBe(1)
  await autoOCR.click()
  expect(await autoHint.count()).toBe(0)
  expect(captures).toBe(1)
  expect(await panes.count()).toBe(1)
  const showSource = review.getByRole('switch', { name: 'Show source', exact: true })
  const firstSource = cardRow.getByText('【example】', { exact: true })
  expect(await showSource.getAttribute('aria-checked')).toBe('false')
  expect(await firstSource.count()).toBe(0)
  await showSource.press('Space')
  expect(await showSource.getAttribute('aria-checked')).toBe('true')
  expect(await firstSource.isVisible()).toBe(true)
  expect(await image.isVisible()).toBe(true)
  const narrowText = cardRow.getByRole('textbox', { name: 'Card text' })
  expect(await narrowText.count()).toBe(0)
  await cardRow.getByRole('button', { name: 'Card text' }).click()
  await narrowText.fill('第一行\n' + 'Some longer source text to check wrapping in a narrow pane.\n'.repeat(9))
  expect(await narrowText.inputValue()).not.toContain('【example】')
  expect(await firstSource.evaluate(source => getComputedStyle(source).getPropertyValue('text-spacing-trim'))).toBe('trim-start')
  expect(await narrowText.evaluate((node) => {
    const review = node.closest('[data-review-panel]')?.getBoundingClientRect()
    const field = node.getBoundingClientRect()
    return review !== undefined && field.right <= review.right && node.scrollHeight <= node.clientHeight + 1
  })).toBe(true)
  await showSource.click()
  expect(await firstSource.count()).toBe(0)
  expect(await narrowText.inputValue()).toContain('第一行')
  await narrowText.fill('')
  await exportButton.press('Enter')
  await exportMenu.waitFor()
  const exportChoicesSnapshot = await exportMenu.ariaSnapshot()
  const exportBounds = await exportMenu.boundingBox()
  const viewportWidth = page.viewportSize()?.width
  if (exportBounds === null || viewportWidth === undefined) throw new Error('Export menu bounds are unavailable')
  expect(exportBounds.x).toBeGreaterThanOrEqual(0)
  expect(exportBounds.x + exportBounds.width).toBeLessThanOrEqual(viewportWidth)
  await page.keyboard.press('Escape')
  await exportMenu.waitFor({ state: 'hidden' })
  expect(await exportButton.evaluate(button => button === document.activeElement)).toBe(true)
  await expect.poll(() => image.evaluate((node) => {
    const img = node as HTMLImageElement
    return [img.naturalWidth, img.naturalHeight]
  })).toEqual([110, 70])

  const tools = cardRow.locator('[data-review-card-tools]')
  await page.mouse.move(0, 0)
  expect(await tools.evaluate(node => getComputedStyle(node).opacity)).toBe('0')
  await cardRow.hover()
  expect(await tools.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  const chat = page.locator('[data-conversation-session]:visible').last()
  const composer = chat.locator('[data-composer-input][contenteditable="true"]')
  const chatImage = chat.getByRole('img', { name: 'example.txt.png', exact: true })
  const removeChatImage = chat.getByRole('button', { name: /Remove.*example\.txt\.png/iu })
  await composer.fill('Existing conversation draft')
  await cardRow.hover()
  await cardRow.getByRole('button', { name: 'Discuss with AI' }).click()
  await chatImage.waitFor()
  expect(await composer.innerText()).toBe('Existing conversation draft')
  expect(await composer.evaluate(node => node === document.activeElement)).toBe(true)
  await removeChatImage.click()
  await cardRow.hover()
  await card.click()
  await capture.waitFor()
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(110, 0)
  expect((await frame.boundingBox())?.height).toBeCloseTo(70, 0)
  await frameLink.press('Enter')
  await expect.poll(() => review.locator('[data-review-highlighted]').getAttribute('data-review-entry')).toBe('clip:1')
  expect(await panes.count()).toBe(1)
  await card.press('Enter')
  await frameLink.waitFor()
  await resizeSidebar(page, 840)
  await expect.poll(() => split.isEnabled()).toBe(true)
  await capture.click()
  await selection.waitFor()
  const widerBody = await source.locator('[data-textpreview-body]').boundingBox()
  if (widerBody === null) throw new Error('Widened document body has no bounds')
  const widerX = Math.ceil(widerBody.x) + 18
  const widerY = Math.ceil(widerBody.y) + 32
  await page.mouse.move(widerX, widerY)
  await page.mouse.down()
  await page.mouse.move(widerX + 85, widerY + 52, { steps: 5 })
  await page.mouse.up()

  const rows = review.locator('[data-review-entry]')
  const ordered = () => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-review-entry')))
  await expect.poll(ordered).toEqual(['clip:1', 'clip:2'])
  expect(await panes.count()).toBe(2)
  expect(await panes.nth(0).locator('[data-review-capture]').isVisible()).toBe(true)
  expect(await panes.nth(1).getByRole('region', { name: 'Review' }).isVisible()).toBe(true)
  expect(await column.getByRole('tab', { name: /^Review transcript(?: |$)/u }).count()).toBe(1)
  expect(await source.getAttribute('data-textpreview-url')).toBe(address)
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(85, 0)
  const scrollport = source.locator('[data-textpreview-body]')
  const offset = () => scrollport.evaluate(node => node.scrollTop)
  await scrollport.evaluate((node) => { node.scrollTop = node.scrollHeight })
  const bottomOffset = await offset()
  await card.press('Enter')
  await expect.poll(offset).toBeLessThan(bottomOffset - 100)
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(110, 0)
  await rows.nth(1).getByRole('button', { name: 'Open example.txt' }).press('Enter')
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(85, 0)
  await link.click()
  await expect.poll(() => frames.count()).toBe(2)
  expect(await frame.count()).toBe(0)
  expect(await frames.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).borderTopColor)))
    .toEqual(['rgb(239, 68, 68)', 'rgb(239, 68, 68)'])
  for (const id of [1, 2]) {
    await frames.locator(`button[data-review-frame-id="${id}"] [data-edge="right"]`).click()
    await expect.poll(() => review.locator('[data-review-highlighted]').getAttribute('data-review-entry')).toBe(`clip:${id}`)
  }
  const grip = rows.nth(1).getByRole('button', { name: 'Drag to reorder or use arrow keys' })
  await page.mouse.move(0, 0)
  expect(await grip.locator('svg').evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  const idleGripColor = await grip.evaluate(node => getComputedStyle(node).color)
  await grip.hover()
  expect(await grip.evaluate(node => getComputedStyle(node).color)).not.toBe(idleGripColor)
  expect(await grip.evaluate(node => getComputedStyle(node).cursor)).toBe('grab')
  await drag(page, grip, rows.first())
  await expect.poll(ordered).toEqual(['clip:2', 'clip:1'])

  const tree = review.getByRole('navigation', { name: 'Folders' })
  const divider = review.getByRole('separator', { name: 'Resize folder tree' })
  const folder = (name: string) => tree.getByRole('button', { name, exact: true })
  const folderActions = (name: string) => folder(`Folder actions for ${name}`)
  const menu = page.getByRole('menu')
  const openFolderActions = async (name: string): Promise<void> => {
    await folder(name).hover()
    await folderActions(name).click()
    await menu.waitFor()
  }
  const newFolderIn = async (name: string): Promise<void> => {
    await openFolderActions(name)
    await menu.getByRole('menuitem', { name: 'New folder', exact: true }).click()
  }
  const folderOrder = () => tree.locator('[data-review-folder^="folder:"]').allInnerTexts()
  const switcher = review.getByRole('button', { name: 'Folders', exact: true })
  expect(await tree.isVisible()).toBe(false)
  expect(await divider.isVisible()).toBe(false)
  await switcher.click()
  await folder('Unfiled').click()
  await switcher.click()
  await folderActions('Review transcript').press('Enter')
  await menu.waitFor()
  const menuBounds = await menu.boundingBox()
  const viewport = page.viewportSize()
  if (menuBounds === null || viewport === null) throw new Error('Folder menu geometry is unavailable')
  expect(menuBounds.x).toBeGreaterThanOrEqual(0)
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width)
  expect(menuBounds.y).toBeGreaterThanOrEqual(0)
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height)
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  expect(await folderActions('Review transcript').evaluate(button => document.activeElement === button)).toBe(true)
  await openFolderActions('Review transcript')
  await folder('Unfiled').click({ position: { x: 10, y: 12 } })
  await menu.waitFor({ state: 'hidden' })
  await switcher.click()
  await newFolderIn('Review transcript')
  await tree.getByRole('textbox', { name: 'Folder name' }).fill('Payment')
  await folder('Save').click()
  const [root, unfiled, topLevel] = await Promise.all([folder('Review transcript').boundingBox(),
    folder('Unfiled').boundingBox(), folder('Payment').boundingBox()])
  if (root === null || unfiled === null || topLevel === null) throw new Error('Folder levels are unavailable')
  expect(root.x).toBeLessThan(unfiled.x)
  expect(unfiled.x).toBe(topLevel.x)
  expect(unfiled.y).toBeGreaterThan(topLevel.y)
  expect(await folder('Unfiled').locator('[data-icon="dsw-icon-inbox-outline-regular"]').count()).toBe(1)
  expect(await folderActions('Payment').isVisible()).toBe(true)
  expect(await tree.locator('[data-icon="dsw-icon-drag-handle-outline-regular"]').count()).toBe(0)
  const unfiledRow = folder('Unfiled').locator('..')
  expect(await unfiledRow.getByRole('button').count()).toBe(1)
  await folder('Unfiled').click()
  await expect.poll(ordered).toEqual(['clip:2', 'clip:1'])
  await review.getByRole('button', { name: 'Select cards' }).click()
  await review.getByRole('button', { name: 'Select all' }).click()
  await review.getByRole('combobox', { name: 'Move to' }).selectOption({ label: 'Payment' })
  await expect.poll(ordered).toEqual([])

  await column.locator('[data-sidebar-right-mode="fullscreen"]').click()
  await tree.waitFor()
  await expect.poll(async () => Number(await divider.getAttribute('aria-valuemax'))).toBeGreaterThan(320)
  const treeWidth = () => tree.evaluate(element => element.getBoundingClientRect().width)
  const beforeResize = await treeWidth()
  const dividerBox = await divider.boundingBox()
  if (dividerBox === null) throw new Error('Folder divider is unavailable')
  const gripX = dividerBox.x + dividerBox.width / 2
  const gripY = dividerBox.y + dividerBox.height / 2
  await page.mouse.move(gripX, gripY)
  await page.mouse.down()
  await page.mouse.move(gripX + 52, gripY, { steps: 8 })
  await page.mouse.up()
  await expect.poll(treeWidth).toBe(beforeResize + 52)
  await divider.press('ArrowLeft')
  await expect.poll(treeWidth).toBe(beforeResize + 36)
  const hideTree = review.getByRole('button', { name: 'Hide folder tree' })
  const toggleWidth = await hideTree.evaluate(node => node.getBoundingClientRect().width)
  await hideTree.click()
  await tree.waitFor({ state: 'hidden' })
  expect(await divider.isVisible()).toBe(false)
  const showTree = review.getByRole('button', { name: 'Show folder tree' })
  expect(await showTree.innerText()).toBe('')
  expect(await showTree.evaluate(node => node.getBoundingClientRect().width)).toBe(toggleWidth)
  await showTree.hover()
  await page.getByRole('tooltip').filter({ hasText: 'Show folder tree · Unfiled' }).waitFor()
  await showTree.press('Enter')
  await expect.poll(treeWidth).toBe(beforeResize + 36)
  await newFolderIn('Payment')
  await tree.getByRole('textbox', { name: 'Folder name' }).fill('Transfers')
  await folder('Save').click()
  await folderActions('Transfers').press('Enter')
  await menu.waitFor()
  await expect.poll(() => menu.getByRole('menuitem', { name: 'New folder', exact: true })
    .evaluate(item => item === document.activeElement)).toBe(true)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await tree.getByRole('textbox', { name: 'Folder name' }).fill('Bank')
  await folder('Save').click()
  const parent = await folder('Payment').boundingBox()
  const child = await folder('Bank').boundingBox()
  expect((child?.x ?? 0) - (parent?.x ?? 0)).toBeGreaterThan(0)
  await folder('Collapse Payment').click()
  expect(await folder('Bank').count()).toBe(0)
  await folder('Expand Payment').click()
  await newFolderIn('Payment')
  const longName = '证据材料编号ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789逐页核对记录及补充说明'
  await tree.getByRole('textbox', { name: 'Folder name' }).fill(longName)
  await folder('Save').click()
  const longFolder = folder(longName)
  const actionsOpacity = () => folderActions(longName).evaluate((button) => {
    const anchor = button.parentElement
    if (anchor === null) throw new Error('Folder actions are unavailable')
    return getComputedStyle(anchor).opacity
  })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
    await page.mouse.move(0, 0)
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    expect(await actionsOpacity()).toBe('0')
    const selectedBackground = await longFolder.locator('..').evaluate(row => getComputedStyle(row).backgroundColor)
    expect(selectedBackground).not.toBe('rgba(0, 0, 0, 0)')
    await longFolder.hover()
    expect(await longFolder.locator('..').evaluate(row => getComputedStyle(row).backgroundColor)).toBe(selectedBackground)
    expect(await longFolder.evaluate(button => getComputedStyle(button).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    expect(await actionsOpacity()).toBe('1')
    expect(await folderGeometry(longFolder)).toEqual({ ellipsized: true, fits: true })
  }
  await page.getByRole('tooltip').getByText(longName, { exact: true }).waitFor()
  await page.setViewportSize({ width: 1160, height: 1000 })
  await expect.poll(() => folderGeometry(longFolder)).toEqual({ ellipsized: true, fits: true })
  await page.setViewportSize({ width: 1680, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light' })
  await openFolderActions(longName)
  expect(await menu.getByRole('menuitem', { name: 'Move down' }).isEnabled()).toBe(false)
  await menu.getByRole('menuitem', { name: 'Move up' }).click()
  await expect.poll(folderOrder).toEqual(['Payment', longName, 'Bank'])
  await newFolderIn('Review transcript')
  await tree.getByRole('textbox', { name: 'Folder name' }).fill('Contract')
  await folder('Save').click()
  await drag(page, folder('Contract'), folder('Bank'))
  expect(await folderOrder()).toEqual(['Payment', longName, 'Bank', 'Contract'])
  await drag(page, folder('Contract'), folder('Payment'))
  const sortedFolders = ['Contract', 'Payment', longName, 'Bank']
  await expect.poll(folderOrder).toEqual(sortedFolders)
  expect(await tree.locator('[data-review-folder]').last().getAttribute('data-review-folder')).toBe('unfiled')
  await folder('Payment').click()
  await review.getByRole('button', { name: 'Select all' }).click()
  await drag(page, rows.first().getByRole('button', { name: 'Drag to reorder or use arrow keys' }), folder('Bank'))
  await expect.poll(ordered).toEqual([])
  await folder('Bank').click()
  await expect.poll(ordered).toEqual(['clip:2', 'clip:1'])
  await review.getByRole('button', { name: 'Done' }).click()
  const bankText = rows.first().getByRole('textbox', { name: 'Card text' })
  await rows.first().getByRole('button', { name: 'Card text' }).click()
  await bankText.fill('Compare')
  await rows.first().getByRole('button', { name: 'Recognize text', exact: true }).click()
  await expect.poll(() => recognitionRequests, { timeout: 5_000 }).toBe(2)
  await bankText.fill('Compare with the contract')
  finishRecognition()
  await expect.poll(() => bankText.inputValue()).toBe(fullCardText)
  const recognized = rows.first().getByRole('button', { name: 'Text recognized', exact: true })
  expect(await recognized.isVisible()).toBe(true)
  expect(await recognized.isEnabled()).toBe(false)
  await recognized.press('Enter')
  expect(recognitionRequests).toBe(2)
  const recognizeAll = review.getByRole('button', { name: 'Recognize all', exact: true })
  const allRecognized = review.getByRole('button', { name: 'All recognized', exact: true })
  const secondBankText = rows.nth(1).getByRole('textbox', { name: 'Card text' })
  await recognizeAll.click()
  await expect.poll(() => secondBankText.inputValue()).toBe('Second screenshot text')
  expect(recognitionRequests).toBe(3)
  expect(await allRecognized.isEnabled()).toBe(false)
  await secondBankText.fill('')
  expect(await recognizeAll.isEnabled()).toBe(true)
  const secondBankOCR = rows.nth(1).getByRole('button', { name: 'Recognize text', exact: true })
  expect(await secondBankOCR.isEnabled()).toBe(true)
  const clearedRecognitionSnapshot = [await secondBankOCR.ariaSnapshot(), await recognizeAll.ariaSnapshot()].join('\n')
  await recognizeAll.click()
  await expect.poll(() => secondBankText.inputValue()).toBe('Second screenshot text')
  expect(recognitionRequests).toBe(4)
  expect(await allRecognized.isEnabled()).toBe(false)
  await rows.first().getByRole('button', { name: 'Discuss with AI' }).press('Enter')
  await chatImage.waitFor()
  await expect.poll(() => composer.locator(':scope > p').allTextContents()).toEqual([
    'Existing conversation draft', ...fullCardText.split('\n'),
  ])
  await expect.poll(() => page.locator('[data-sidebar-right-panel]').getAttribute('data-sidebar-right-panel')).toBe('push')
  await removeChatImage.click()
  await composer.fill('')

  await column.locator('[data-sidebar-right-mode="fullscreen"]').click()
  await capture.click()
  await selection.waitFor()
  const fullBody = await source.locator('[data-textpreview-body]').boundingBox()
  if (fullBody === null) throw new Error('Document body has no bounds in fullscreen')
  await page.mouse.move(fullBody.x + 18, fullBody.y + 32)
  await page.mouse.down()
  await page.mouse.move(fullBody.x + 88, fullBody.y + 82, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => unfiledRow.innerText()).toContain('1')
  expect(await ordered()).toEqual(['clip:2', 'clip:1'])
  await exportUsing('Text and images')
  await expect.poll(() => exported).toContain('Compare with the contract')
  expect(exported).toContain(`<p class="text">${fullCardText}</p>`)
  expect(exported).not.toMatch(/example\.txt|【example】/u)
  expect(exported.match(/alt="Screenshot"/gu)).toHaveLength(3)
  await showSource.click()
  expect(await bankText.inputValue()).toBe(fullCardText)
  expect(await rows.first().getByText('【example】', { exact: true }).isVisible()).toBe(true)
  const sourceOnSnapshot = [await showSource.ariaSnapshot(), await rows.first().getByText('【example】', { exact: true }).ariaSnapshot()].join('\n')
  exported = ''
  await exportUsing('Text only')
  await expect.poll(() => exported).toContain(`<p class="text">【example】 ${fullCardText}</p>`)
  expect(exported).toContain('<p class="text">【example】</p>')
  expect(exported).not.toContain('example.txt')
  expect(exported).toContain('<h2>Contract</h2>')
  expect(exported).toContain('<h2>Payment</h2>')
  expect(exported).toContain(`<h3>${longName}</h3>`)
  expect(exported).toContain('<h3>Bank</h3>')
  expect(exported.indexOf('<h2>Contract</h2>')).toBeLessThan(exported.indexOf('<h2>Payment</h2>'))
  expect(exported.indexOf(`<h3>${longName}</h3>`)).toBeLessThan(exported.indexOf('<h3>Bank</h3>'))
  expect(exported.indexOf('<h2>Unfiled</h2>')).toBeGreaterThan(exported.indexOf('<h3>Bank</h3>'))
  expect(exported).toContain('Transfer amount: 100')
  expect(exported.match(/data:image\/png;base64,/gu)).toHaveLength(1)
  expect(exported).toContain(`<article><p class="text">【example】 ${fullCardText}</p></article>`)
  const expectedOrder = await ordered()
  await folder('Review transcript').click()
  await expect.poll(() => review.getByRole('heading').allInnerTexts())
    .toEqual(['Review transcript', 'Contract', 'Payment', longName, 'Bank', 'Unfiled'])
  const paymentHeading = review.getByRole('heading', { name: 'Payment', level: 2, exact: true })
  const bankHeading = review.getByRole('heading', { name: 'Bank', level: 3, exact: true })
  const bankChapter = bankHeading.locator('..')
  const unfiledChapter = review.getByRole('heading', { name: 'Unfiled', level: 2, exact: true }).locator('..')
  const paymentToggle = paymentHeading.getByRole('button')
  const bankToggle = bankChapter.getByRole('heading').getByRole('button')
  const [paymentBounds, bankBounds] = await Promise.all([paymentHeading.boundingBox(), bankHeading.boundingBox()])
  if (paymentBounds === null || bankBounds === null) throw new Error('Outline headings are unavailable')
  expect(bankBounds.x).toBeGreaterThan(paymentBounds.x)
  const bankHasGuide = await bankChapter.evaluate((node) => {
    const branch = node.parentElement
    return branch?.hasAttribute('data-review-branch') === true
      && Number.parseFloat(getComputedStyle(branch).borderInlineStartWidth) > 0
  })
  expect(bankHasGuide).toBe(true)
  await paymentToggle.click()
  expect(await paymentToggle.getAttribute('aria-expanded')).toBe('false')
  expect(await bankChapter.count()).toBe(0)
  expect(await review.getByRole('heading', { name: longName }).count()).toBe(0)
  expect(await ordered()).toEqual(['clip:3'])
  const completeExport = exported
  exported = ''
  await exportUsing('Text only')
  await expect.poll(() => exported).toBe(completeExport)
  await showSource.click()
  await paymentToggle.press('Enter')
  expect(await paymentToggle.getAttribute('aria-expanded')).toBe('true')
  expect(await ordered()).toEqual(['clip:2', 'clip:1', 'clip:3'])
  await bankToggle.press('Space')
  expect(await ordered()).toEqual(['clip:3'])
  await paymentToggle.click()
  await paymentToggle.click()
  expect(await bankToggle.getAttribute('aria-expanded')).toBe('false')
  await bankToggle.click()
  expect(await ordered()).toEqual(['clip:2', 'clip:1', 'clip:3'])

  const firstBankCard = bankChapter.locator('[data-review-entry="clip:2"]')
  expect(await firstBankCard.getByText('example.txt', { exact: true }).count()).toBe(0)
  const editCard = firstBankCard.getByRole('textbox', { name: 'Card text' })
  const textBox = await editCard.boundingBox()
  if (textBox === null) throw new Error('Transcript card geometry is unavailable')
  expect(textBox.x).toBeGreaterThan(bankBounds.x)
  expect(await firstBankCard.locator('[data-review-screenshot]').count()).toBe(0)
  expect(await editCard.inputValue()).toBe(fullCardText)
  const outlineNode = firstBankCard.locator('div').first()
  expect(await outlineNode.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  const outlineSnapshot = `Bank outline: nested heading, guide ${bankHasGuide ? 'visible' : 'hidden'}, editable text in place of screenshot`
  const colorButton = firstBankCard.getByRole('button', { name: 'Change color' })
  const palette = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'No color' }) })
  await colorButton.press('Enter')
  await palette.waitFor()
  const paletteSnapshot = await palette.ariaSnapshot()
  expect(await palette.getByRole('menuitem').count()).toBe(6)
  await palette.getByRole('menuitem', { name: 'Yellow', exact: true }).click()
  await expect.poll(() => outlineNode.getAttribute('data-color')).toBe('yellow')
  const editor = editCard.locator('..')
  const editorBorder = () => editor.evaluate((node) => {
    const ring = getComputedStyle(node, '::before')
    const mark = getComputedStyle(node, '::after')
    return {
      left: mark.backgroundColor, top: ring.borderTopColor, width: mark.inlineSize,
      markRadius: mark.borderRadius, ringRadius: ring.borderRadius,
    }
  })
  expect(await outlineNode.evaluate(node => getComputedStyle(node).boxShadow)).toBe('none')
  const colorMark = await editorBorder()
  expect(colorMark).toEqual({ left: 'rgb(245, 158, 11)', top: 'rgba(0, 0, 0, 0)', width: '2px', markRadius: '0px', ringRadius: '0px' })
  await editCard.click()
  const focusedBorder = await editorBorder()
  expect(focusedBorder.left).toBe(colorMark.left)
  expect(focusedBorder.markRadius).toBe('0px')
  expect(focusedBorder.ringRadius).toBe('0px')
  expect(focusedBorder.top).not.toBe(colorMark.top)
  expect(focusedBorder.top).not.toBe(colorMark.left)
  expect(await unfiledChapter.locator('[data-review-entry]').count()).toBe(1)
  const firstBankGrip = firstBankCard.getByRole('button', { name: 'Drag to reorder or use arrow keys' })
  await drag(page, firstBankGrip, unfiledChapter.locator('[data-review-entry]'))
  expect(await ordered()).toEqual(['clip:2', 'clip:1', 'clip:3'])
  await firstBankGrip.press('ArrowDown')
  await expect.poll(ordered).toEqual(['clip:1', 'clip:2', 'clip:3'])
  await firstBankGrip.press('ArrowUp')
  await expect.poll(ordered).toEqual(['clip:2', 'clip:1', 'clip:3'])

  await firstBankCard.getByRole('button', { name: 'Open example.txt' }).press('Enter')
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(85, 0)
  await bankToggle.click()
  await paymentToggle.click()
  expect(await ordered()).toEqual(['clip:3'])
  const interior = await frame.boundingBox()
  if (interior === null) throw new Error('The source capture frame is unavailable')
  await page.mouse.move(interior.x + 12, interior.y + interior.height / 2)
  await page.mouse.down()
  await page.mouse.move(interior.x + 43, interior.y + interior.height / 2, { steps: 7 })
  await page.mouse.up()
  const selectedText = await page.evaluate(() => window.getSelection()?.toString())
  expect(selectedText).toMatch(/\S/u)
  await page.evaluate(() => {
    window.addEventListener('copy', (event) => {
      document.documentElement.dataset.testCopiedCaptureText = window.getSelection()?.toString()
      event.preventDefault()
    }, { once: true })
  })
  await page.keyboard.press('ControlOrMeta+c')
  await expect.poll(() => page.locator('html').getAttribute('data-test-copied-capture-text')).toBe(selectedText)
  expect(await paymentToggle.getAttribute('aria-expanded')).toBe('false')
  await frameLink.locator('[data-edge="right"]').click()
  await expect.poll(() => firstBankCard.getAttribute('data-review-highlighted')).toBe('true')
  const returnHighlight = await outlineNode.evaluate((node) => {
    const style = getComputedStyle(node)
    const canvas = new OffscreenCanvas(1, 1).getContext('2d')
    if (canvas === null) throw new Error('Cannot sample the card highlight')
    canvas.fillStyle = style.backgroundColor
    canvas.fillRect(0, 0, 1, 1)
    const [red = 0, green = 0, blue = 0, alpha = 0] = canvas.getImageData(0, 0, 1, 1).data
    return { paleRed: red > green && red > blue && alpha > 0 && alpha < 80 }
  })
  expect(returnHighlight.paleRed).toBe(true)
  expect((await editorBorder()).left).toBe(colorMark.left)
  expect(await paymentToggle.getAttribute('aria-expanded')).toBe('true')
  expect(await bankToggle.getAttribute('aria-expanded')).toBe('true')
  expect(await firstBankCard.evaluate(node => document.activeElement === node)).toBe(true)
  const frameReturn = `Frame return expanded both chapters and highlighted ${await firstBankCard.getAttribute('data-review-entry')}`
  await expect.poll(() => firstBankCard.getAttribute('data-review-highlighted'), { timeout: 5_000 }).toBeNull()
  const transcriptSnapshot = await review.ariaSnapshot()

  await page.reload()
  await link.waitFor()
  const reviewTab = column.locator('[data-dockkit-tab]').filter({ hasText: 'Review transcript' })
  await reviewTab.click()
  expect(await autoOCR.getAttribute('aria-checked')).toBe('false')
  await expect.poll(folderOrder).toEqual(sortedFolders)
  await folder('Bank').click()
  await expect.poll(ordered).toEqual(expectedOrder)
  expect(await rows.first().locator('[data-review-screenshot]').count()).toBe(0)
  expect(await rows.first().locator('div').first().getAttribute('data-color')).toBe('yellow')
  expect(await rows.first().getByRole('textbox', { name: 'Card text' }).inputValue()).toBe(fullCardText)
  expect(await recognized.isEnabled()).toBe(false)
  expect(await allRecognized.isEnabled()).toBe(false)
  const reviewSnapshot = await review.ariaSnapshot()
  const tabCount = await column.locator('[data-dockkit-tab]').count()
  await card.press('Enter')
  expect(await source.getAttribute('data-textpreview-url')).toBe(address)
  await frame.waitFor()
  expect((await frame.boundingBox())?.width).toBeCloseTo(85, 0)
  expect(await review.isVisible()).toBe(true)
  expect(await column.locator('[data-dockkit-tab]').count()).toBe(tabCount)

  const requestDelete = async (): Promise<void> => {
    await openFolderActions('Payment')
    await menu.getByRole('menuitem', { name: 'Delete folder', exact: true }).click()
  }
  await requestDelete()
  const confirm = page.getByRole('dialog', { name: 'Delete folder?' })
  const cancel = confirm.getByRole('button', { name: 'Cancel', exact: true })
  await expect.poll(() => cancel.evaluate(button => button === document.activeElement)).toBe(true)
  expect(await confirm.innerText()).toContain('Their cards will move to Unfiled')
  const confirmSnapshot = await confirm.ariaSnapshot()
  await cancel.click()
  await confirm.waitFor({ state: 'hidden' })
  expect(await folderOrder()).toEqual(sortedFolders)

  await requestDelete()
  await confirm.getByRole('button', { name: 'Delete folder', exact: true }).click()
  await confirm.waitFor({ state: 'hidden' })
  await expect.poll(folderOrder).toEqual(['Contract'])
  await expect.poll(ordered).toEqual(['clip:3', 'clip:2', 'clip:1'])
  expect(await folder('Unfiled').getAttribute('aria-current')).toBe('true')
  await page.reload()
  await link.waitFor()
  await reviewTab.click()
  await folder('Unfiled').click()
  await expect.poll(folderOrder).toEqual(['Contract'])
  await expect.poll(ordered).toEqual(['clip:3', 'clip:2', 'clip:1'])
  expect(await rows.nth(1).locator('[data-review-screenshot]').count()).toBe(0)
  expect(await rows.nth(1).getByRole('textbox', { name: 'Card text' }).inputValue()).toBe(fullCardText)

  await rows.nth(1).getByRole('button', { name: 'Open example.txt' }).press('Enter')
  const navigatorToggle = source.locator('[data-files-navigator-toggle]')
  if (await navigatorToggle.getAttribute('aria-expanded') !== 'true') await navigatorToggle.click()
  await source.getByRole('button', { name: 'review.pdf', exact: true }).click()
  const pdfPort = source.locator('[data-document-zoom-scrollport]')
  const pdfPage = source.locator('[data-pdf-page="2"] canvas')
  await pdfPort.waitFor()
  await page.setViewportSize({ width: 1680, height: 640 })
  await pdfPort.evaluate((node) => { node.scrollTop = node.scrollHeight })
  await pdfPage.waitFor()
  await pdfPort.evaluate((node) => { node.scrollTop = node.scrollHeight })
  const captureSurface = async (surface: Locator, action = capture) => {
    await action.click()
    await selection.waitFor()
    const bounds = await surface.boundingBox()
    if (bounds === null) throw new Error('Capture surface is unavailable')
    await page.mouse.move(Math.round(bounds.x + bounds.width / 4), Math.round(bounds.y + bounds.height / 4))
    await page.mouse.down()
    await page.mouse.move(Math.round(bounds.x + bounds.width / 2), Math.round(bounds.y + bounds.height / 2), { steps: 5 })
    await page.mouse.up()
    return bounds
  }
  const pdfBounds = await captureSurface(pdfPage)
  const pdfCard = review.getByRole('button', { name: 'Open review.pdf' })
  await pdfCard.waitFor()
  await frame.waitFor()
  const surfaceCoordinates = async (surface: Locator): Promise<number[]> => {
    const [pageBounds, frameBounds] = await Promise.all([surface.boundingBox(), frame.boundingBox()])
    if (pageBounds === null || frameBounds === null) return []
    return [(frameBounds.x - pageBounds.x) / pageBounds.width, (frameBounds.y - pageBounds.y) / pageBounds.height,
      frameBounds.width / pageBounds.width, frameBounds.height / pageBounds.height].map(value => Math.round(value * 100))
  }
  const pageCoordinates = () => surfaceCoordinates(pdfPage)
  await expect.poll(pageCoordinates).toEqual([25, 25, 25, 25])
  const beforeZoom = (await pdfPage.boundingBox())!.width
  await pdfPort.dispatchEvent('wheel', { ctrlKey: true, deltaY: -40, clientX: pdfBounds.x + 60, clientY: pdfBounds.y + 60 })
  await expect.poll(async () => (await pdfPage.boundingBox())?.width).toBeGreaterThan(beforeZoom)
  await expect.poll(pageCoordinates).toEqual([25, 25, 25, 25])
  await pdfCard.press('Enter')
  await expect.poll(pageCoordinates).toEqual([25, 25, 25, 25])

  const pdfSnapshot = `PDF page 2 capture bounds (%): ${(await pageCoordinates()).join(', ')}`

  if (await navigatorToggle.getAttribute('aria-expanded') !== 'true') await navigatorToggle.click()
  await source.getByRole('button', { name: 'review.png', exact: true }).click()
  const sourceImage = source.locator('[data-image-preview] img:visible')
  await sourceImage.waitFor()
  await captureSurface(sourceImage)
  const imageCard = review.getByRole('button', { name: 'Open review.png' })
  await imageCard.waitFor()
  await imageCard.press('Enter')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
    await expect.poll(async () => {
      const coordinates = await surfaceCoordinates(sourceImage)
      return coordinates.length === 4 && coordinates.every(value => Math.abs(value - 25) <= 2)
    }).toBe(true)
    expect(await frame.evaluate((node) => {
      const style = getComputedStyle(node)
      return [style.borderTopWidth, style.borderTopColor]
    })).toEqual(['1px', 'rgb(239, 68, 68)'])
  }

  const olderImageRow = imageCard.locator('xpath=ancestor::li[1]').first()
  await captureSurface(sourceImage)
  await expect.poll(() => frames.count()).toBe(2)
  await frameLink.locator('[data-edge="right"]').click()
  const overlap = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Screenshot 1', exact: true }) })
  await overlap.waitFor()
  const overlapLabels = await overlap.getByRole('menuitem').allTextContents()
  expect(overlapLabels).toEqual(['Screenshot 1', 'Screenshot 2'])
  await overlap.getByRole('menuitem', { name: 'Screenshot 1', exact: true }).click()
  await expect.poll(() => olderImageRow.getAttribute('data-review-highlighted')).toBe('true')
  await autoOCR.click()
  expect(await autoOCR.getAttribute('aria-checked')).toBe('true')
  await autoHint.waitFor()
  const autoOnSnapshot = [await autoOCR.ariaSnapshot(), await autoHint.ariaSnapshot()].join('\n')
  await autoHint.waitFor({ state: 'hidden' })
  expect(recognitionRequests).toBe(4)
  await captureSurface(sourceImage)
  const newCard = rows.filter({ has: page.getByRole('button', { name: 'Open review.png', exact: true }) }).last()
  const autoText = newCard.getByRole('textbox', { name: 'Card text', exact: true })
  await expect.poll(() => autoText.inputValue()).toBe('Second screenshot text')
  expect(recognitionRequests).toBe(5)
  expect(await newCard.locator('[data-review-screenshot]').count()).toBe(0)
  const autoCardSnapshot = await autoText.ariaSnapshot()
  const reviewOrderBeforeEvidence = await ordered()
  const beforeEvidence = captures
  await page.route('**/api/documentReview/commitArchive', async (route) => {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const receipt: unknown = await response.json()
    expect(receipt).toMatchObject({ result: { ok: true, value: true } })
    await route.abort()
  }, { times: 1 })
  await captureSurface(sourceImage, evidenceCapture)
  await page.getByRole('button', { name: 'Retry saving capture', exact: true }).click()
  const evidence = page.getByRole('region', { name: 'Evidence directory' })
  const evidenceItem = evidence.getByRole('button', { name: 'Open review.png', exact: true })
  await evidenceItem.waitFor()
  expect(await evidenceItem.count()).toBe(1)
  expect(captures).toBe(beforeEvidence + 1)
  await expect.poll(() => evidenceItem.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  await expect.poll(() => frames.count()).toBe(4)
  const evidenceSnapshot = await evidence.ariaSnapshot()
  await evidenceItem.click()
  await sourceImage.waitFor()
  const evidenceFrame = page.getByRole('button', { name: 'Go to evidence capture', exact: true })
  await evidenceFrame.press('Enter')
  await expect.poll(() => evidenceItem.evaluate(item => item === document.activeElement)).toBe(true)
  await reviewTab.click()
  await expect.poll(ordered).toEqual(reviewOrderBeforeEvidence)
  expect(recognitionRequests).toBe(5)
  const shortcuts = page.locator('[data-review-shortcuts]')
  const docked = page.locator('[data-sidebar-right-panel="push"][data-sidebar-right-open]')
  const fullscreen = page.locator('[data-sidebar-right-panel="fullscreen"]')
  const closeFullscreen = fullscreen.getByRole('button', { name: 'Exit fullscreen', exact: true })
  if (await closeFullscreen.isVisible()) {
    await closeFullscreen.click()
    await fullscreen.waitFor({ state: 'hidden' })
  }
  const shortcutsSnapshot = await shortcuts.ariaSnapshot()
  for (const [action, target] of [['Open review transcript', 'Review transcript'], ['Open evidence directory', 'Evidence directory']] as const) {
    await shortcuts.getByRole('button', { name: action, exact: true }).click({ timeout: 5000 })
    await docked.waitFor()
    expect(await fullscreen.isVisible()).toBe(false)
    expect(await shortcuts.isVisible()).toBe(true)
    expect(await panes.count()).toBe(2)
    const filesPane = panes.filter({ has: page.locator('[data-files-content]:visible') })
    const companion = panes.filter({ has: page.getByRole('tab', { name: /^Review transcript(?: |$)/u }) })
    await filesPane.waitFor({ timeout: 5000 })
    const [filesBounds, companionBounds] = await Promise.all([filesPane.boundingBox(), companion.boundingBox()])
    if (filesBounds === null || companionBounds === null) throw new Error('Review workspace panes are unavailable')
    expect(filesBounds.x).toBeLessThan(companionBounds.x)
    expect(await filesPane.getByRole('button', { name: 'Review', exact: true }).count()).toBe(0)
    expect(await companion.getByRole('tab', { name: /^Review transcript(?: |$)/u }).count()).toBe(1)
    expect(await companion.getByRole('tab', { name: /^Evidence directory(?: |$)/u }).count()).toBe(1)
    expect(await companion.getByRole('tab', { selected: true }).innerText()).toBe(target)
    await docked.getByRole('button', { name: 'Fullscreen', exact: true }).click()
    await fullscreen.waitFor()
    await closeFullscreen.click()
    await docked.waitFor()
  }

  const useTranscript = shortcuts.getByRole('button', { name: 'Use the transcript with AI', exact: true })
  await composer.fill('Existing question')
  await useTranscript.press('Enter')
  await expect.poll(() => composer.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await composer.innerText()).toBe('Existing question')
  expect(await chat.getByRole('img', { name: /^Screenshot \d+\.png$/u }).count()).toBe(0)
  expect(recognitionRequests).toBe(5)

  const selectedSession = page.locator('[data-conversation-session]:visible').first()
  const currentSessionId = () => selectedSession.getAttribute('data-conversation-session')
  const launch = page.getByRole('button', { name: 'Review workbench', exact: true })
  const launcher = page.locator('[data-review-launcher]')
  const start = launcher.getByRole('region', { name: 'Start a review from a workspace', exact: true })
  const continueReview = launcher.locator('summary').filter({ hasText: /^Continue an existing review$/u })
  const noSavedReviews = launcher.getByText('Save a transcript or evidence to continue a review here.', { exact: true })
  const associate = start.locator('button[title]').filter({ hasText: scaffold.workspaceCwd })
  const openReview = async (chooseFolder: boolean): Promise<SessionId> => {
    await launch.click()
    await launcher.waitFor()
    const pick = start.getByRole('button', { name: 'Choose folder…', exact: true })
    await pick.waitFor()
    expect(await shortcuts.count()).toBe(0)
    if (chooseFolder) {
      await pick.click()
    } else {
      await associate.click()
    }
    await shortcuts.waitFor()
    expect(await page.locator('[data-composer-seat]').locator('[data-review-shortcuts]').count()).toBe(1)
    const id = await currentSessionId()
    if (id === null) throw new Error('The review conversation has no Session id')
    return SessionId(id)
  }
  const firstWorkbench = await openReview(true)
  expect(firstWorkbench).toMatch(/^review-workbench-/u)
  const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(scaffold.workspaceCwd)
  if (workspace === undefined) throw new Error('The associated workspace is missing')
  const workspaceRow = page.locator('[role="treeitem"][aria-expanded]')
    .filter({ has: page.getByText(workspace.title, { exact: true }) })
  await workspaceRow.hover()
  await page.getByRole('button', { name: `New session in ${workspace.title}`, exact: true }).click()
  await expect.poll(currentSessionId).not.toBe(firstWorkbench)
  await expect.poll(currentSessionId).toMatch(/^review-workbench-/u)
  const rowWorkbench = await currentSessionId()
  await shortcuts.waitFor()

  const newSession = page.getByRole('button', { name: 'New session', exact: true }).last()
  await newSession.click()
  await expect.poll(currentSessionId).not.toBe(rowWorkbench)
  await expect.poll(currentSessionId).toMatch(/^review-workbench-/u)
  await shortcuts.waitFor()

  await launch.click()
  await launcher.waitFor()
  await newSession.click()
  await expect.poll(currentSessionId).toMatch(/^(?!review-workbench-).+/u)
  expect(await shortcuts.count()).toBe(0)
  const secondWorkbench = await openReview(false)
  expect(secondWorkbench).toMatch(/^review-workbench-/u)
  expect(secondWorkbench).not.toBe(firstWorkbench)
  await scaffold.ctx.workspaceRegistry.archiveSession(seeded)
  await launch.click()
  await launcher.waitFor()
  await noSavedReviews.waitFor()
  expect(await continueReview.count()).toBe(0)

  const samplePng = await readFile(join(scaffold.workspaceCwd, 'review.png'), 'base64')
  await page.evaluate(async ({ first, second, base64 }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dsh-document-review', 2)
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(new Error('Could not open the review database', { cause: request.error })) }
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('clips', 'readwrite')
        const clips = tx.objectStore('clips')
        const png = new Blob([Uint8Array.from(atob(base64), byte => byte.charCodeAt(0))], { type: 'image/png' })
        const add = (sessionId: string, destination?: 'evidence'): void => {
          clips.add({ sessionId, png, fileName: 'review.pdf',
            resourceAddress: `dsh-resource://file/session/${sessionId}/review.pdf`,
            ...(destination === undefined ? {} : { destination }) })
        }
        add(first)
        add(second, 'evidence')
        tx.oncomplete = () => { resolve() }
        tx.onabort = () => { reject(new Error('Could not seed the saved review captures', { cause: tx.error })) }
      })
    } finally { db.close() }
  }, { first: firstWorkbench, second: secondWorkbench, base64: samplePng })

  await newSession.click()
  await expect.poll(currentSessionId).toMatch(/^(?!review-workbench-).+/u)
  await launch.click()
  await continueReview.click()
  const groups = launcher.locator('[data-review-workspace]')
  const firstReview = launcher.locator(`[data-review-session="${firstWorkbench}"]`)
  const secondReview = launcher.locator(`[data-review-session="${secondWorkbench}"]`)
  await secondReview.waitFor()
  expect(await groups.count()).toBe(1)
  expect(await groups.locator('[data-review-session]').count()).toBe(2)
  expect(await secondReview.innerText()).toContain(workspace.title)
  expect(await firstReview.isVisible()).toBe(false)
  await launcher.getByText('Other review records', { exact: true }).click()
  await firstReview.click()
  await expect.poll(currentSessionId).toBe(firstWorkbench)
  await shortcuts.waitFor()
  await launch.click()
  await continueReview.click()
  await secondReview.waitFor()
  await scaffold.ctx.workspaceRegistry.archiveSession(secondWorkbench)
  await secondReview.waitFor({ state: 'detached', timeout: 5000 })
  expect(await firstReview.isVisible()).toBe(true)
  await scaffold.ctx.workspaceRegistry.unarchiveSession(secondWorkbench)
  await secondReview.waitFor()

  expect(await scaffold.ctx.workspaceRegistry.delete(workspace.id)).toBe(true)
  await associate.waitFor({ state: 'detached', timeout: 5000 })
  await continueReview.waitFor({ state: 'detached', timeout: 5000 })
  await noSavedReviews.waitFor()
  expect(await scaffold.ctx.sessionPersistence.stat(firstWorkbench)).toBeDefined()
  expect(await scaffold.ctx.sessionPersistence.stat(secondWorkbench)).toBeDefined()

  const portable = parseArchive(await readFile(join(scaffold.workspaceCwd, ARCHIVE_FOLDER, seeded, 'review.json'), 'utf8'))
  expect(portable.clips.some(clip => clip.source === 'src/example.txt'
    && clip.location !== undefined && clip.sourceDigest !== undefined)).toBe(true)
  expect(portable.clips.filter(clip => clip.destination === 'evidence')).toHaveLength(1)
  const migrated = parseArchive(await readFile(join(scaffold.workspaceCwd, ARCHIVE_FOLDER, secondWorkbench, 'review.json'), 'utf8'))
  expect(migrated.clips).toHaveLength(1)
  expect(migrated.clips[0]?.destination).toBe('evidence')
  const fresh = await launchWebScaffold({ profile })
  onTestFinished(() => fresh.close())
  await Promise.all(['src', 'review.pdf', 'review.png', ARCHIVE_FOLDER].map(name =>
    cp(join(scaffold.workspaceCwd, name), join(fresh.workspaceCwd, name), { recursive: true })))
  const moved = await newEnglishPage(browser)
  await moved.addInitScript(() => {
    Object.assign(globalThis, { dshDesktop: { protocolVersion: 1, capturePageRegion: () => Promise.resolve(new Uint8Array()) } })
  })
  await moved.route('**/api/directoryPicker/pick', async (route) => {
    const { rpcId } = route.request().postDataJSON() as { rpcId: string }
    await route.fulfill({ json: { type: 'server-response', rpcId, result: { ok: true, value: fresh.workspaceCwd } } })
  })
  await moved.goto(fresh.authenticatedUrl, { waitUntil: 'load' })
  const freshLauncher = moved.getByRole('button', { name: 'Review workbench', exact: true })
  await freshLauncher.click()
  await moved.getByRole('button', { name: 'Choose folder…', exact: true }).click()
  await moved.locator('[data-review-shortcuts]:visible').waitFor()
  await freshLauncher.click()
  await moved.locator('summary').filter({ hasText: /^Continue an existing review$/u }).click()
  const restoredReview = moved.locator(`[data-review-session="${seeded}"]`)
  if (!await restoredReview.isVisible()) await moved.getByText('Other review records', { exact: true }).click()
  await restoredReview.click()
  const rebound = moved.locator('[data-conversation-session]:visible').first()
  await expect.poll(() => rebound.getAttribute('data-conversation-session'), { timeout: 10_000 }).toContain(`-archive-${seeded}`)
  await moved.getByRole('button', { name: 'Open review transcript', exact: true }).click()
  const movedReview = moved.getByRole('region', { name: 'Review' })
  const restoredCard = movedReview.locator('[data-review-entry="clip:2"]')
  await expect.poll(() => restoredCard.getByRole('textbox', { name: 'Card text' }).inputValue()).toBe(fullCardText)
  await restoredCard.getByRole('button', { name: 'Open example.txt' }).press('Enter')
  await moved.locator('[data-document-capture-frame][data-document-capture-active]:visible').waitFor()
  await moved.getByRole('button', { name: 'Open evidence directory', exact: true }).click()
  const restoredEvidence = moved.getByRole('region', { name: 'Evidence directory' })
    .getByRole('button', { name: 'Open review.png', exact: true })
  await expect.poll(() => restoredEvidence.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth),
    { timeout: 10_000 }).toBeGreaterThan(0)

  await compareOrRefreshGolden(
    fileURLToPath(new URL('./expected/sidebar-review.expected.md', import.meta.url)),
    [transcriptSnapshot, reviewSnapshot, confirmSnapshot, exportChoicesSnapshot, outlineSnapshot, paletteSnapshot, frameReturn, pdfSnapshot,
      clearedRecognitionSnapshot, sourceOnSnapshot, autoOnSnapshot, autoCardSnapshot,
      `Overlapping source frames: ${overlapLabels.join(', ')}`, captureActionsSnapshot, evidenceSnapshot, shortcutsSnapshot,
      'The docked review workspace shows Files on the left and both review tabs on the right, with manual fullscreen.',
      'Use the transcript with AI inserts a starter in an empty composer and preserves an existing draft.',
      'Start a review from a workspace creates a fresh review conversation after association.',
      'New Session in the active review workspace creates a fresh review conversation with its shortcuts.',
      'New Session outside the active review conversation opens a regular conversation without review shortcuts.',
      'Continue an existing review shows one row per workspace with saved review content and opens earlier reviews from its history.',
      'Continue an existing review follows session archive and unarchive, and hides reviews from removed workspaces.',
      'A copied workspace opens on a fresh Host and Client with editable OCR, evidence, and its original source rectangle.'].join('\n'),
    webSnapshotMode(),
  )

  expect(errors).toEqual({ warnings: [], pageErrors: [] })
})
