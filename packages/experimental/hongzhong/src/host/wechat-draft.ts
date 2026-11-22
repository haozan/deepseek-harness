/** Prepare Markdown and local image bytes for a WeChat news draft. */

import type { Element, Root } from 'hast'
import { toHtml } from 'hast-util-to-html'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { toHast } from 'mdast-util-to-hast'
import { toString } from 'mdast-util-to-string'
import { gfm } from 'micromark-extension-gfm'
import type { ArticleTheme, DraftImage, WeChatDraft } from '../wechat-types.ts'
import { WeChatError, type UploadImage } from './wechat-api.ts'

const STYLES: ReadonlyMap<string, string> = new Map([
  ['p', 'margin:12px 0;font-size:17px;line-height:1.75;'],
  ['h1', 'font-size:24px;margin:30px 0 15px;'],
  ['h2', 'font-size:22px;margin:30px 0 15px;'],
  ['h3', 'font-size:20px;margin:30px 0 15px;'],
  ['h4', 'font-size:18px;margin:30px 0 15px;'],
  ['a', 'color:#1e6bb8;text-decoration:underline;'],
  ['blockquote', 'margin:20px 0;padding:10px 12px 10px 20px;border-left:3px solid #999;background:#f4f4f4;'],
  ['img', 'display:block;max-width:100%;height:auto;margin:12px auto;'],
  ['ul', 'margin:8px 0;padding-left:25px;'],
  ['ol', 'margin:8px 0;padding-left:25px;'],
  ['table', 'width:100%;border-collapse:collapse;font-size:14px;margin:12px 0;'],
  ['th', 'background:#f4f4f4;border:1px solid #ddd;padding:6px 10px;'],
  ['td', 'border:1px solid #ddd;padding:6px 10px;'],
  ['pre', 'margin:16px 0;padding:12px;background:#f4f4f4;white-space:pre-wrap;overflow-wrap:anywhere;'],
])

const THEMES: Readonly<Record<ArticleTheme, { accent: string; tint: string; heading: string; border: string }>> = {
  classic: { accent: '#1e6bb8', tint: '#f4f4f4', heading: 'color:#222;', border: '#999' },
  editorial: { accent: '#963f2c', tint: '#f9f1e8', heading: 'color:#963f2c;', border: '#bf785e' },
  clean: { accent: '#17644c', tint: '#eff6f2', heading: 'color:#164d3b;', border: '#57927b' },
}

/**
 * Decode and verify an image against the supported JPEG and PNG signatures.
 * @param image - Encoded bytes and the expected image type.
 * @returns Verified bytes for preview or upload.
 */
export function imageBytes(image: DraftImage): UploadImage {
  if (image.base64.length === 0 || image.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(image.base64)) {
    throw new WeChatError('invalidImage')
  }
  const bytes = Buffer.from(image.base64, 'base64')
  if (bytes.toString('base64') !== image.base64) throw new WeChatError('invalidImage')
  const prefix = image.mime === 'image/png' ? '89504e470d0a1a0a' : 'ffd8ff'
  if (!bytes.toString('hex', 0, prefix.length / 2).startsWith(prefix)) throw new WeChatError('invalidImage')
  return { mime: image.mime, bytes }
}

function webAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !URL.canParse(value)) return false
  const { protocol } = new URL(value)
  return protocol === 'https:' || protocol === 'http:'
}

function* elements(parent: Root | Element): Iterable<Element> {
  for (const node of parent.children) {
    if (node.type !== 'element') continue
    yield node
    yield* elements(node)
  }
}

interface ArticleContent {
  readonly title: string
  readonly paths: readonly string[]
  render(imageUrl: (path: string) => string | undefined): string
}

/**
 * Normalize a Markdown image address into a path inside its article folder.
 * @param address - Markdown image address.
 * @returns Relative JPEG or PNG path, if supported.
 */
export function relativeImagePath(address: string): string | undefined {
  let path: string
  try { path = decodeURIComponent(address).replace(/^\.\//, '') }
  catch (_error: unknown) { return undefined }
  if (/[\\:\x00-\x1f?#]/.test(path) || path.split('/').some(part => part === '' || part === '..' || part === '.')) return undefined
  return /\.(?:jpe?g|png)$/i.test(path) ? path : undefined
}

/**
 * Render the same article typography for the preview and the WeChat draft.
 * @param source - Markdown with optional relative image references.
 * @param theme - Selected preview and publication typography.
 * @returns Its heading, image references, and an HTML renderer that uses only supplied image URLs.
 */
export function articleContent(source: string, theme: ArticleTheme = 'classic'): ArticleContent {
  const markdown = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const tree = toHast(markdown) as Root
  const palette = THEMES[theme]
  const heading = markdown.children.find(node => node.type === 'heading' && node.depth === 1)
  const placements: { node: Element; path: string }[] = []
  for (const node of elements(tree)) {
    const style = STYLES.get(node.tagName)
    if (style !== undefined) node.properties.style = style
    if (node.tagName === 'a') {
      if (!webAddress(node.properties.href)) delete node.properties.href
      node.properties.style = `color:${palette.accent};text-decoration:underline;`
    }
    if (node.tagName === 'blockquote') {
      node.properties.style = `margin:20px 0;padding:10px 12px 10px 20px;border-left:3px solid ${palette.border};background:${palette.tint};`
    }
    if (style !== undefined && /^h[1-4]$/u.test(node.tagName)) node.properties.style = style + palette.heading
    // Raw HTML is omitted, so only the Markdown image handlers can emit img nodes.
    if (node.tagName === 'img') placements.push({ node, path: node.properties.src as string })
  }
  return {
    title: toString(heading, { includeHtml: false }).trim(),
    paths: [...new Set(placements.map(({ path }) => path))],
    render: (imageUrl: (path: string) => string | undefined) => {
      for (const { node, path } of placements) {
        const url = imageUrl(path)
        if (url === undefined) delete node.properties.src
        else node.properties.src = url
      }
      return `<section style="font-size:17px;line-height:1.75;word-wrap:break-word;color:#222;padding:0 8px;font-family:Optima,PingFang SC,Microsoft YaHei,sans-serif;">${toHtml(tree)}</section>`
    },
  }
}

interface PreparedDraft {
  readonly title: string
  readonly cover: UploadImage
  readonly images: ReadonlyMap<string, UploadImage>
  render(uploaded: ReadonlyMap<string, string>): string
}

/**
 * Prepare the full article before any upload. Only submitted image bytes may
 * supply an image; no Markdown address is fetched by the Host.
 * @param draft - The article fields and images available from the editor.
 * @param theme - Typography used for the selected preview.
 * @returns Validated image bytes and a renderer that accepts WeChat image URLs.
 */
export function prepareDraft(draft: WeChatDraft, theme: ArticleTheme = 'classic'): PreparedDraft {
  const title = draft.title.trim()
  if (title === '' || draft.markdown.trim() === '') throw new WeChatError('invalidDraft')
  const content = articleContent(draft.markdown, theme)
  const supplied = new Map(draft.images.map(image => [image.path, image]))
  const uploads = new Map<string, UploadImage>()
  for (const path of content.paths) {
    const image = supplied.get(path)
    if (image === undefined || relativeImagePath(path) === undefined) throw new WeChatError('missingImage')
    uploads.set(path, imageBytes(image))
  }

  const cover = supplied.get(draft.cover)
  if (cover === undefined) throw new WeChatError('missingImage')
  return {
    title, cover: uploads.get(draft.cover) ?? imageBytes(cover), images: uploads,
    render: uploaded => content.render((path) => {
      const url = uploaded.get(path)
      if (!webAddress(url)) throw new WeChatError('wechatUnavailable')
      return url
    }),
  }
}
