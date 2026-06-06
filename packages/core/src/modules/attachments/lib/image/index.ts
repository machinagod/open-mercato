import { isDenoRuntime } from '@open-mercato/shared/lib/runtime/detect'
import type { ImageProcessor } from './types'

export type { ImageProcessor, ImageDimensions, ImageFit, ImageFormat, ResizeOptions } from './types'

let cached: ImageProcessor | null = null

/** Runtime-selected image processor: sharp on Node, wasm-vips on Deno. Lazy so
 * the native sharp binding is never imported under Deno (it cannot load). */
export async function getImageProcessor(): Promise<ImageProcessor> {
  if (cached) return cached
  cached = isDenoRuntime()
    ? (await import('./vips')).vipsProcessor
    : (await import('./sharp')).sharpProcessor
  return cached
}
