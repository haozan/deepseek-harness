/** Portable review I/O and one-time import from older Desktop profiles. */

import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { isArchiveId, parseArchive, type ArchiveCapture, type ReviewArchive } from '../archive-format.ts'
import type { ArchiveSourceState, ArchiveSummary } from '../types.ts'
import { decodeDraft, encodeDraft } from '../transcript-codec.ts'
import * as legacy from './clip-store.ts'
import { imageBase64 } from './image-base64.ts'
import { editTranscript, type TranscriptDraft, type TranscriptEdit } from '../transcript.ts'
import { archiveIdFor } from '../workbench.ts'

type Target = { readonly workspace: WorkspaceView; readonly id: string }
type Capture = Omit<legacy.ReviewClip, 'id'> & { readonly captureId?: string }
type ReviewFrame = Pick<legacy.ReviewClip, 'id' | 'destination'> & { readonly location?: legacy.ReviewClip['location'] }

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

function sourcePath(resourceAddress: string, workspace: string): string {
  const source = parseFileAddress(resourceAddress)
  if (source === undefined) throw new Error('Invalid review source address')
  const path = source.path.replaceAll('\\', '/')
  const root = workspace.replaceAll('\\', '/').replace(/\/+$/u, '')
  const drive = /^[A-Za-z]:/u.test(root)
  const matches = (candidate: string): string => drive ? candidate.toLowerCase() : candidate
  return matches(path).startsWith(matches(`${root}/`)) ? path.slice(root.length + 1) : path
}

/** Per-Session access to the review file associated with its registered workspace. */
export class ReviewArchiveStore {
  private readonly importing = new Map<string, Promise<void>>()
  private readonly images = new Map<string, Promise<Blob>>()
  private readonly sources = new Map<string, ArchiveSourceState>()
  private readonly sourceReads = new Map<string, Promise<ArchiveSourceState | null>>()

  /**
   * @param remote - operations scoped by the Host to a registered workspace.
   * @param workspaceFor - current registration for a local Session.
   * @param updatedAtFor - last known activity of a legacy Session.
   * @param signal - review plugin lifetime.
   */
  constructor(
    private readonly remote: ClientRemote['documentReview'],
    private readonly workspaceFor: (sessionId: string) => WorkspaceView | undefined,
    private readonly updatedAtFor: (sessionId: SessionId) => number | undefined,
    private readonly signal: AbortSignal,
  ) {}

  private target(sessionId: string): Target | undefined {
    const workspace = this.workspaceFor(sessionId)
    return workspace === undefined ? undefined : { workspace, id: archiveIdFor(sessionId) }
  }

  private async read(target: Target): Promise<ReviewArchive | undefined> {
    const value = unwrap(await this.remote.readArchive(target.workspace.workspaceId, target.id))
    return value === null ? undefined : parseArchive(value)
  }

  private async commit(
    target: Target, previous: ReviewArchive | undefined, next: Pick<ReviewArchive, 'clips' | 'draft'>, updatedAt = Date.now(),
  ): Promise<boolean> {
    const expected = previous?.revision ?? 0
    const manifest: ReviewArchive = { version: 1, revision: expected + 1, updatedAt, ...next }
    return unwrap(await this.remote.commitArchive(target.workspace.workspaceId, target.id, expected, JSON.stringify(manifest)))
  }

  private async upload(target: Target, png: Blob): Promise<string> {
    return unwrap(await this.remote.putImage(target.workspace.workspaceId, target.id, await imageBase64(png)))
  }

  private sourceState(target: Target, source: string, expected?: ArchiveSourceState): Promise<ArchiveSourceState | null> {
    const key = `${target.workspace.workspaceId}/${source}`
    const pending = this.sourceReads.get(key)
    if (pending !== undefined) return pending
    const previous = this.sources.get(key) ?? expected
    const request = (async () => {
      const state = unwrap(await this.remote.sourceState(target.workspace.workspaceId, source, previous?.version ?? '', this.signal))
      if (state === null) return null
      const known = state.version === previous?.version && state.digest === undefined ? previous : state
      this.sources.set(key, known)
      return known
    })().finally(() => { this.sourceReads.delete(key) })
    this.sourceReads.set(key, request)
    return request
  }

  private async descriptor(target: Target, clip: Capture, image: string): Promise<Omit<ArchiveCapture, 'id'>> {
    const source = sourcePath(clip.resourceAddress, target.workspace.path)
    const state = clip.location === undefined ? null : await this.sourceState(target, source)
    const digest = state?.version === clip.location?.version ? state?.digest : undefined
    return {
      image, source, fileName: clip.fileName,
      ...clip.captureId === undefined ? {} : { captureId: clip.captureId },
      ...clip.destination === undefined ? {} : { destination: clip.destination },
      ...clip.location === undefined ? {} : { location: clip.location },
      ...digest === undefined ? {} : { sourceDigest: digest },
    }
  }

  private async locate(target: Target, capture: ArchiveCapture): Promise<legacy.ReviewClip['location']> {
    const location = capture.location
    if (!legacy.captureLocation(location)) return undefined
    if (capture.sourceDigest === undefined) return location
    const state = await this.sourceState(target, capture.source, { version: location.version, digest: capture.sourceDigest })
    return state?.digest === capture.sourceDigest ? { ...location, version: state.version } : location
  }

  private async importLegacy(target: Target, sessionId: SessionId): Promise<void> {
    const key = `${target.workspace.workspaceId}/${target.id}`
    const inFlight = this.importing.get(key)
    if (inFlight !== undefined) return inFlight
    const attempt = (async () => {
      if (!(await legacy.readSavedReviews([sessionId])).has(sessionId) || await this.read(target) !== undefined) return
      const [clips, draft] = await Promise.all([legacy.listClips(sessionId), legacy.readDraft(sessionId)])
      const saved: ArchiveCapture[] = []
      for (const clip of clips) {
        saved.push({ id: clip.id, ...await this.descriptor(target, clip, await this.upload(target, clip.png)) })
      }
      await this.commit(target, undefined, { clips: saved, draft: encodeDraft(draft) }, this.updatedAtFor(sessionId))
    })().finally(() => { this.importing.delete(key) })
    this.importing.set(key, attempt)
    await attempt
  }

  private async current(target: Target, sessionId: string): Promise<ReviewArchive | undefined> {
    const archive = await this.read(target)
    if (archive !== undefined || target.id !== sessionId) return archive
    await this.importLegacy(target, SessionId(sessionId))
    return await this.read(target)
  }

  /**
   * Discover portable reviews and copy existing browser records into this workspace once.
   * @param workspace - registered workspace.
   * @param sessionIds - locally known Sessions eligible for import.
   * @returns saved review identities in descending order of modification.
   */
  async list(workspace: WorkspaceView, sessionIds: readonly SessionId[]): Promise<ArchiveSummary[]> {
    const listed = unwrap(await this.remote.listArchives(workspace.workspaceId))
    const present = new Set(listed.map(archive => archive.id))
    const candidates = sessionIds.filter(id => isArchiveId(id) && archiveIdFor(id) === id && !present.has(id))
    const saved = await legacy.readSavedReviews(candidates)
    if (saved.size === 0) return listed
    for (const id of saved) await this.importLegacy({ workspace, id }, id)
    return unwrap(await this.remote.listArchives(workspace.workspaceId))
  }

  /**
   * Read the review's current edited transcript.
   * @param sessionId - local Session reading the review.
   * @returns saved transcript.
   */
  async readDraft(sessionId: string): Promise<TranscriptDraft> {
    const target = this.target(sessionId)
    return target === undefined
      ? legacy.readDraft(sessionId)
      : decodeDraft((await this.current(target, sessionId))?.draft)
  }

  /**
   * Apply an edit to the latest committed draft.
   * @param sessionId - local Session editing the review.
   * @param edit - change to apply.
   * @returns the resulting committed draft.
   */
  async writeDraft(sessionId: string, edit: TranscriptEdit): Promise<TranscriptDraft> {
    const target = this.target(sessionId)
    if (target === undefined) throw new Error('Associate the review with a workspace before saving')
    for (let attempt = 0; attempt < 4; attempt++) {
      const archive = await this.current(target, sessionId)
      const draft = editTranscript(decodeDraft(archive?.draft), edit)
      if (await this.commit(target, archive, { clips: archive?.clips ?? [], draft: encodeDraft(draft) })) return draft
    }
    throw new Error('The review was changed by another writer')
  }

  /**
   * Commit a screenshot with a card identity after writing its PNG.
   * @param clip - screenshot and source for the local Session.
   * @returns the committed card id.
   */
  async saveClip(clip: Capture): Promise<number> {
    const target = this.target(clip.sessionId)
    if (target === undefined) throw new Error('Associate the review with a workspace before taking screenshots')
    let descriptor: Omit<ArchiveCapture, 'id'> | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      const archive = await this.current(target, clip.sessionId)
      const clips = archive?.clips ?? []
      const saved = clip.captureId === undefined ? undefined : clips.find(item => item.captureId === clip.captureId)
      if (saved !== undefined) return saved.id
      descriptor ??= await this.descriptor(target, clip, await this.upload(target, clip.png))
      const id = clips.reduce((max, item) => Math.max(max, item.id), 0) + 1
      const next = { id, ...descriptor }
      if (await this.commit(target, archive, { clips: [...clips, next], draft: archive?.draft })) return id
    }
    throw new Error('The review was changed by another writer')
  }

  private loadImage(target: Target, key: string): Promise<Blob> {
    const cacheKey = `${target.workspace.workspaceId}/${target.id}/${key}`
    const pending = this.images.get(cacheKey)
    if (pending !== undefined) return pending
    const read = (async () => {
      const base64 = unwrap(await this.remote.readImage(target.workspace.workspaceId, target.id, key))
      const bytes = Uint8Array.from(atob(base64), byte => byte.charCodeAt(0))
      return new Blob([bytes], { type: 'image/png' })
    })().finally(() => { this.images.delete(cacheKey) })
    this.images.set(cacheKey, read)
    return read
  }

  /**
   * Read saved captures with source addresses rebound to the local Session.
   * @param sessionId - local Session displaying the review.
   * @param destination - capture group to load.
   * @returns review clips with their PNGs.
   */
  async listClips(sessionId: string, destination?: 'evidence'): Promise<readonly legacy.ReviewClip[]> {
    const target = this.target(sessionId)
    if (target === undefined) return (await legacy.listClips(sessionId)).filter(clip => clip.destination === destination)
    const archive = await this.current(target, sessionId)
    return await Promise.all((archive?.clips ?? []).filter(clip => clip.destination === destination).map(async (clip) => {
      const [png, location] = await Promise.all([this.loadImage(target, clip.image), this.locate(target, clip)])
      return {
        id: clip.id, sessionId, fileName: clip.fileName, resourceAddress: sessionFileAddress(sessionId, clip.source), png,
        ...clip.destination === undefined ? {} : { destination: clip.destination },
        ...location === undefined ? {} : { location },
      }
    }))
  }

  /**
   * Read rectangle anchors for the opened resource without loading the PNGs.
   * @param sessionId - local Session displaying the source.
   * @param address - live preview address.
   * @returns the saved captures that point to that source.
   */
  async frames(sessionId: string, address: string): Promise<readonly ReviewFrame[]> {
    const target = this.target(sessionId)
    if (target === undefined) return (await legacy.listClips(sessionId)).filter(clip => clip.resourceAddress === address)
    const source = sourcePath(address, target.workspace.path)
    const archive = await this.current(target, sessionId)
    return await Promise.all((archive?.clips ?? []).filter(clip => clip.source === source).map(async clip => ({
      id: clip.id, location: await this.locate(target, clip), ...clip.destination === undefined ? {} : { destination: clip.destination },
    })))
  }
}
