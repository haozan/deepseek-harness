/** Encoding shared by the recognition upload and offline transcript export. */

/**
 * Encode a captured PNG in canonical base64.
 * @param png - the screenshot saved by Desktop.
 * @returns the base64 payload without a data URL header.
 */
export async function imageBase64(png: Blob): Promise<string> {
  const bytes = new Uint8Array(await png.arrayBuffer())
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  }
  return btoa(chunks.join(''))
}
