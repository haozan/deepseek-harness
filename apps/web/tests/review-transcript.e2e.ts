/** Replay a transcript question through the review workspace, Host tool, and source link. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { WorkspaceReviewArchive } from '../../../packages/client/ui-sidebar-review/src/archive-host.ts'
import { fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/review-transcript/session.v4.jsonl', import.meta.url))
const PLUGIN = fileURLToPath(new URL('../../../packages/client/ui-sidebar-review/', import.meta.url))
const ARCHIVE = 'review-workbench-payments'
const SOURCE = 'Payment record.txt'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABQCAIAAABpgOfCAAAAmElEQVR4nO3QMQ2AMAAAwZqoKATgib2SMIaDbqQ/XPICPjfmerVpHD+IBwgQIECAwgECBAgQoHCAAAECBCgcIECAAAEKBwgQIECAwgECBAgQoHCAAAECBCgcIECA/gW67kebAAECBAhQOECAAAECFA4QIECAAIUDBAgQIEDhAAECBAhQOECAAAECFA4QIECAAIUDBAgQoJN95RSBOzpM1cgAAAAASUVORK5CYII='

it.skipIf(webSnapshotMode() === 'record')('answers from a reopened review and links to the source file', async () => {
  const scaffold = await launchWebScaffold({
    replayFixture: FIXTURE,
    replayProviders: [{ id: 'deepseek-official', models: [{
      id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text', 'image'], contextWindow: 128_000,
    }] }],
    profile: { packages: [] },
  })
  onTestFinished(() => scaffold.close())
  const manager = scaffold.ctx.get('pluginManager')
  if (manager === undefined) throw new Error('The built profile has no plugin installer')
  expect(await manager.installBundle(PLUGIN)).toMatchObject({ application: 'applied' })
  await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Payments case')
  await writeFile(join(scaffold.workspaceCwd, SOURCE), 'Payment memo\nThe bank confirmed the settlement.\n')
  const archive = new WorkspaceReviewArchive(scaffold.workspaceCwd)
  const image = await archive.putImage(ARCHIVE, PNG)
  const clip = { source: SOURCE, fileName: SOURCE, image }
  expect(await archive.commit(ARCHIVE, 0, JSON.stringify({
    version: 1,
    revision: 1,
    updatedAt: 1,
    clips: [{ id: 1, ...clip }, { id: 2, ...clip }, { id: 3, ...clip }, { id: 4, ...clip, destination: 'evidence' }],
    draft: {
      version: 3,
      order: ['clip:1', 'clip:2', 'clip:3'],
      folders: [
        { id: 'folder:a', parentId: null, title: 'Contract' },
        { id: 'folder:b', parentId: 'folder:a', title: 'Payments' },
        { id: 'folder:c', parentId: null, title: 'Dispute' },
        { id: 'folder:d', parentId: 'folder:c', title: 'Payments' },
      ],
      assignments: { 'clip:1': 'folder:b', 'clip:2': 'folder:b', 'clip:3': 'folder:d', 'clip:4': 'folder:b' },
      extracts: { 'clip:1': 'Transfer amount: 100', 'clip:3': 'Other folder text', 'clip:4': 'Evidence directory text' },
      notes: { 'clip:1': 'Verified against the bank memo.' },
    },
  }))).toBe(true)

  const browser = await chromium.launch({ channel: 'chromium' })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.addInitScript(() => {
    Object.assign(globalThis, { dshDesktop: { protocolVersion: 1, capturePageRegion: () => new Uint8Array() } })
  })
  const consoleErrors = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Review workbench', exact: true }).click()
  await page.locator('[data-review-launcher] summary').filter({ hasText: /^Continue an existing review$/u }).click()
  await page.locator(`[data-review-session="${ARCHIVE}"]`).click()
  await page.getByRole('button', { name: 'Use the transcript with AI', exact: true }).click()
  const composer = page.locator('[data-composer-input][contenteditable="true"]:visible')
  await expect.poll(() => composer.innerText()).toContain('drafting a legal document')
  await expect.poll(() => composer.evaluate(node => node === document.activeElement)).toBe(true)
  const [question] = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
  if (question === undefined) throw new Error('The transcript snapshot has no question')
  const turn = scaffold.whenTurnSettled(30_000)
  await composer.fill(question)
  await composer.press('Enter')
  const sessionId = await turn
  const session = scaffold.ctx.agents.get(sessionId)?.session
  if (session === undefined) throw new Error('The review conversation did not settle')
  const results = session.snapshotEvents().filter(event => event.type === 'tool/result')
  expect(results.map(event => event.data.message.isError)).toEqual([false, false, false])
  const [folderResult, readResult, screenshotResult] = results
  const folders = folderResult?.data.message.content[0]
  if (folders?.type !== 'text') throw new Error('The review did not return a folder list')
  expect(folders.text).toContain('["Contract","Payments"]')
  expect(folders.text).toContain('["Dispute","Payments"]')
  const text = JSON.stringify(readResult?.data.message.content)
  expect(text).toContain('Transfer amount: 100')
  expect(text).toContain('Verified against the bank memo.')
  expect(text).not.toContain('Other folder text')
  expect(text).not.toContain('Evidence directory text')
  expect(screenshotResult?.data.message.content[1]).toMatchObject({ type: 'image', attachment: { mediaType: 'image/png' } })
  const citation = page.getByRole('button', { name: 'Payment record', exact: true })
  await citation.click()
  await page.locator('[data-textpreview-body]:visible').getByText('The bank confirmed the settlement.', { exact: true }).waitFor()
  expect(consoleErrors.pageErrors).toEqual([])
}, 60_000)
