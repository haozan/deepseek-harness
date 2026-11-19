/** Filesystem operations for one registered workspace's portable review archives. */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ARCHIVE_FOLDER, isArchiveId, isImageKey, parseArchive } from './archive-format.ts'
import { decodeDraft } from './transcript-codec.ts'
import type { ArchiveSummary } from './types.ts'

const MANIFEST = 'review.json'
const PREVIOUS_MANIFEST = 'review.previous.json'
const PRIVATE_DURABLE_WRITE = { mode: 0o600, dirMode: 0o700, durable: true } as const
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await using handle = await open(path, 'r')
  await handle.sync()
}

async function directory(path: string, create: boolean): Promise<string | undefined> {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
  }
  const stat = await lstat(path).catch((error: unknown) => {
    if (missing(error) && !create) return undefined
    throw error
  })
  if (stat === undefined) return undefined
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Review archive path is not a regular directory')
  if (create) await syncDirectory(dirname(path))
  return path
}

async function regularFile(path: string, signal?: AbortSignal, maxBytes = Infinity): Promise<Buffer | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Review archive entry is not a regular file')
    if (stat.size > maxBytes) throw new Error('Review archive entry exceeds the byte limit')
    return await readFile(path, { signal })
  } catch (error: unknown) {
    if (missing(error)) return undefined
    throw error
  }
}

/** Files named by validated archive identifiers under the supplied workspace. */
export class WorkspaceReviewArchive {
  /** @param workspace - approved directory of the registered workspace. */
  constructor(private readonly workspace: string) {}

  /**
   * Resolve only regular files whose targets are inside the workspace.
   * @param source - source path relative to the workspace.
   * @returns the real file path, or undefined for an unavailable or external source.
   */
  async sourceFile(source: string): Promise<string | undefined> {
    if (isAbsolute(source) || /^[A-Za-z]:/u.test(source) || source.startsWith('\\') || source.includes('\0')) return undefined
    const root = await realpath(this.workspace)
    const inside = (path: string): boolean => {
      const local = relative(root, path)
      return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
    }
    const requested = resolve(root, source)
    if (!inside(requested)) return undefined
    try {
      const file = await realpath(requested)
      return inside(file) && (await lstat(file)).isFile() ? file : undefined
    } catch (error: unknown) {
      if (missing(error)) return undefined
      throw error
    }
  }

  /**
   * Hash a resolved source without retaining large originals in memory.
   * @param file - regular file already confined to the workspace.
   * @param signal - caller cancellation.
   * @returns SHA-256 of the original bytes.
   */
  async digestSource(file: string, signal: AbortSignal): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file, { signal })) {
      const bytes: unknown = chunk
      if (!Buffer.isBuffer(bytes)) throw new Error('Review source stream did not return bytes')
      hash.update(bytes)
    }
    return hash.digest('hex')
  }

  private async root(create: boolean): Promise<string | undefined> {
    return directory(join(await realpath(this.workspace), ARCHIVE_FOLDER), create)
  }

  private async archive(id: string, create: boolean): Promise<string | undefined> {
    if (!isArchiveId(id)) throw new Error('Invalid review archive id')
    const root = await this.root(create)
    return root === undefined ? undefined : directory(join(root, id), create)
  }

  private async manifest(path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    const current = await regularFile(join(path, MANIFEST), signal)
    if (current === undefined && await regularFile(join(path, PREVIOUS_MANIFEST), signal) !== undefined) {
      throw new Error('The current review manifest is missing. A previous revision is available.')
    }
    return current
  }

  /**
   * List reviews with a committed manifest.
   * @param signal - optional caller cancellation.
   * @returns committed archives in the workspace, ordered by the last saved change.
   */
  async list(signal?: AbortSignal): Promise<ArchiveSummary[]> {
    const root = await this.root(false)
    if (root === undefined) return []
    const entries = await readdir(root, { withFileTypes: true })
    const archives: ArchiveSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isArchiveId(entry.name)) continue
      signal?.throwIfAborted()
      const json = await this.read(entry.name, signal)
      if (json !== undefined) archives.push({ id: entry.name, updatedAt: parseArchive(json).updatedAt })
    }
    return archives.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Read the committed review metadata.
   * @param id - review identity.
   * @param signal - optional caller cancellation.
   * @returns versioned JSON, or undefined before the first committed edit.
   */
  async read(id: string, signal?: AbortSignal): Promise<string | undefined> {
    const archive = await this.archive(id, false)
    return archive === undefined ? undefined : (await this.manifest(archive, signal))?.toString('utf8')
  }

  /**
   * Replace the manifest if its previous revision still matches.
   * @param id - review identity.
   * @param expected - previous revision, or zero for an unpublished archive.
   * @param json - next manifest.
   * @returns whether the replacement committed.
   */
  async commit(id: string, expected: number, json: string): Promise<boolean> {
    const manifest = parseArchive(json)
    decodeDraft(manifest.draft)
    if (manifest.revision !== expected + 1) throw new Error('Invalid review archive revision')
    const archive = await this.archive(id, true)
    if (archive === undefined) throw new Error('Review archive directory is unavailable')
    const path = join(archive, MANIFEST)
    return withFileLock(path, async () => {
      const current = await this.manifest(archive)
      const previous = current === undefined ? undefined : parseArchive(current.toString('utf8'))
      if ((previous?.revision ?? 0) !== expected) return false
      decodeDraft(previous?.draft)
      if (previous?.clips.some((clip, index) => !isDeepStrictEqual(clip, manifest.clips[index])) === true) {
        throw new Error('Committed review captures must be preserved in capture order')
      }
      const images = await directory(join(archive, 'screenshots'), false)
      for (const key of new Set(manifest.clips.map(clip => clip.image))) {
        if (images === undefined) throw new Error('Review archive screenshot directory is missing')
        const stat = await lstat(join(images, `${key}.png`))
        if (!stat.isFile()) throw new Error('Review archive screenshot is missing')
      }
      if (current !== undefined) await writeFileAtomic(join(archive, PREVIOUS_MANIFEST), current, PRIVATE_DURABLE_WRITE)
      await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`, PRIVATE_DURABLE_WRITE)
      return true
    })
  }

  /**
   * Store an immutable PNG by content hash before the manifest references it.
   * @param id - review identity.
   * @param png - base64 PNG bytes.
   * @returns the screenshot key.
   */
  async putImage(id: string, png: string): Promise<string> {
    const bytes = Buffer.from(png, 'base64')
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || bytes.toString('base64') !== png) {
      throw new Error('Invalid review screenshot')
    }
    const key = createHash('sha256').update(bytes).digest('hex')
    const archive = await this.archive(id, true)
    const images = archive === undefined ? undefined : await directory(join(archive, 'screenshots'), true)
    if (images === undefined) throw new Error('Review screenshot directory is unavailable')
    const path = join(images, `${key}.png`)
    const existing = await regularFile(path)
    if (existing === undefined) await writeFileAtomic(path, bytes, PRIVATE_DURABLE_WRITE)
    else if (existing.length !== bytes.length || !timingSafeEqual(existing, bytes)) throw new Error('Review screenshot was modified')
    else await syncDirectory(images)
    return key
  }

  /**
   * Read one committed or staged PNG.
   * @param id - review identity.
   * @param key - screenshot content hash.
   * @returns base64 PNG bytes.
   */
  async readImage(id: string, key: string): Promise<string> {
    return (await this.readImageBytes(id, key)).toString('base64')
  }

  /**
   * Read and verify one PNG against its committed content hash.
   * @param id - review identity.
   * @param key - screenshot content hash.
   * @param signal - optional caller cancellation.
   * @param maxBytes - optional attachment byte limit.
   * @returns the verified PNG bytes.
   */
  async readImageBytes(id: string, key: string, signal?: AbortSignal, maxBytes?: number): Promise<Buffer> {
    if (!isImageKey(key)) throw new Error('Invalid review screenshot key')
    const archive = await this.archive(id, false)
    const images = archive === undefined ? undefined : await directory(join(archive, 'screenshots'), false)
    const bytes = images === undefined ? undefined : await regularFile(join(images, `${key}.png`), signal, maxBytes)
    if (bytes === undefined || createHash('sha256').update(bytes).digest('hex') !== key) {
      throw new Error('Review archive screenshot is missing or was modified')
    }
    return bytes
  }
}
