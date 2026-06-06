/**
 * Deno-only test: the wasm-vips image processor (used where native sharp can't load).
 * Run: deno test -A --no-check --sloppy-imports packages/core/deno-tests/image-vips.test.ts
 * Outside src/, so neither Jest nor the Node package build picks it up.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { vipsProcessor } from '../src/modules/attachments/lib/image/vips.ts'

// A valid 1x1 PNG.
const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
)
const buf = (u: Uint8Array) => globalThis.Buffer.from(u)

Deno.test('vips: readDimensions', async () => {
  assertEquals(await vipsProcessor.readDimensions(buf(PNG_1x1), 40_000_000), { width: 1, height: 1 })
})

Deno.test('vips: readDimensions returns null for garbage', async () => {
  assertEquals(await vipsProcessor.readDimensions(buf(Uint8Array.from([1, 2, 3, 4])), 40_000_000), null)
})

Deno.test('vips: re-encode (no resize) produces a valid image', async () => {
  const out = await vipsProcessor.resize(buf(PNG_1x1), { fit: 'cover', limitPixels: 40_000_000, format: 'png' })
  assert(out.length > 0)
  assertEquals(await vipsProcessor.readDimensions(out, 40_000_000), { width: 1, height: 1 })
})

Deno.test('vips: resize cover to exact box', async () => {
  const out = await vipsProcessor.resize(buf(PNG_1x1), { width: 16, height: 16, fit: 'cover', limitPixels: 40_000_000, format: 'png' })
  assertEquals(await vipsProcessor.readDimensions(out, 40_000_000), { width: 16, height: 16 })
})

Deno.test('vips: resize contain fits within the box (aspect preserved)', async () => {
  // 1x1 into a 16x8 box → fit-within keeps 1:1 aspect, bounded by height → 8x8.
  const out = await vipsProcessor.resize(buf(PNG_1x1), { width: 16, height: 8, fit: 'contain', limitPixels: 40_000_000, format: 'png' })
  assertEquals(await vipsProcessor.readDimensions(out, 40_000_000), { width: 8, height: 8 })
})
