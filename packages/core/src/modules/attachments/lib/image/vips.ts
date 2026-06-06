import type { ImageDimensions, ImageProcessor, ResizeOptions } from './types'

/** Deno image processor — wasm-vips (libvips/WASM), used where native sharp
 * cannot load. WASM module is initialized once and cached. */

type VipsImage = {
  width: number
  height: number
  writeToBuffer(suffix: string): Uint8Array
}
type VipsModule = {
  Image: {
    newFromBuffer(buffer: Uint8Array): VipsImage
    thumbnailBuffer(buffer: Uint8Array, width: number, options?: Record<string, unknown>): VipsImage
  }
  Size: { both: number }
  Interesting: { centre: number }
}

let vipsPromise: Promise<VipsModule> | null = null
async function getVips(): Promise<VipsModule> {
  if (!vipsPromise) {
    vipsPromise = import('wasm-vips').then((mod) => (mod.default as () => Promise<VipsModule>)())
  }
  return vipsPromise
}

const SUFFIX: Record<ResizeOptions['format'], string> = {
  jpeg: '.jpg',
  png: '.png',
  gif: '.gif',
  webp: '.webp',
}

export const vipsProcessor: ImageProcessor = {
  async readDimensions(buffer: Buffer, _limitPixels: number): Promise<ImageDimensions | null> {
    try {
      const vips = await getVips()
      const img = vips.Image.newFromBuffer(buffer)
      const width = img.width
      const height = img.height
      if (width <= 0 || height <= 0) return null
      return { width, height }
    } catch {
      return null
    }
  },

  async resize(buffer: Buffer, options: ResizeOptions): Promise<Buffer> {
    const vips = await getVips()
    const suffix = SUFFIX[options.format] ?? '.png'

    // No target dimensions → re-encode only (sanitization).
    if (!options.width && !options.height) {
      const img = vips.Image.newFromBuffer(buffer)
      return Buffer.from(img.writeToBuffer(suffix))
    }

    const targetWidth = options.width ?? options.height!
    const thumbOptions: Record<string, unknown> = { size: vips.Size.both }
    if (options.height) thumbOptions.height = options.height
    if (options.fit === 'cover') {
      // Fill the box and center-crop the overflow.
      thumbOptions.crop = vips.Interesting.centre
    }
    // contain: thumbnail already fits the image WITHIN the box (no crop).
    // NOTE (R2): sharp's `contain` also pads to the exact box with a transparent
    // background; the wasm-vips embed/pad path needs band-aware handling and is
    // deferred to the fidelity-parity review. Until then `contain` returns the
    // fit-within image (correct aspect, may be smaller than the box on one axis).

    const img = vips.Image.thumbnailBuffer(buffer, targetWidth, thumbOptions)
    return Buffer.from(img.writeToBuffer(suffix))
  },
}
