/**
 * Deno contract test for the Postgres cache strategy.
 * Requires Postgres at DATABASE_URL — skipped when unset.
 * Run: DATABASE_URL=… deno test -A --no-check --sloppy-imports \
 *        --config packages/cache/deno-tests/deno.json packages/cache/deno-tests/postgres.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { createPostgresStrategy } from '../src/strategies/postgres.ts'

const hasDb = !!(globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get('DATABASE_URL')
const k = (s: string) => `omc-${Date.now()}-${s}`

Deno.test({ name: 'pg cache: set/get/has/delete', ignore: !hasDb }, async () => {
  const c = createPostgresStrategy()
  const key = k('a')
  await c.set(key, { a: 1 })
  assertEquals(await c.get(key), { a: 1 })
  assertEquals(await c.has(key), true)
  assertEquals(await c.delete(key), true)
  assertEquals(await c.get(key), null)
  await c.close?.()
})

Deno.test({ name: 'pg cache: tag invalidation', ignore: !hasDb }, async () => {
  const c = createPostgresStrategy()
  const grp = `grp-${Date.now()}`
  const ka = k('a'), kb = k('b'), kc = k('c')
  await c.set(ka, 1, { tags: [grp] }); await c.set(kb, 2, { tags: [grp] }); await c.set(kc, 3, { tags: ['other'] })
  assertEquals(await c.deleteByTags([grp]), 2)
  assertEquals(await c.get(ka), null)
  assertEquals(await c.get(kc), 3)
  await c.delete(kc); await c.close?.()
})

Deno.test({ name: 'pg cache: ttl + cleanup', ignore: !hasDb }, async () => {
  const c = createPostgresStrategy()
  const ok = k('ok'), exp = k('exp')
  await c.set(ok, 'v', { ttl: 60_000 }); assertEquals(await c.get(ok), 'v')
  await c.set(exp, 'v', { ttl: 1 }); assertEquals(await c.get(exp), null)
  await c.set(k('dead'), 1, { ttl: 1 })
  await new Promise((r) => setTimeout(r, 10))
  assert((await c.cleanup!()) >= 1)
  await c.delete(ok); await c.close?.()
})

if (!hasDb) console.warn('[pg cache test] DATABASE_URL unset — skipped.')
