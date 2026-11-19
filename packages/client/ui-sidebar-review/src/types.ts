/** Desktop region capture exposed to the application frame. */

/** A rectangle in viewport CSS pixels, before page zoom is applied. */
export interface CaptureRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Capture the application's composited pixels. */
export type CapturePageRegion = (region: CaptureRegion) => Promise<Uint8Array<ArrayBuffer>>

/** Portable archive identity and its last committed save time in milliseconds. */
export interface ArchiveSummary {
  readonly id: string
  readonly updatedAt: number
}

/** Local file version and optional portable content identity for a review source. */
export interface ArchiveSourceState {
  readonly version: string
  readonly digest?: string
}
