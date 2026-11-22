/** Draft formatting uses only supplied image bytes and WeChat addresses. */

import { expect, it } from 'vitest'
import { articleContent, prepareDraft, relativeImagePath } from '../src/host/wechat-draft.ts'
import type { DraftImage, WeChatDraft } from '../src/wechat-types.ts'

const picture = 'images/12345678-abcd.png'
const png = { path: picture, mime: 'image/png', base64: 'iVBORw0KGgo=' } satisfies DraftImage
const original = {
  title: '  发布流程  ',
  markdown: `## 正文

**保留格式**

![封面](${picture})

![正文][asset]

[asset]: ${picture}

[unsafe](javascript:alert%281%29)

<script>alert(1)</script>
`,
  cover: picture,
  images: [png],
} satisfies WeChatDraft

it('inlines typography, deduplicates images, and removes executable markup', () => {
  const draft = prepareDraft(original)
  expect(draft.title).toBe('发布流程')
  expect(draft.images.size).toBe(1)
  expect(draft.cover).toBe(draft.images.get(picture))
  const html = draft.render(new Map([[picture, 'https://mmbiz.qpic.cn/example.png']]))
  expect(html).toContain('<section style="font-size:17px;line-height:1.75;')
  expect(html).toContain('<strong>保留格式</strong>')
  expect(html.match(/https:\/\/mmbiz\.qpic\.cn\/example\.png/g)).toHaveLength(2)
  expect(html).not.toMatch(/<script|javascript:|images\/12345678/)
})

it.each([
  { title: ' ', failure: 'invalidDraft' },
  { markdown: '\n  ', failure: 'invalidDraft' },
  { markdown: '![outside](https://other.example/p.png)', failure: 'missingImage' },
  { cover: 'images/unavailable.jpg', failure: 'missingImage' },
  { images: [{ ...png, base64: '' }], failure: 'invalidImage' },
  { images: [{ ...png, base64: '!!!=' }], failure: 'invalidImage' },
  { images: [{ ...png, base64: 'AAAA====' }], failure: 'invalidImage' },
  { images: [{ ...png, base64: 'aW1hZ2U=' }], failure: 'invalidImage' },
] satisfies (Partial<WeChatDraft> & { failure: string })[])('rejects unpublishable input (%j)', ({ failure, ...fields }) => {
  expect(() => prepareDraft({ ...original, ...fields })).toThrow(expect.objectContaining({ failure }))
})

it('requires a web URL for every uploaded body image', () => {
  const draft = prepareDraft(original)
  expect(() => draft.render(new Map())).toThrow(expect.objectContaining({ failure: 'wechatUnavailable' }))
  expect(() => draft.render(new Map([[picture, 'javascript:alert(1)']])))
    .toThrow(expect.objectContaining({ failure: 'wechatUnavailable' }))
})

it('accepts a JPEG cover that does not appear in the article body', () => {
  const jpg = { path: 'images/87654321.jpg', mime: 'image/jpeg', base64: '/9j/' } satisfies DraftImage
  const draft = prepareDraft({ ...original, cover: jpg.path, images: [png, jpg] })
  expect(draft.cover).toEqual({ mime: 'image/jpeg', bytes: Buffer.from(jpg.base64, 'base64') })
  expect([...draft.images.keys()]).toEqual([picture])
})

it('normalizes encoded relative paths and rejects references outside the article', () => {
  expect(relativeImagePath('./images/海边%20散步.png')).toBe('images/海边 散步.png')
  for (const reference of ['%C3.png', 'banner.gif', '../cover.png', '%2e%2e/cover.png', '/cover.png', 'https://example.com/img.png']) {
    expect(relativeImagePath(reference)).toBeUndefined()
  }
  expect(articleContent('# A **bold** heading\n\n## Subheading').title).toBe('A bold heading')
  expect(articleContent('## Subheading').title).toBe('')
})

it('applies the same style to linked text, headings and quotes in preview and draft preparation', () => {
  const markdown = '# Heading\n\n[Link](https://example.org)\n\n> Quote'
  for (const [theme, tint] of [['classic', '#f4f4f4'], ['editorial', '#f9f1e8'], ['clean', '#eff6f2']] as const) {
    const html = articleContent(markdown, theme).render(() => undefined)
    expect(html).toContain(tint)
    expect(html).toContain('href="https://example.org"')
    expect(prepareDraft({ ...original, markdown }, theme).render(new Map())).toBe(html)
  }
})
