/** Choose a bound account and send the open article to its draft box. */

import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArticleRevision, WeChatAccount, WeChatAppId } from '../wechat-types.ts'
import type { OpenArticle, Publishing, PublishingResult } from './publish.ts'
import css from './ArticleEditor.module.css'

interface Notice {
  readonly text: string
  readonly article: ArticleRevision | undefined
  readonly error?: boolean
  readonly wechatCode?: number
  readonly outboundIp?: string
}
type PanelProps = PropsLocale<'hongzhong'> & {
  readonly draft: OpenArticle | undefined
  readonly publishing: Publishing
}

type Failure = Extract<PublishingResult<never>, { ok: false }>['failure']

/**
 * Render bindings and an explicit draft sync action.
 * @param props - Current draft, localized copy, and Host-backed commands.
 * @returns Publishing controls and their status.
 */
export function WeChatPanel({ draft, publishing, t }: PanelProps): ReactNode {
  const choices = useId()
  const [accounts, setAccounts] = useState<readonly WeChatAccount[]>()
  const [selected, setSelected] = useState<WeChatAppId>()
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [adding, setAdding] = useState(false)
  const visibleNotice = notice?.article === undefined || notice.article === draft?.preview.revision ? notice : undefined

  function run<Value>(
    operation: () => Promise<PublishingResult<Value>>,
    accepted: (value: Value) => void,
    unavailable: Failure = 'publishingUnavailable',
    article?: ArticleRevision,
  ): void {
    setWorking(true)
    setNotice(undefined)
    void operation().then((result) => {
      if (result.ok) accepted(result.value)
      else setNotice({
        text: t(result.failure), error: true, article,
        ...('wechatCode' in result ? { wechatCode: result.wechatCode } : {}),
        ...('outboundIp' in result ? { outboundIp: result.outboundIp } : {}),
      })
    }).catch((_error: unknown) => {
      setNotice({ text: t(unavailable), error: true, article })
    }).finally(() => { setWorking(false) })
  }

  function load(): void {
    run(() => publishing.list(), (records) => {
      setAccounts(records)
      setSelected(records.find(record => record.preferred)?.appId ?? (records.length === 1 ? records[0]?.appId : undefined))
    })
  }

  useEffect(() => { load() }, [publishing])

  function bind(event: FormEvent<HTMLFormElement>, records: readonly WeChatAccount[]): void {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    run(() => publishing.bind({
      // These three named inputs have text or password types.
      appId: fields.get('appId') as string,
      name: fields.get('name') as string,
      appSecret: fields.get('appSecret') as string,
    }), (account) => {
      form.reset()
      const prior = records.find(record => record.appId === account.appId)
      setAccounts([...records.filter(record => record.appId !== account.appId), {
        ...account, ...(prior?.preferred === true ? { preferred: true } : {}),
      }])
      setSelected(account.appId)
      setAdding(false)
    })
  }

  function remove(account: WeChatAccount): void {
    run(() => publishing.remove(account.appId), () => {
      const remaining = accounts?.filter(record => record.appId !== account.appId)
      setAccounts(remaining)
      if (selected === account.appId) setSelected(remaining?.find(record => record.preferred)?.appId)
    })
  }

  function makeDefault(account: WeChatAccount, records: readonly WeChatAccount[]): void {
    run(() => publishing.setDefault(account.appId), (saved) => {
      setAccounts(records.map(({ appId, name }) => appId === saved.appId ? saved : { appId, name }))
      setSelected(saved.appId)
    })
  }

  function sync(selected: WeChatAppId, draft: OpenArticle): void {
    const revision = draft.preview.revision
    run(() => publishing.sync(selected, draft), () => {
      setNotice({ text: t('draftSaved'), article: revision })
    }, 'draftOutcomeUnknown', revision)
  }

  const selectedAccount = accounts?.find(account => account.appId === selected)
  return <section className={css.wechat}>
    <div className={css.wechatActions}>
      <Button size="sm" variant="primary" disabled={working || draft === undefined || selected === undefined}
        onClick={draft === undefined || selected === undefined ? undefined : () => { sync(selected, draft) }}>
        {t('syncDraft')}
      </Button>
      {selectedAccount !== undefined && <span>{t('syncAccount', { name: selectedAccount.name })}</span>}
    </div>
    <details className={css.wechatSettings}>
      <summary>{t('wechatAccounts')}</summary>
      {accounts === undefined ? (
        notice?.error && <Button size="sm" onClick={load} disabled={working}>{t('retryAccounts')}</Button>
      ) : (
        <div className={css.wechatControls}>
          {accounts.length === 0 ? <p>{t('noAccounts')}</p> : (
            <fieldset className={css.accounts}>
              <legend>{t('draftDestination')}</legend>
              {accounts.map(account => (
                <div className={css.account} key={account.appId} role="group" aria-label={account.name}>
                  <label>
                    <input
                      type="radio" name={choices} checked={selected === account.appId} disabled={working}
                      onChange={() => { setSelected(account.appId); setNotice(undefined) }}
                    />
                    <span>{account.name} <small>{account.appId}</small></span>
                  </label>
                  <div className={css.wechatActions}>
                    {account.preferred
                      ? <small>{t('defaultAccount')}</small>
                      : <Button size="sm" disabled={working} onClick={() => { makeDefault(account, accounts) }}>
                        {t('makeDefaultAccount')}
                      </Button>}
                    <Button size="sm" disabled={working} onClick={() => { remove(account) }}>{t('removeBinding')}</Button>
                  </div>
                </div>
              ))}
            </fieldset>
          )}
          <div className={css.wechatActions}>
            <Button size="sm" variant="outline" disabled={working} onClick={() => { setAdding(value => !value) }}>
              {t('linkAccount')}
            </Button>
          </div>
          {adding && (
            <form className={css.binding} onSubmit={(event) => { bind(event, accounts) }}>
              <label>{t('accountName')}<Input name="name" required disabled={working} /></label>
              <label>{t('appId')}<Input name="appId" required disabled={working} /></label>
              <label>
                {t('appSecret')}
                <Input name="appSecret" type="password" autoComplete="off" required disabled={working} />
              </label>
              <Button size="sm" type="submit" variant="primary" disabled={working}>{t('saveBinding')}</Button>
            </form>
          )}
        </div>
      )}
    </details>
    {working && <p className={css.status} role="status">{t('wechatWorking')}</p>}
    {visibleNotice !== undefined && (
      <p className={visibleNotice.error ? css.error : css.status} role={visibleNotice.error ? 'alert' : 'status'}>
        {visibleNotice.text} {visibleNotice.wechatCode !== undefined && <small>({visibleNotice.wechatCode})</small>}
        {visibleNotice.outboundIp !== undefined && <span> {t('reportedIp', { ip: visibleNotice.outboundIp })}</span>}
      </p>
    )}
  </section>
}
