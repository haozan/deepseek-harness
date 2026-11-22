// @vitest-environment jsdom
/** Manage multiple bindings, publish to the selected account, and surface failure. */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArticleFolder, ArticleRevision, ArticleSourceVersion, WeChatAppId } from '../src/wechat-types.ts'
import { WeChatPanel } from '../src/client/WeChatPanel.tsx'
import { en } from '../src/client/locales.ts'
import type { OpenArticle, Publishing } from '../src/client/publish.ts'

const first = { name: 'First account', appId: brandString<WeChatAppId>('wx0000000000000001') }
const second = { name: 'Second account', appId: brandString<WeChatAppId>('wx0000000000000002') }
const article: OpenArticle = {
  location: { workspaceId: brandString<WorkspaceId>('workspace'), folder: brandString<ArticleFolder>('first-article') },
  preview: {
    title: 'Draft', markdown: 'Article body', html: '<p>Article body</p>', coverSrc: null,
    missingImages: [], sourceVersion: brandString<ArticleSourceVersion>('markdown-version'), revision: brandString<ArticleRevision>('first-revision'),
  },
}
const t = makeTranslate(en)

afterEach(() => { cleanup() })

function mockPublishing() {
  return {
    listArticles: vi.fn<Publishing['listArticles']>().mockResolvedValue({ ok: true, value: [] }),
    readArticle: vi.fn<Publishing['readArticle']>().mockResolvedValue({ ok: true, value: article.preview }),
    setActiveArticle: vi.fn<Publishing['setActiveArticle']>().mockResolvedValue({ ok: true, value: true }),
    saveArticle: vi.fn<Publishing['saveArticle']>().mockResolvedValue({ ok: true, value: article.preview.sourceVersion }),
    setDefault: vi.fn<Publishing['setDefault']>().mockResolvedValue({ ok: true, value: { ...first, preferred: true } }),
    list: vi.fn<Publishing['list']>().mockResolvedValue({ ok: true, value: [] }),
    bind: vi.fn<Publishing['bind']>().mockResolvedValue({ ok: true, value: first }),
    remove: vi.fn<Publishing['remove']>().mockResolvedValue({ ok: true, value: true }),
    sync: vi.fn<Publishing['sync']>().mockResolvedValue({ ok: true, value: 'media-id' }),
  }
}

function openAccounts(): void {
  fireEvent.click(screen.getByText('WeChat accounts', { exact: true }))
}

it('retries an account lookup and binds, selects, and removes accounts', async () => {
  const publishing = mockPublishing()
  publishing.list.mockResolvedValueOnce({ ok: false, failure: 'publishingUnavailable' })
  publishing.bind.mockResolvedValueOnce({
    ok: false, failure: 'ipRestricted', wechatCode: 40164, outboundIp: '198.51.100.9',
  })
  render(<WeChatPanel t={t} draft={article} publishing={publishing} />)
  openAccounts()
  const reload = await screen.findByRole('button', { name: 'Reload accounts' })
  expect(screen.getByRole('alert').textContent).toContain(en.publishingUnavailable)
  fireEvent.click(reload)
  await screen.findByText('No WeChat accounts are bound.')

  fireEvent.click(screen.getByRole('button', { name: 'Bind account' }))
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: first.name } })
  fireEvent.change(screen.getByLabelText('AppID'), { target: { value: first.appId } })
  fireEvent.change(screen.getByLabelText('AppSecret'), { target: { value: 'fixture' } })
  const save = screen.getByRole('button', { name: 'Save binding' })
  fireEvent.click(save)
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('40164') })
  expect(screen.getByRole('alert').textContent).toContain('WeChat saw the IP address 198.51.100.9.')
  fireEvent.click(save)
  await screen.findByRole('radio', { name: `${first.name} ${first.appId}` })
  expect(publishing.bind).toHaveBeenLastCalledWith({ ...first, appSecret: 'fixture' })

  publishing.bind.mockResolvedValueOnce({ ok: true, value: second })
  fireEvent.click(screen.getByRole('button', { name: 'Bind account' }))
  expect(screen.getByLabelText('AppSecret')).toMatchObject({ value: '' })
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: second.name } })
  fireEvent.change(screen.getByLabelText('AppID'), { target: { value: second.appId } })
  fireEvent.change(screen.getByLabelText('AppSecret'), { target: { value: 'second-fixture' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save binding' }))
  await screen.findByRole('radio', { name: `${second.name} ${second.appId}` })

  fireEvent.click(screen.getByRole('radio', { name: `${first.name} ${first.appId}` }))
  const secondRow = screen.getByRole('radio', { name: `${second.name} ${second.appId}` }).closest('div')
  const otherButton = [...(secondRow?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Unbind')
  if (otherButton === null || otherButton === undefined) throw new Error('Expected the other binding')
  fireEvent.click(otherButton)
  await waitFor(() => { expect(screen.queryByRole('radio', { name: `${second.name} ${second.appId}` })).toBeNull() })
  expect(publishing.remove).toHaveBeenLastCalledWith(second.appId)

  fireEvent.click(screen.getByRole('button', { name: 'Sync to draft box' }))
  await screen.findByText(en.draftSaved)
  expect(publishing.sync).toHaveBeenCalledExactlyOnceWith(first.appId, article)

  const [remove] = screen.getAllByRole('button', { name: 'Unbind' })
  if (remove === undefined) throw new Error('Expected a binding to remove')
  fireEvent.click(remove)
  await waitFor(() => { expect(screen.queryByRole('radio', { name: `${first.name} ${first.appId}` })).toBeNull() })
  expect(publishing.remove).toHaveBeenLastCalledWith(first.appId)
  expect(screen.getByRole('button', { name: 'Sync to draft box' })).toMatchObject({ disabled: true })
})

it('retains loaded accounts across toggles after a transport failure and reload', async () => {
  const publishing = mockPublishing()
  publishing.list
    .mockRejectedValueOnce(new Error('Fixture transport closed'))
    .mockResolvedValueOnce({ ok: true, value: [first] })
  render(<WeChatPanel t={t} draft={undefined} publishing={publishing} />)
  openAccounts()
  await screen.findByText(en.publishingUnavailable)
  fireEvent.click(screen.getByRole('button', { name: 'Reload accounts' }))
  await screen.findByRole('radio', { name: `${first.name} ${first.appId}`, checked: true })
  const details = screen.getByText('WeChat accounts', { exact: true }).closest('details')
  if (details === null) throw new Error('Expected account details')
  details.open = false
  fireEvent(details, new Event('toggle'))
  details.open = true
  fireEvent(details, new Event('toggle'))
  expect(publishing.list).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button', { name: 'Sync to draft box' })).toMatchObject({ disabled: true })
})

it('does not imply that a different article synced when the response is lost', async () => {
  const publishing = mockPublishing()
  publishing.list.mockResolvedValueOnce({ ok: true, value: [first] })
  publishing.sync.mockRejectedValueOnce(new Error('Fixture transport closed'))
  const props = { t, publishing }
  const { rerender } = render(<WeChatPanel {...props} draft={article} />)
  openAccounts()
  await screen.findByRole('radio', { name: `${first.name} ${first.appId}`, checked: true })
  fireEvent.click(screen.getByRole('button', { name: 'Sync to draft box' }))
  await screen.findByText(en.draftOutcomeUnknown)
  rerender(<WeChatPanel {...props} draft={{ ...article, preview: { ...article.preview, revision: brandString<ArticleRevision>('another-revision') } }} />)
  expect(screen.queryByText(en.draftOutcomeUnknown)).toBeNull()
})

it('loads the default account before opening its settings and keeps temporary selections local', async () => {
  const publishing = mockPublishing()
  publishing.list.mockResolvedValueOnce({ ok: true, value: [{ ...first, preferred: true }, second] })
  publishing.setDefault.mockResolvedValueOnce({ ok: true, value: { ...second, preferred: true } })
  render(<WeChatPanel t={t} draft={article} publishing={publishing} />)
  await screen.findByText('Sync to First account')
  openAccounts()
  fireEvent.click(screen.getByRole('radio', { name: `${second.name} ${second.appId}` }))
  await screen.findByText('Sync to Second account')
  expect(publishing.setDefault).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Make default' }))
  await waitFor(() => { expect(publishing.setDefault).toHaveBeenCalledExactlyOnceWith(second.appId) })
  expect(await screen.findByText('Default')).toBeTruthy()
})

it('retains the default when a binding is updated and when a temporary account is removed', async () => {
  const publishing = mockPublishing()
  publishing.list.mockResolvedValueOnce({ ok: true, value: [{ ...first, preferred: true }, second] })
  render(<WeChatPanel t={t} draft={article} publishing={publishing} />)
  openAccounts()
  await screen.findByText('Sync to First account')
  fireEvent.click(screen.getByRole('button', { name: 'Bind account' }))
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: first.name } })
  fireEvent.change(screen.getByLabelText('AppID'), { target: { value: first.appId } })
  fireEvent.change(screen.getByLabelText('AppSecret'), { target: { value: 'updated-fixture' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save binding' }))
  await waitFor(() => { expect(screen.queryByRole('button', { name: 'Save binding' })).toBeNull() })
  expect(screen.getByText('Default')).toBeTruthy()
  const temporary = screen.getByRole('radio', { name: `${second.name} ${second.appId}` })
  fireEvent.click(temporary)
  const row = temporary.closest('div')
  if (row === null) throw new Error('Expected the temporary account row')
  fireEvent.click(within(row).getByRole('button', { name: 'Unbind' }))
  await screen.findByText('Sync to First account')
})
