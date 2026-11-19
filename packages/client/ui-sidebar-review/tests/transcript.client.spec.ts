import { expect, it } from 'vitest'
import { exportTranscript } from '../src/client/export-transcript.ts'
import { editTranscript, EMPTY_DRAFT, folderRows, moveEntries, transcriptEntries } from '../src/transcript.ts'

const png = new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' })
const source = { sessionId: 'review', resourceAddress: 'dsh-resource://file/session/review/example', png }
const clips = [
  { ...source, id: 1, fileName: '.first' },
  { ...source, id: 2, fileName: 'next.scan.pdf' },
  { ...source, id: 3, fileName: 'new <image>.pdf' },
  { ...source, id: 4, fileName: 'transfer.pdf' },
]
const evidence = { id: 'folder:a', parentId: null, title: 'Evidence' } as const
const bank = { id: 'folder:b', parentId: evidence.id, title: 'Bank' } as const
const contract = { id: 'folder:c', parentId: null, title: 'Contract' } as const

it('exports folder headings in tree order followed by unfiled cards, preserving edits and images', async () => {
  let draft = editTranscript(EMPTY_DRAFT, { kind: 'createFolder', folder: evidence })
  draft = editTranscript(draft, { kind: 'createFolder', folder: contract })
  draft = editTranscript(draft, { kind: 'createFolder', folder: bank })
  draft = editTranscript(draft, { kind: 'renameFolder', id: bank.id, title: 'Bank <records>' })
  draft = editTranscript(draft, { kind: 'file', keys: ['clip:2', 'clip:1'], folderId: bank.id, destinationOrder: [] })
  draft = editTranscript(draft, { kind: 'file', keys: ['clip:4'], folderId: evidence.id, destinationOrder: [] })
  draft = editTranscript(draft, { kind: 'recognized', key: 'clip:2', value: 'Date: 1 May\nAmount: 100\n\n<script>note</script>' })
  draft = editTranscript(draft, { kind: 'recognized', key: 'clip:4', value: '' })
  draft = editTranscript(draft, { kind: 'text', key: 'clip:4', value: 'Manually added note' })
  const entries = transcriptEntries(clips, draft)
  expect(entries.map(row => row.key)).toEqual(['clip:2', 'clip:1', 'clip:4', 'clip:3'])
  expect(folderRows(draft.folders).map(row => [row.id, row.depth])).toEqual([[evidence.id, 0], [bank.id, 1], [contract.id, 0]])
  expect(folderRows(draft.folders, new Set([evidence.id])).map(row => row.id)).toEqual([evidence.id, contract.id])
  const labels = {
    title: 'Transcript', untitled: 'Untitled', unfiled: 'Unfiled',
    screenshot: 'Screenshot',
  }
  const output = await exportTranscript(entries, draft, { ...labels, mode: 'illustrated', includeSource: true })
  const html = await output.text()
  expect(html).toContain('<p class="text">【next.scan】 Date: 1 May\nAmount: 100\n\n&lt;script&gt;note&lt;/script&gt;</p>')
  expect(html.match(/data:image\/png;base64,AQID/gu)).toHaveLength(4)
  const ordered = ['<h2>Evidence</h2>', '【transfer】', '<h3>Bank &lt;records&gt;</h3>', '【next.scan】', '【.first】',
    '<h2>Contract</h2>', '<h2>Unfiled</h2>', '【new &lt;image&gt;】'].map(needle => html.indexOf(needle))
  expect(ordered.every((index, position) => index >= 0 && (position === 0 || index > ordered[position - 1]!))).toBe(true)
  const withoutSource = await (await exportTranscript(entries, draft, { ...labels, mode: 'illustrated', includeSource: false })).text()
  expect(withoutSource).toContain('<p class="text">Date: 1 May\nAmount: 100\n\n&lt;script&gt;note&lt;/script&gt;</p>')
  expect(withoutSource).not.toMatch(/next\.scan|\.first|new &lt;image&gt;|【/u)
  expect(withoutSource.match(/alt="Screenshot"/gu)).toHaveLength(4)
  const textOnly = await (await exportTranscript(entries, draft, { ...labels, mode: 'text', includeSource: true })).text()
  expect(textOnly.match(/data:image\/png;base64,AQID/gu)).toHaveLength(3)
  expect(textOnly).toContain('<article><p class="text">【next.scan】 Date: 1 May\nAmount: 100\n\n&lt;script&gt;note&lt;/script&gt;</p></article>')
  expect(textOnly).toContain('<article><img src="data:image/png;base64,AQID" alt="Screenshot"><p class="text">【transfer】 Manually added note</p>')
  expect(textOnly).toContain('<article><img src="data:image/png;base64,AQID" alt="Screenshot"><p class="text">【.first】</p>')
})

it('files a batch at the end of the destination without reordering existing destination cards on a retry', () => {
  let draft = editTranscript(EMPTY_DRAFT, { kind: 'createFolder', folder: evidence })
  draft = editTranscript(draft, { kind: 'file', keys: ['clip:2', 'clip:1'], folderId: evidence.id, destinationOrder: [] })
  const back = { kind: 'file', keys: ['clip:2', 'clip:1'], folderId: null, destinationOrder: ['clip:3', 'clip:4'] } as const
  draft = editTranscript(draft, back)
  expect(draft.assignments).toEqual({})
  expect(draft.order).toEqual(['clip:3', 'clip:4', 'clip:2', 'clip:1'])
  expect(editTranscript(draft, back)).toBe(draft)
  const order = moveEntries(draft.order, ['clip:2', 'clip:1'], 0)
  expect(order).toEqual(['clip:2', 'clip:1', 'clip:3', 'clip:4'])
  expect(moveEntries(order, ['clip:2'], 1)).toBe(order)
  expect(editTranscript(draft, { kind: 'order', order: ['clip:1', 'clip:3'] }).order).toEqual(['clip:1', 'clip:4', 'clip:2', 'clip:3'])
})

it('moves folders among siblings while keeping their children and assigned cards', () => {
  const receipts = { id: 'folder:d', parentId: evidence.id, title: 'Receipts' } as const
  const draft = {
    ...EMPTY_DRAFT,
    folders: [evidence, contract, bank, receipts],
    assignments: { 'clip:1': bank.id },
  }
  const moved = editTranscript(draft, { kind: 'moveFolder', id: contract.id, anchor: evidence.id, position: 'before' })
  expect(moved.folders).toEqual([contract, evidence, bank, receipts])
  const reordered = editTranscript(moved, { kind: 'moveFolder', id: bank.id, anchor: receipts.id, position: 'after' })
  expect(reordered.folders).toEqual([contract, evidence, receipts, bank])
  expect(reordered.assignments).toBe(draft.assignments)
  expect(editTranscript(reordered, { kind: 'moveFolder', id: bank.id, anchor: contract.id, position: 'before' })).toBe(reordered)
})

it('removes a branch and appends its cards to Unfiled while preserving their text', () => {
  const draft = {
    ...EMPTY_DRAFT,
    folders: [evidence, bank, contract],
    assignments: { 'clip:1': evidence.id, 'clip:2': bank.id, 'clip:4': contract.id },
    order: ['clip:2', 'clip:4', 'clip:1'] as const,
    texts: { 'clip:2': 'Extracted text', 'clip:1': 'Note to check' },
    recognized: { 'clip:2': 'text' } as const,
  }
  const edit = { kind: 'deleteFolder', id: evidence.id, unfiledOrder: ['clip:3'] } as const
  const next = editTranscript(draft, edit)
  expect(next.folders).toEqual([contract])
  expect(next.assignments).toEqual({ 'clip:4': contract.id })
  expect(next.order).toEqual(['clip:4', 'clip:3', 'clip:2', 'clip:1'])
  expect(next.texts).toBe(draft.texts)
  expect(next.recognized).toBe(draft.recognized)
  expect(editTranscript(next, edit)).toBe(next)
  expect(editTranscript(next, { kind: 'file', keys: ['clip:4'], folderId: bank.id, destinationOrder: [] })).toBe(next)
  expect(editTranscript(next, { kind: 'createFolder', folder: { ...bank, id: 'folder:aa' } })).toBe(next)
})
