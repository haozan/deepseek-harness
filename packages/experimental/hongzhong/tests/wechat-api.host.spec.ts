/** WeChat errors distinguish missing permission from an uncertain draft mutation. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it } from 'vitest'
import { WeChatApi } from '../src/host/wechat-api.ts'
import type { WeChatAppId } from '../src/wechat-types.ts'

const account = { appId: brandString<WeChatAppId>('wx0000000000000001'), appSecret: 'fixture-secret' }
const signal = new AbortController().signal
const draft = { title: 'Fixture', content: '<p>Draft</p>', thumb_media_id: 'cover' }

it.each([
  [40164, 'ipRestricted'],
  [40001, 'credentialRejected'],
  [40013, 'credentialRejected'],
  [40125, 'credentialRejected'],
  [48001, 'wechatRejected'],
])('classifies WeChat code %i without returning its message', async (errcode, failure) => {
  const api = new WeChatApi(500, async () => Response.json({ errcode, errmsg: 'sensitive upstream text' }))
  await expect(api.token(account, signal)).rejects.toMatchObject({ failure, wechatCode: errcode })
})

it.each([
  ['invalid ip 198.51.100.9 ipv6 ::ffff:198.51.100.9, not in whitelist rid: fixture', '198.51.100.9'],
  ['invalid ip 2001:db8::42, not in whitelist', '2001:db8::42'],
  ['invalid ip 198.51.100.900, not in whitelist', undefined],
  [40164, undefined],
])('extracts only a valid reported address from an allowlist error', async (errmsg, outboundIp) => {
  const api = new WeChatApi(500, async () => Response.json({ errcode: 40164, errmsg }))
  await expect(api.token(account, signal)).rejects.toMatchObject({ failure: 'ipRestricted', outboundIp })
})

it.each([
  () => new Response(null, { status: 503 }),
  () => new Response('broken json'),
  () => Response.json([]),
  () => Response.json({}),
])('reports an uncertain POST even when the response cannot be decoded', async (response) => {
  const api = new WeChatApi(500, async () => response())
  await expect(api.createDraft(draft, 'fixture-token', signal)).rejects
    .toMatchObject({ failure: 'draftOutcomeUnknown' })
  await expect(api.token(account, signal)).rejects.toMatchObject({ failure: 'wechatUnavailable' })
})

it('uploads typed media and writes the draft to the returned account token', async () => {
  const requests: URL[] = []
  const api = new WeChatApi(500, async (input) => {
    if (!(input instanceof URL)) throw new Error('Expected the fixed WeChat URL')
    requests.push(input)
    if (input.pathname.endsWith('/stable_token')) return Response.json({ access_token: 'bound-token' })
    if (input.pathname.endsWith('/uploadimg')) return Response.json({ url: 'https://mmbiz.qpic.cn/test' })
    if (input.pathname.endsWith('/add_material')) return Response.json({ media_id: 'cover-id' })
    return Response.json({ media_id: 'draft-id' })
  })
  const token = await api.token(account, signal)
  const body = await api.upload({ bytes: Uint8Array.of(1), mime: 'image/png' }, token, 'body', signal)
  const cover = await api.upload({ bytes: Uint8Array.of(2), mime: 'image/jpeg' }, token, 'cover', signal)
  expect(body).toBe('https://mmbiz.qpic.cn/test')
  expect(cover).toBe('cover-id')
  await expect(api.createDraft({ ...draft, thumb_media_id: cover }, token, signal)).resolves.toBe('draft-id')
  expect(requests.map(url => url.origin)).toEqual(Array.from({ length: 4 }, () => 'https://api.weixin.qq.com'))
  expect(requests[2]?.searchParams.get('type')).toBe('image')
  expect(requests.slice(1).map(url => url.searchParams.get('access_token'))).toEqual(Array.from({ length: 3 }, () => token))
})
