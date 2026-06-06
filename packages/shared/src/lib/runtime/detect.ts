/**
 * Runtime detection helpers — the canonical source for engine selection in
 * native-vs-portable adapters (sandbox, cache SQLite driver, image processor).
 *
 * Some low-level packages keep a local copy of `isDenoRuntime` instead of
 * importing this module:
 *   - `@open-mercato/cache` cannot import `@open-mercato/shared` (shared depends
 *     on cache — importing back would create a cycle).
 *   - the AI sandbox keeps its own copy so the Deno Worker module graph stays
 *     self-contained (and its Deno tests import the engine source directly).
 * Keep those copies in sync with this one.
 */

/** True when running under the Deno runtime. */
export function isDenoRuntime(): boolean {
  const d = (globalThis as { Deno?: { version?: { deno?: string } } }).Deno
  return typeof d !== 'undefined' && typeof d?.version?.deno === 'string'
}

/** True when running under Node (and not Deno's node-compat). */
export function isNodeRuntime(): boolean {
  if (isDenoRuntime()) return false
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process
  return typeof p?.versions?.node === 'string'
}
