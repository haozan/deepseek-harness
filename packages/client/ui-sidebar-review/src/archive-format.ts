/** Versioned review manifest shared by the Host archive and the Desktop client. */

export const ARCHIVE_FOLDER = '阅卷数据'

/** A committed card and the workspace-relative or absolute address of its original file. */
export interface ArchiveCapture {
  readonly id: number
  /** Client-generated identity retained across retries of the same crop. */
  readonly captureId?: string
  readonly source: string
  readonly fileName: string
  readonly image: string
  readonly destination?: 'evidence'
  readonly location?: unknown
  readonly sourceDigest?: string
}

/** Committed review manifest. Image keys address immutable files in the same archive. */
export interface ReviewArchive {
  readonly version: 1
  readonly revision: number
  readonly updatedAt: number
  readonly clips: readonly ArchiveCapture[]
  readonly draft?: unknown
}

/**
 * Check the portable review directory name.
 * @param id - candidate name.
 * @returns whether the name is a supported single directory component.
 */
export function isArchiveId(id: string): boolean {
  return /^(?:review-workbench-|session-)[a-zA-Z0-9-]{1,120}$/u.test(id)
}

/**
 * Check a screenshot's content key.
 * @param key - candidate PNG reference.
 * @returns whether the key is a canonical SHA-256 digest.
 */
export function isImageKey(key: string): boolean {
  return /^[a-f0-9]{64}$/u.test(key)
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function capture(value: unknown): value is ArchiveCapture {
  return object(value) && natural(value.id) && value.id > 0
    && (value.captureId === undefined || (typeof value.captureId === 'string'
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.captureId)))
    && typeof value.source === 'string' && value.source !== '' && !value.source.includes('\0')
    && typeof value.fileName === 'string' && typeof value.image === 'string' && isImageKey(value.image)
    && (value.sourceDigest === undefined || (typeof value.sourceDigest === 'string' && isImageKey(value.sourceDigest)))
    && (value.destination === undefined || value.destination === 'evidence')
}

/**
 * Parse a manifest. Refuse unsupported versions and duplicate card identities.
 * @param json - stored or transported manifest.
 * @returns a validated manifest.
 */
export function parseArchive(json: string): ReviewArchive {
  const value: unknown = JSON.parse(json)
  if (!object(value) || value.version !== 1 || !natural(value.revision) || value.revision < 1 || !natural(value.updatedAt)
    || !Array.isArray(value.clips) || !value.clips.every(capture)
    || new Set(value.clips.map(clip => clip.id)).size !== value.clips.length) {
    throw new Error('Invalid review archive manifest')
  }
  const captureIds = value.clips.flatMap(clip => clip.captureId === undefined ? [] : [clip.captureId])
  if (new Set(captureIds).size !== captureIds.length) throw new Error('Duplicate review capture identity')
  return { version: 1, revision: value.revision, updatedAt: value.updatedAt, clips: value.clips, draft: value.draft }
}
