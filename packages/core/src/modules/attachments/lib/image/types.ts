/**
 * Runtime-agnostic image-processing contract.
 *
 * Two adapters satisfy it, selected at runtime (see ./index.ts):
 *   - sharp (Node)     — native libvips binding.
 *   - wasm-vips (Deno) — libvips compiled to WASM (sharp can't load under Deno).
 *
 * Both always RE-ENCODE the image (even without a resize) — this is the
 * sanitization step that strips any non-pixel payload from uploaded images.
 */

export type ImageFit = 'cover' | 'contain'
export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp'

export interface ImageDimensions {
  width: number
  height: number
}

export interface ResizeOptions {
  /** Target width in px (omit to scale by height) */
  width?: number
  /** Target height in px (omit to scale by width) */
  height?: number
  /** `cover` = fill + center-crop; `contain` = fit within + transparent pad */
  fit: ImageFit
  /** Decode guard (decline images above this pixel count) */
  limitPixels: number
  /** Output encoding — mirrors the source format (re-encode in place) */
  format: ImageFormat
}

export interface ImageProcessor {
  /** Read pixel dimensions; returns null when the buffer is not a valid image. */
  readDimensions(buffer: Buffer, limitPixels: number): Promise<ImageDimensions | null>
  /** Resize (or, with no width/height, re-encode) and return the encoded bytes. */
  resize(buffer: Buffer, options: ResizeOptions): Promise<Buffer>
}
