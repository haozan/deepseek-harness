/** A self-contained, printable HTML transcript with optional embedded source screenshots. */

import { imageBase64 } from './image-base64.ts'
import type { ReviewClip } from './clip-store.ts'
import { cardSourceLabel, transcriptSections, type TranscriptDraft, type TranscriptEntry } from '../transcript.ts'

/** Include every screenshot, or include screenshots only where recognition has no text. */
export type TranscriptExportMode = 'illustrated' | 'text'

interface ExportOptions {
  readonly title: string
  readonly untitled: string
  readonly unfiled: string
  readonly screenshot: string
  readonly includeSource: boolean
  readonly mode: TranscriptExportMode
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function html(value: string): string {
  return value.replace(/[&<>"']/gu, match => ENTITIES[match] ?? match)
}

/**
 * Render an offline transcript with folder headings and unfiled cards at the end.
 * @param entries - every card in its saved order.
 * @param draft - folder hierarchy and card assignments.
 * @param options - localized labels, image mode, and whether to prefix card text with sources.
 * @returns the complete HTML file.
 */
export async function exportTranscript(
  entries: readonly TranscriptEntry<ReviewClip>[],
  draft: TranscriptDraft,
  options: ExportOptions,
): Promise<Blob> {
  const body: string[] = []
  const appendCard = async ({ clip, text, recognition }: TranscriptEntry<ReviewClip>): Promise<void> => {
    const screenshot = options.mode === 'illustrated' || recognition !== 'text'
      ? `<img src="data:image/png;base64,${await imageBase64(clip.png)}" alt="${html(options.screenshot)}">` : ''
    const source = options.includeSource ? cardSourceLabel(clip.fileName) : ''
    const content = text.trim() === '' ? source : source === '' ? text : `${source} ${text}`
    body.push(`<article>${screenshot}`
      + (content === '' ? '' : `<p class="text">${html(content)}</p>`)
      + '</article>')
  }
  for (const section of transcriptSections(entries, draft)) {
    if (section.kind === 'folder') {
      const level = section.folder.depth + 2
      const title = html(section.folder.title.trim() || options.untitled)
      body.push(level <= 6 ? `<h${level}>${title}</h${level}>` : `<p class="deep-heading" role="heading" aria-level="${level}">${title}</p>`)
    } else if (section.heading) {
      body.push(`<h2>${html(options.unfiled)}</h2>`)
    }
    for (const entry of section.entries) await appendCard(entry)
  }
  return new Blob([
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">\n',
    `<title>${html(options.title)}</title><style>body{max-width:48rem;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif;color:#202124}article{border-top:1px solid #ddd;padding:1rem 0}img{display:block;max-width:100%;max-height:60vh}.text{white-space:pre-wrap;overflow-wrap:anywhere}.deep-heading{font-weight:600}@media print{img{break-inside:avoid}h2,h3,h4,h5,h6,.deep-heading{break-after:avoid}}</style></head><body><h1>${html(options.title)}</h1>\n`,
    body.join('\n'), '\n</body></html>\n',
  ], { type: 'text/html;charset=utf-8' })
}
