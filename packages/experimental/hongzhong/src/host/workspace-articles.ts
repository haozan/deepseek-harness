/** Read original article files from a registered workspace. */

import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  ArticleFailure, ArticleFolder, ArticlePreview, ArticleRevision, ArticleSourceVersion, ArticleTheme, DraftImage, WeChatDraft,
} from '../wechat-types.ts'
import { WeChatError } from './wechat-api.ts'
import { articleContent, imageBytes, relativeImagePath } from './wechat-draft.ts'

const ARTICLE = 'article.md'
const COVERS = ['cover.jpg', 'cover.jpeg', 'cover.png']

/** A workspace article could not be listed, loaded, or safely synchronized. */
export class ArticleError extends HarnessError {
  /** @param failure - User-visible recovery category. @param cause - Filesystem failure, if present. */
  constructor(readonly failure: ArticleFailure, cause?: unknown) {
    super('The workspace article could not be read or synchronized.', 'HONGZHONG_ARTICLE', { cause })
  }
}

function folderName(name: string): boolean {
  return name !== '' && !name.startsWith('.') && !/[\\/:\x00-\x1f]/.test(name)
}

interface Folder {
  readonly target: FsTarget
  readonly cwd: string
}

function asFolder(fs: FileSystem, target: FsTarget): Folder {
  return { target, cwd: fs.processPath(target) }
}

async function childFile(fs: FileSystem, parent: Folder, path: string, signal: AbortSignal): Promise<FsTarget | undefined> {
  const opts = { cwd: parent.cwd }
  const relative = `./${path}`
  if ((await fs.lstat(relative, opts, signal))?.type !== 'file') return undefined
  const child = await fs.resolve(relative, { ...opts, signal })
  return fs.contains(parent.target, child) ? child : undefined
}

/**
 * Name the Markdown file relative to its workspace.
 * @param name - Direct article folder.
 * @returns A workspace-relative Markdown path.
 */
export function articlePath(name: ArticleFolder): string {
  if (!folderName(name)) throw new ArticleError('articleUnavailable')
  return `${name}/${ARTICLE}`
}

async function sourceFile(fs: FileSystem, rootPath: string, name: ArticleFolder, signal: AbortSignal) {
  articlePath(name)
  if ((await fs.lstat(rootPath, {}, signal))?.type !== 'directory') throw new ArticleError('articleUnavailable')
  const root = await fs.resolve(rootPath, { signal })
  const cwd = fs.processPath(root)
  const relative = `./${name}`
  const target = await fs.resolve(relative, { cwd, signal })
  if (!fs.contains(root, target) || (await fs.lstat(relative, { cwd }, signal))?.type !== 'directory') {
    throw new ArticleError('articleUnavailable')
  }
  const folder = asFolder(fs, target)
  const source = await childFile(fs, folder, ARTICLE, signal)
  if (source === undefined) throw new ArticleError('articleUnavailable')
  return { folder, source }
}

/**
 * Find direct folders that contain article.md without opening article content.
 * @param fs - Composed filesystem provider.
 * @param path - The registered workspace root.
 * @param signal - Request lifetime.
 * @returns Article folder names, newest dated folder first.
 */
export async function listWorkspaceArticles(fs: FileSystem, path: string, signal: AbortSignal): Promise<ArticleFolder[]> {
  try {
    if ((await fs.lstat(path, {}, signal))?.type !== 'directory') throw new ArticleError('workspaceUnavailable')
    const root = await fs.resolve(path, { signal })
    const cwd = fs.processPath(root)
    const entries = await fs.listDir(root, signal)
    const articles: ArticleFolder[] = []
    for (const entry of entries) {
      if (entry.type !== 'directory' || !folderName(entry.name) || !fs.contains(root, entry.target)) continue
      if ((await fs.lstat(`./${entry.name}`, { cwd }, signal))?.type !== 'directory') continue
      if (await childFile(fs, asFolder(fs, entry.target), ARTICLE, signal) !== undefined) {
        articles.push(brandString<ArticleFolder>(entry.name))
      }
    }
    return articles.sort((left, right) => right.localeCompare(left))
  } catch (cause: unknown) {
    signal.throwIfAborted()
    throw new ArticleError('workspaceUnavailable', cause)
  }
}

async function readImage(
  fs: FileSystem, folder: Folder, reference: string, limit: number, signal: AbortSignal,
): Promise<DraftImage | undefined> {
  const path = relativeImagePath(reference)
  if (path === undefined) return undefined
  try {
    const target = await childFile(fs, folder, path, signal)
    if (target === undefined) return undefined
    const bytes = await fs.readBytes(target, signal, limit)
    const mime = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg'
    const image = { path: reference, mime, base64: Buffer.from(bytes).toString('base64') } satisfies DraftImage
    imageBytes(image)
    return image
  } catch (_error: unknown) {
    signal.throwIfAborted()
    return undefined
  }
}

function imageSrc(image: DraftImage): string {
  return `data:${image.mime};base64,${image.base64}`
}

interface WorkspaceArticle {
  readonly preview: ArticlePreview
  readonly draft: WeChatDraft
}

/** Byte limits applied independently to Markdown and to the combined article images. */
export interface ArticleLimits {
  /** Maximum bytes of UTF-8 source in a single article.md file. */
  readonly maxMarkdownBytes: number
  /** Maximum combined source bytes of the cover and the body images. */
  readonly maxImageBytes: number
}

/**
 * Read an article and the images it explicitly references. Images outside its folder never enter the preview or draft.
 * @param fs - Composed filesystem provider.
 * @param rootPath - The registered workspace root.
 * @param name - The one direct child directory containing the article.
 * @param limits - Bounds on the source and all image bytes.
 * @param signal - Request lifetime.
 * @param theme - Selected typography.
 * @returns The rendered preview and exact media input used to create a WeChat draft.
 */
export async function readWorkspaceArticle(
  fs: FileSystem, rootPath: string, name: ArticleFolder, limits: ArticleLimits, signal: AbortSignal, theme: ArticleTheme = 'classic',
): Promise<WorkspaceArticle> {
  let folder: Folder
  let markdown: string
  let sourceVersion: FsVersion
  try {
    const file = await sourceFile(fs, rootPath, name, signal)
    folder = file.folder
    const before = await fs.stat(file.source, signal)
    if (before?.type !== 'file') throw new ArticleError('articleUnavailable')
    const bytes = await fs.readBytes(file.source, signal, limits.maxMarkdownBytes)
    const after = await fs.stat(file.source, signal)
    if (after?.version !== before.version) throw new ArticleError('articleChanged')
    sourceVersion = before.version
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause: unknown) {
    signal.throwIfAborted()
    if (cause instanceof ArticleError) throw cause
    throw new ArticleError('articleUnavailable', cause)
  }

  const content = articleContent(markdown, theme)
  const title = content.title || name.replace(/^\d{4}-\d{2}-\d{2}_\d{4}_(?=.)/, '')
  let remaining = limits.maxImageBytes
  const assets = new Map<string, DraftImage>()
  const load = async (path: string) => {
    const image = await readImage(fs, folder, path, remaining, signal)
    if (image !== undefined) {
      remaining -= Buffer.byteLength(image.base64, 'base64')
      assets.set(path, image)
    }
    return image
  }
  let cover: DraftImage | undefined
  for (const candidate of COVERS) {
    cover = await load(candidate)
    if (cover !== undefined) break
  }
  const missingImages: string[] = []
  for (const reference of content.paths) {
    if (!assets.has(reference) && await load(reference) === undefined) missingImages.push(reference)
  }
  const images = [...assets.values()]
  const revision = brandString<ArticleRevision>(createHash('sha256')
    .update(JSON.stringify([name, theme, markdown, cover?.path, images])).digest('hex'))
  const html = content.render((path) => {
    const image = assets.get(path)
    return image === undefined ? undefined : imageSrc(image)
  })
  return {
    preview: {
      title, markdown, html, coverSrc: cover === undefined ? null : imageSrc(cover), missingImages, revision,
      sourceVersion: brandString<ArticleSourceVersion>(sourceVersion),
    },
    draft: { title, markdown, cover: cover?.path ?? '', images },
  }
}

/**
 * Save original Markdown only if its filesystem version still matches the edit's base.
 * @param fs - Composed filesystem provider.
 * @param rootPath - Registered workspace root.
 * @param name - Direct article folder.
 * @param version - Filesystem version observed before editing.
 * @param markdown - Full replacement text.
 * @param limit - Maximum UTF-8 bytes accepted by the editor.
 * @param signal - Cancellation before publication.
 * @returns The version produced by the guarded write.
 */
export async function saveWorkspaceArticle(
  fs: FileSystem, rootPath: string, name: ArticleFolder, version: FsVersion, markdown: string, limit: number, signal: AbortSignal,
): Promise<FsVersion> {
  if (Buffer.byteLength(markdown, 'utf8') > limit || markdown.includes('\0')) throw new ArticleError('articleSaveFailed')
  try {
    const { source } = await sourceFile(fs, rootPath, name, signal)
    return (await fs.writeText(source, markdown, { kind: 'replaceIfVersion', version }, signal)).version
  } catch (cause: unknown) {
    signal.throwIfAborted()
    if (cause instanceof ArticleError || (cause instanceof HarnessError && cause.code === 'FS_STALE_VERSION')) {
      throw new ArticleError('articleChanged', cause)
    }
    throw new ArticleError('articleSaveFailed', cause)
  }
}

/**
 * Require the exact revision that the user chose to synchronize.
 * @param article - A fresh read of the workspace files.
 * @param expected - Revision shown to the author.
 * @returns Article and media input for upload.
 */
export function selectedDraft(article: WorkspaceArticle, expected: ArticleRevision): WeChatDraft {
  if (article.preview.revision !== expected) throw new ArticleError('articleChanged')
  if (article.preview.coverSrc === null || article.preview.missingImages.length !== 0) throw new WeChatError('missingImage')
  return article.draft
}
