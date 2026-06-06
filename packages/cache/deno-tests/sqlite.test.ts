/**
 * Deno-only test: the SQLite cache strategy on the node:sqlite driver
 * (selected automatically under Deno, where better-sqlite3 cannot load).
 *
 * Run: deno test -A --no-check --sloppy-imports packages/cache/deno-tests/sqlite.test.ts
 * Outside src/, so neither Jest nor the Node package build picks it up.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { createSqliteStrategy } from '../src/strategies/sqlite.ts'

async function freshCache() {
  const dbPath = await Deno.makeTempFile({ suffix: '.cache.db' })
  return { cache: createSqliteStrategy(dbPath), dbPath }
}

Deno.test('node:sqlite cache: set/get/has', async () => {
  const { cache } = await freshCache()
  await cache.set('k1', { a: 1, b: 'x' })
  assertEquals(await cache.get('k1'), { a: 1, b: 'x' })
  assertEquals(await cache.has('k1'), true)
  assertEquals(await cache.get('missing'), null)
  assertEquals(await cache.has('missing'), false)
  await cache.close()
})

Deno.test('node:sqlite cache: delete', async () => {
  const { cache } = await freshCache()
  await cache.set('k', 1)
  assertEquals(await cache.delete('k'), true)
  assertEquals(await cache.get('k'), null)
  await cache.close()
})

Deno.test('node:sqlite cache: tag invalidation', async () => {
  const { cache } = await freshCache()
  await cache.set('a', 1, { tags: ['grp', 'x'] })
  await cache.set('b', 2, { tags: ['grp'] })
  await cache.set('c', 3, { tags: ['y'] })
  const deleted = await cache.deleteByTags(['grp'])
  assertEquals(deleted, 2)
  assertEquals(await cache.get('a'), null)
  assertEquals(await cache.get('b'), null)
  assertEquals(await cache.get('c'), 3)
  await cache.close()
})

Deno.test('node:sqlite cache: ttl expiry', async () => {
  const { cache } = await freshCache()
  await cache.set('t', 'v', { ttl: 10 })
  assertEquals(await cache.get('t'), 'v')
  await new Promise((r) => setTimeout(r, 30))
  assertEquals(await cache.get('t'), null)
  await cache.close()
})

Deno.test('node:sqlite cache: clear + keys + stats', async () => {
  const { cache } = await freshCache()
  await cache.set('k1', 1)
  await cache.set('k2', 2)
  const keys = await cache.keys()
  assertEquals(keys.sort(), ['k1', 'k2'])
  const stats = await cache.stats()
  assertEquals(stats.size, 2)
  const cleared = await cache.clear()
  assertEquals(cleared, 2)
  assertEquals(await cache.keys(), [])
  await cache.close()
})

Deno.test('node:sqlite cache: cleanup removes expired', async () => {
  const { cache } = await freshCache()
  await cache.set('live', 1)
  await cache.set('dead', 2, { ttl: 5 })
  await new Promise((r) => setTimeout(r, 25))
  const removed = await cache.cleanup()
  assert(removed >= 1)
  assertEquals(await cache.get('live'), 1)
  await cache.close()
})
