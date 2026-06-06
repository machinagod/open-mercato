import sharp from 'sharp'
import type { ImageDimensions, ImageProcessor, ResizeOptions } from './types'

/** Node image processor — native sharp (libvips). Behavior unchanged from the
 * original inline sharp calls in imageSafety.ts / the image route. */
export const sharpProcessor: ImageProcessor = {
  async readDimensions(buffer: Buffer, limitPixels: number): Promise<ImageDimensions | null> {
    try {
      const meta = await sharp(buffer, { failOn: 'error', limitInputPixels: limitPixels }).metadata()
      const width = meta.width ?? 0
      const height = meta.height ?? 0
      if (width <= 0 || height <= 0) return null
      return { width, height }
    } catch {
      return null
    }
  },

  async resize(buffer: Buffer, options: ResizeOptions): Promise<Buffer> {
    let transformer = sharp(buffer, { failOn: 'error', limitInputPixels: options.limitPixels })
    if (options.width || options.height) {
      const resizeOptions: sharp.ResizeOptions = {
        width: options.width || undefined,
        height: options.height || undefined,
        fit: options.fit,
      }
      if (options.fit === 'contain') {
        resizeOptions.background = { r: 0, g: 0, b: 0, alpha: 0 }
      }
      transformer = transformer.resize(resizeOptions)
    }
    // toBuffer() re-encodes in the source format — the sanitization step.
    return await transformer.toBuffer()
  },
}
