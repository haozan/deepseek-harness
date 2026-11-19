/** Workspace archive publication, revision checks, and independent copies. */

import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { ARCHIVE_FOLDER, parseArchive } from '../src/archive-format.ts'
import { WorkspaceReviewArchive } from '../src/archive-host.ts'

const ID = 'review-workbench-portable-test'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII='

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-review-archive-'))
  onTestFinished(() => rm(path, { recursive: true, force: true }))
  return path
}

it('opens a copied archive from its manifest and PNG without the original profile', async () => {
  const original = await root()
  const copied = await root()
  const writer = new WorkspaceReviewArchive(original)
  const image = await writer.putImage(ID, PNG)
  expect(await writer.list()).toEqual([])
  const clip = { id: 1, source: '卷宗/第一页.pdf', fileName: '第一页.pdf', image, destination: 'evidence' }
  const draft = { version: 3, order: [], folders: [], assignments: {}, extracts: { 'clip:1': 'Reviewed text' }, notes: {} }
  const manifest = (revision: number) => JSON.stringify({ version: 1, revision, updatedAt: revision, clips: [clip], draft })
  expect(await writer.commit(ID, 0, manifest(1))).toBe(true)
  expect(await writer.commit(ID, 0, manifest(1))).toBe(false)
  expect(await writer.commit(ID, 1, manifest(2))).toBe(true)
  await cp(join(original, ARCHIVE_FOLDER), join(copied, ARCHIVE_FOLDER), { recursive: true })
  const reader = new WorkspaceReviewArchive(copied)
  expect(await reader.list()).toEqual([{ id: ID, updatedAt: 2 }])
  expect(parseArchive(await reader.read(ID) ?? '').clips).toEqual([clip])
  expect(await reader.readImage(ID, image)).toBe(PNG)
  const previous = parseArchive(await readFile(join(copied, ARCHIVE_FOLDER, ID, 'review.previous.json'), 'utf8'))
  expect(previous).toMatchObject({ revision: 1, draft, clips: [clip] })
})

it('preserves the complete capture list and previous revision under concurrent commits', async () => {
  const home = await root()
  const archive = new WorkspaceReviewArchive(home)
  const image = await archive.putImage(ID, PNG)
  const transcript = { id: 1, source: 'record.pdf', fileName: 'record.pdf', image }
  const evidence = { id: 2, source: 'exhibit.pdf', fileName: 'exhibit.pdf', image, destination: 'evidence' }
  const initial = { version: 1, revision: 1, updatedAt: 1, clips: [transcript, evidence] }
  expect(await archive.commit(ID, 0, JSON.stringify(initial))).toBe(true)
  const commit = (title: string) => archive.commit(ID, 1, JSON.stringify({
    ...initial,
    revision: 2,
    draft: { version: 3, order: [], folders: [{ id: 'folder:a', parentId: null, title }], assignments: {}, extracts: {}, notes: {} },
  }))
  expect((await Promise.all([commit('First'), commit('Second')])).sort()).toEqual([false, true])
  await expect(archive.commit(ID, 2, JSON.stringify({ ...initial, revision: 3, clips: [transcript] })))
    .rejects.toThrow('captures must be preserved')
  expect(parseArchive(await archive.read(ID) ?? '')).toMatchObject({ revision: 2, clips: [transcript, evidence] })
  expect(parseArchive(await readFile(join(home, ARCHIVE_FOLDER, ID, 'review.previous.json'), 'utf8'))).toEqual(initial)
  expect(await archive.readImage(ID, image)).toBe(PNG)
})

it('does not replace an unreadable or missing manifest with an empty review', async () => {
  const home = await root()
  const archive = new WorkspaceReviewArchive(home)
  const initial = { version: 1, revision: 1, updatedAt: 1, clips: [] }
  const next = { ...initial, revision: 2 }
  expect(await archive.commit(ID, 0, JSON.stringify(initial))).toBe(true)
  expect(await archive.commit(ID, 1, JSON.stringify(next))).toBe(true)
  const path = join(home, ARCHIVE_FOLDER, ID, 'review.json')
  await writeFile(path, '{')
  await expect(archive.commit(ID, 2, JSON.stringify({ ...next, revision: 3 }))).rejects.toThrow(SyntaxError)
  expect(await readFile(path, 'utf8')).toBe('{')
  await rm(path)
  await expect(archive.read(ID)).rejects.toThrow('previous revision is available')
  await expect(archive.commit(ID, 0, JSON.stringify(initial))).rejects.toThrow('previous revision is available')
  expect(parseArchive(await readFile(join(home, ARCHIVE_FOLDER, ID, 'review.previous.json'), 'utf8'))).toEqual(initial)
})

it('does not publish an archive that references a missing screenshot', async () => {
  const archive = new WorkspaceReviewArchive(await root())
  await expect(archive.commit(ID, 0, JSON.stringify({
    version: 1, revision: 1, updatedAt: 1,
    clips: [{ id: 1, source: 'case.pdf', fileName: 'case.pdf', image: 'a'.repeat(64) }],
  }))).rejects.toThrow('screenshot directory is missing')
  expect(await archive.list()).toEqual([])
})

it.skipIf(process.platform === 'win32')('rejects an archive directory redirected outside the workspace', async () => {
  const home = await root()
  const outside = await root()
  await symlink(outside, join(home, ARCHIVE_FOLDER), 'dir')
  const archive = new WorkspaceReviewArchive(home)
  await expect(archive.list()).rejects.toThrow('not a regular directory')
  await expect(archive.putImage(ID, PNG)).rejects.toThrow('not a regular directory')
})
