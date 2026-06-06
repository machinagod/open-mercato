/**
 * Deno contract test for the Postgres queue strategy.
 * Requires a Postgres at DATABASE_URL — skipped automatically when unset.
 *
 * Run: DATABASE_URL=postgres://… deno test -A --no-check --sloppy-imports \
 *        --config packages/queue/deno-tests/deno.json \
 *        packages/queue/deno-tests/postgres.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { createPostgresQueue } from '../src/strategies/postgres.ts'

const hasDb = !!(globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get('DATABASE_URL')

Deno.test({ name: 'postgres queue: enqueue → process(success) deletes the job', ignore: !hasDb }, async () => {
  const q = createPostgresQueue<{ hello: string }>(`om-test-${Date.now()}-a`)
  try {
    await q.enqueue({ hello: 'world' })
    assertEquals((await q.getJobCounts()).waiting, 1)
    let seen: unknown = null
    const res = await q.process((job, ctx) => { seen = job.payload; assertEquals(ctx.attemptNumber, 1) })
    assertEquals(res.processed, 1)
    assertEquals(res.failed, 0)
    assertEquals(seen, { hello: 'world' })
    assertEquals(await q.getJobCounts(), { waiting: 0, active: 0, completed: 0, failed: 0 })
  } finally {
    await q.clear(); await q.close()
  }
})

Deno.test({ name: 'postgres queue: retryable failure reschedules with backoff', ignore: !hasDb }, async () => {
  const q = createPostgresQueue(`om-test-${Date.now()}-b`)
  try {
    await q.enqueue({})
    const res = await q.process(() => { throw new Error('boom') })
    assertEquals(res.processed, 0)
    assertEquals(res.failed, 1)
    assertEquals((await q.getJobCounts()).waiting, 1) // rescheduled to pending
    const reprocess = await q.process(() => { throw new Error('should not run') })
    assertEquals(reprocess.processed, 0) // un-claimable during backoff
    assertEquals(reprocess.failed, 0)
  } finally {
    await q.clear(); await q.close()
  }
})

Deno.test({ name: 'postgres queue: clear removes jobs', ignore: !hasDb }, async () => {
  const q = createPostgresQueue(`om-test-${Date.now()}-c`)
  try {
    await q.enqueue({})
    await q.enqueue({})
    const { removed } = await q.clear()
    assert(removed >= 2)
    assertEquals((await q.getJobCounts()).waiting, 0)
  } finally {
    await q.close()
  }
})

if (!hasDb) console.warn('[postgres.test] DATABASE_URL unset — Postgres queue tests skipped.')
