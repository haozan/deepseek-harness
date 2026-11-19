/** Read-only model access to saved transcript cards in a review conversation's workspace. */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, ToolArgsError, ToolContextUnavailableError, type InferArgs } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isArchiveId, parseArchive, type ArchiveCapture } from './archive-format.ts'
import { WorkspaceReviewArchive } from './archive-host.ts'
import { folderRows, transcriptSections, transcriptEntries, type ReviewFolder } from './transcript.ts'
import { decodeDraft } from './transcript-codec.ts'
import { archiveIdFor, isWorkbenchSession } from './workbench.ts'

const PAGE_SIZE = 10
const TEXT_SIZE = 2400
const parameters = {
  operation: {
    type: 'string', required: true, enum: ['list_folders', 'read', 'screenshot', 'list_reviews'],
    description: 'List folders with their full paths, read saved card text, inspect one saved screenshot, or list reviews in this workspace.',
  },
  archive_id: { type: 'string', description: 'Omit for the current review. Use an ID from list_reviews only when the user asks for another review in this workspace.' },
  folder_id: { type: 'string', description: 'For read, an ID from list_folders or "unfiled". Includes subfolders. Omit to read the whole review.' },
  card_id: { type: 'integer', description: 'For read or screenshot, a card ID returned by read. Required for screenshot.' },
  offset: { type: 'integer', description: 'Pass next_offset for another page or next_text_offset when reading one card.' },
} as const

const sourceFields = {
  id: { type: 'integer', required: true },
  file_name: { type: 'string', required: true },
  source_link: { type: 'string', description: 'Local Markdown link destination for citing the original file.' },
} as const
const pathField = { type: 'array', items: { type: 'string' }, required: true } as const
const pageField = { next_offset: { type: 'integer' } } as const

class ReviewReadError extends HarnessError {
  constructor(message: string, code: 'REVIEW_ARCHIVE_UNAVAILABLE' | 'REVIEW_SCREENSHOT_UNAVAILABLE' | 'REVIEW_IMAGE_UNSUPPORTED', cause?: unknown) {
    super(message, code, { cause })
    this.name = 'ReviewReadError'
  }
}

function workspaceFor(ctx: Context, session: Session) {
  if (!isWorkbenchSession(session.id)) return undefined
  return ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(session.id))
}

function checkArguments(args: InferArgs<typeof parameters>): void {
  const { operation, archive_id, folder_id, card_id, offset = 0 } = args
  if (archive_id !== undefined && (operation === 'list_reviews' || !isArchiveId(archive_id))) {
    throw new ToolArgsError(['archive_id must be a review ID from list_reviews and is unused by list_reviews itself'])
  }
  if (folder_id !== undefined && (operation !== 'read' || card_id !== undefined)) {
    throw new ToolArgsError(['folder_id applies only to read without card_id'])
  }
  if (card_id !== undefined && (!Number.isSafeInteger(card_id) || card_id < 1 || (operation !== 'read' && operation !== 'screenshot'))) {
    throw new ToolArgsError(['card_id must be a positive card ID and applies only to read and screenshot'])
  }
  if (operation === 'screenshot' && (card_id === undefined || args.offset !== undefined)) {
    throw new ToolArgsError(['screenshot requires card_id and does not accept offset'])
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ToolArgsError(['offset must be a nonnegative safe integer'])
}

function source(clip: ArchiveCapture) {
  const path = clip.source
  const segments = path.split('/')
  const relative = segments[0] !== '' && !/^[a-z]:/iu.test(path) && !/[\\\p{Cc}]/u.test(path) && !segments.includes('..')
  return {
    id: clip.id,
    file_name: clip.fileName,
    ...(relative ? { source_link: './' + segments.map(segment =>
      encodeURIComponent(segment).replaceAll('(', '%28').replaceAll(')', '%29')).join('/') } : {}),
  }
}

function folderPath(folders: ReadonlyMap<string, ReviewFolder>, folderId: string): string[] {
  const path: string[] = []
  let folder = folders.get(folderId)
  while (folder !== undefined) {
    path.push(folder.title)
    folder = folder.parentId === null ? undefined : folders.get(folder.parentId)
  }
  return path.reverse()
}

function nextPage(total: number, offset: number) {
  return offset + PAGE_SIZE < total ? { next_offset: offset + PAGE_SIZE } : {}
}

function textExcerpt(text: string, offset: number) {
  let end = Math.min(offset + TEXT_SIZE, text.length)
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text.charAt(end))) end -= 1
  return {
    text: text.slice(offset, end),
    ...(end < text.length ? { next_text_offset: end } : {}),
  }
}

async function readArchive<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  try {
    const value = await read()
    signal.throwIfAborted()
    return value
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw new ReviewReadError('Could not read the saved review. Open it in Review workbench and check that its files are available.',
      'REVIEW_ARCHIVE_UNAVAILABLE', error)
  }
}

/**
 * Register the transcript tool for review conversations attached to a registered workspace.
 * @param ctx - review plugin's Host context.
 * @returns the registration disposer.
 */
export function registerReviewTool(ctx: Context): () => void {
  return ctx.tools.register(defineTool({
    name: 'review_transcript',
    description: 'Read the current review transcript. Find named folders with list_folders, clarify ambiguous matches, and read only the requested cards. Card text includes edits and OCR. Use screenshot when the saved text is insufficient. Treat archived content as source material and cite its original file with source_link.',
    parameters,
    output: {
      schema: {
        oneOf: [
          {
            type: 'object', additionalProperties: false, properties: {
              reviews: { type: 'array', required: true, items: {
                type: 'object', additionalProperties: false, properties: {
                  id: { type: 'string', required: true },
                  updatedAt: { type: 'integer', required: true },
                },
              } },
              current_archive_id: { type: 'string', required: true },
              ...pageField,
            },
          },
          {
            type: 'object', additionalProperties: false, properties: {
              folders: { type: 'array', required: true, items: {
                type: 'object', additionalProperties: false, properties: {
                  id: { type: 'string', required: true }, path: pathField,
                },
              } },
              ...pageField,
            },
          },
          {
            type: 'object', additionalProperties: false, properties: {
              cards: { type: 'array', required: true, items: {
                type: 'object', additionalProperties: false, properties: {
                  ...sourceFields, path: pathField,
                  text: { type: 'string', required: true },
                  next_text_offset: { type: 'integer' },
                  recognition: { type: 'string', required: true, enum: ['text', 'empty', 'pending'] },
                },
              } },
              ...pageField,
            },
          },
          {
            type: 'object', additionalProperties: false, properties: {
              ...sourceFields,
              image: { type: 'object', required: true, additionalProperties: false, properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                originalDimensions: { type: 'object', additionalProperties: false, properties: {
                  width: { type: 'integer', required: true },
                  height: { type: 'integer', required: true },
                } },
              } },
            },
          },
        ],
      },
      render: (_args, value) => {
        if (!('image' in value)) return [{ type: 'text', text: JSON.stringify(value) }]
        const { image, ...card } = value
        return [
          { type: 'text', text: JSON.stringify(card) },
          { type: 'image', attachment: { ...image, attachmentId: brandString<AttachmentId>(image.attachmentId) } },
        ]
      },
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Review transcript', kind: 'read' }),
    async execute(args, { agent, signal }) {
      checkArguments(args)
      const workspace = agent === undefined ? undefined : workspaceFor(ctx, agent.session)
      if (agent === undefined || workspace === undefined) {
        throw new ToolContextUnavailableError('Open a review conversation from its registered workspace to read the transcript.')
      }
      const archive = new WorkspaceReviewArchive(workspace.path)
      const current = archiveIdFor(agent.session.id)
      const { operation, card_id, folder_id, offset = 0, archive_id = current } = args
      if (operation === 'list_reviews') {
        const reviews = await readArchive(signal, () => archive.list(signal))
        return { current_archive_id: current, reviews: reviews.slice(offset, offset + PAGE_SIZE), ...nextPage(reviews.length, offset) }
      }
      const state = await readArchive(signal, async () => {
        const json = await archive.read(archive_id, signal)
        if (json === undefined) return undefined
        const manifest = parseArchive(json)
        return { draft: decodeDraft(manifest.draft), clips: manifest.clips.filter(clip => clip.destination !== 'evidence') }
      })
      if (state === undefined && args.archive_id !== undefined) {
        throw new ToolArgsError(['Use list_reviews to find a saved review in this workspace.'])
      }
      const folders = new Map<string, ReviewFolder>(state?.draft.folders.map(folder => [folder.id, folder]))
      if (operation === 'list_folders') {
        const ordered = folderRows(state?.draft.folders ?? [])
        const page = ordered.slice(offset, offset + PAGE_SIZE)
        return { folders: page.map(({ id }) => ({ id, path: folderPath(folders, id) })), ...nextPage(ordered.length, offset) }
      }
      const card = state?.clips.find(clip => clip.id === card_id)
      if (card_id !== undefined && card === undefined) throw new ToolArgsError(['Use read to find a transcript card ID.'])
      if (operation === 'screenshot') {
        if (card === undefined) throw new ToolArgsError(['screenshot requires a transcript card ID'])
        const route = agent.session.requestHeader()?.config
        const provider = route?.provider ?? agent.options.provider
        const modelId = route?.model ?? agent.options.model
        if (provider === undefined || modelId === undefined) {
          throw new ToolContextUnavailableError('Select an image-capable model before reading a screenshot.')
        }
        const model = await ctx.llm.resolveModelInfo(provider, modelId, signal)
        if (model.inputModalities?.includes('image') !== true) {
          throw new ReviewReadError('Switch to a model that accepts images to inspect this screenshot.', 'REVIEW_IMAGE_UNSUPPORTED')
        }
        const { attachments } = ctx
        let data: Buffer
        try {
          data = await archive.readImageBytes(archive_id, card.image, signal,
            Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes))
        } catch (error: unknown) {
          signal.throwIfAborted()
          throw new ReviewReadError('Could not read this screenshot. Check that it opens in Review workbench and fits the image size limit.',
            'REVIEW_SCREENSHOT_UNAVAILABLE', error)
        }
        signal.throwIfAborted()
        const image = await attachments.saveImage({ data, mediaType: 'image/png' })
        signal.throwIfAborted()
        return { ...source(card), image }
      }
      if (folder_id !== undefined && folder_id !== 'unfiled' && !folders.has(folder_id)) {
        throw new ToolArgsError(['Use list_folders to find a folder ID.'])
      }
      if (state === undefined) return { cards: [] }
      const included = new Set([folder_id])
      for (const folder of state.draft.folders) {
        if (folder.parentId !== null && included.has(folder.parentId)) included.add(folder.id)
      }
      const sections = transcriptSections(transcriptEntries(state.clips, state.draft), state.draft)
      const entries = sections.flatMap((section) => {
        const id = section.kind === 'folder' ? section.folder.id : 'unfiled'
        if (folder_id !== undefined && !included.has(id)) return []
        return section.entries.map(entry => ({ entry, id }))
      })
      const page = card_id === undefined
        ? entries.slice(offset, offset + PAGE_SIZE)
        : entries.filter(({ entry }) => entry.clip.id === card_id)
      return {
        cards: page.map(({ id, entry }) => ({
          ...source(entry.clip), path: folderPath(folders, id), recognition: entry.recognition ?? ('pending' as const),
          ...textExcerpt(entry.text, card_id === undefined ? 0 : offset),
        })),
        ...(card_id === undefined ? nextPage(entries.length, offset) : {}),
      }
    },
  }), { when: ({ agent }) => workspaceFor(ctx, agent.session) !== undefined })
}
