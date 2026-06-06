import type {
  Queue,
  QueuedJob,
  JobHandler,
  ProcessOptions,
  ProcessResult,
  EnqueueOptions,
  PostgresQueueOptions,
} from '../types'

/**
 * Postgres-backed queue strategy.
 *
 * Durable, multi-process job queue using a single `queue_jobs` table drained
 * with `FOR UPDATE SKIP LOCKED`. Designed for the Deno Deploy target (no Redis,
 * no writable filesystem, no long-running worker processes): `process()` claims
 * and runs a batch then returns counts — call it on a schedule (`Deno.cron`) or
 * from a poller. Behaves like the `local` strategy's batch semantics, not the
 * `async` (BullMQ worker) one.
 *
 * Uses `pg` directly (lazy import) against `DATABASE_URL`; the pool is shared
 * per connection string and reference-counted across queue instances.
 */

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount: number | null }
type PgPool = {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>
  end(): Promise<void>
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BATCH_LIMIT = 25
const RETRY_BACKOFF_BASE_MS = 1000
const TABLE = 'queue_jobs'

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    queue text NOT NULL,
    payload jsonb,
    metadata jsonb,
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
    available_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    error text
  );
  CREATE INDEX IF NOT EXISTS idx_queue_jobs_claim ON ${TABLE} (queue, status, available_at);
`

// Shared, reference-counted pools keyed by connection string.
const pools = new Map<string, { pool: PgPool; refs: number; ready: Promise<void> }>()

function resolveSsl(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const requireSsl = connectionString.includes('sslmode=require') ||
    connectionString.includes('ssl=true') ||
    env.DB_SSL === 'true' ||
    !!env.PGSSLMODE
  if (!requireSsl) return undefined
  return { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
}

async function acquirePool(connectionString: string): Promise<PgPool> {
  let entry = pools.get(connectionString)
  if (!entry) {
    const mod = (await import('pg')) as unknown as { default?: { Pool: new (c: unknown) => PgPool }; Pool?: new (c: unknown) => PgPool }
    const Pool = mod.Pool ?? mod.default?.Pool
    if (!Pool) throw new Error('[internal] pg.Pool not found')
    const pool = new Pool({ connectionString, max: 1, ssl: resolveSsl(connectionString) })
    const ready = pool.query(CREATE_TABLE_SQL).then(() => undefined)
    entry = { pool, refs: 0, ready }
    pools.set(connectionString, entry)
  }
  entry.refs += 1
  await entry.ready
  return entry.pool
}

async function releasePool(connectionString: string): Promise<void> {
  const entry = pools.get(connectionString)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs <= 0) {
    pools.delete(connectionString)
    await entry.pool.end()
  }
}

export function createPostgresQueue<T = unknown>(name: string, options?: PostgresQueueOptions): Queue<T> {
  const connectionString = options?.connectionString
    ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.DATABASE_URL
  if (!connectionString) throw new Error('[internal] Postgres queue requires DATABASE_URL (or options.connectionString)')
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  let poolPromise: Promise<PgPool> | null = null
  const getPool = (): Promise<PgPool> => {
    if (!poolPromise) poolPromise = acquirePool(connectionString)
    return poolPromise
  }

  function toJob(row: Record<string, unknown>): QueuedJob<T> {
    return {
      id: String(row.id),
      payload: (row.payload ?? null) as T,
      createdAt: new Date(row.created_at as string).toISOString(),
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    }
  }

  return {
    name,
    strategy: 'postgres',

    async enqueue(data: T, opts?: EnqueueOptions): Promise<string> {
      const pool = await getPool()
      const delayMs = opts?.delayMs ?? 0
      const result = await pool.query(
        `INSERT INTO ${TABLE} (queue, payload, max_attempts, available_at)
         VALUES ($1, $2, $3, now() + ($4::int || ' milliseconds')::interval)
         RETURNING id`,
        [name, JSON.stringify(data ?? null), maxAttempts, delayMs],
      )
      return String(result.rows[0].id)
    },

    async process(handler: JobHandler<T>, opts?: ProcessOptions): Promise<ProcessResult> {
      const pool = await getPool()
      const limit = opts?.limit ?? DEFAULT_BATCH_LIMIT
      // Atomically claim a batch.
      const claimed = await pool.query(
        `UPDATE ${TABLE} SET status = 'active', locked_at = now()
         WHERE id IN (
           SELECT id FROM ${TABLE}
           WHERE queue = $1 AND status = 'pending' AND available_at <= now()
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         RETURNING *`,
        [name, limit],
      )

      let processed = 0
      let failed = 0
      let lastJobId: string | undefined

      for (const row of claimed.rows) {
        const job = toJob(row)
        lastJobId = job.id
        const attemptNumber = Number(row.attempts ?? 0) + 1
        try {
          await handler(job, { jobId: job.id, attemptNumber, queueName: name })
          await pool.query(`DELETE FROM ${TABLE} WHERE id = $1`, [job.id])
          processed += 1
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (attemptNumber >= maxAttempts) {
            await pool.query(
              `UPDATE ${TABLE} SET status = 'failed', attempts = $2, error = $3, locked_at = NULL WHERE id = $1`,
              [job.id, attemptNumber, message],
            )
          } else {
            const backoff = RETRY_BACKOFF_BASE_MS * attemptNumber
            await pool.query(
              `UPDATE ${TABLE} SET status = 'pending', attempts = $2, error = $3, locked_at = NULL,
                 available_at = now() + ($4::int || ' milliseconds')::interval WHERE id = $1`,
              [job.id, attemptNumber, message, backoff],
            )
          }
          failed += 1
        }
      }

      return { processed, failed, lastJobId }
    },

    async clear(): Promise<{ removed: number }> {
      const pool = await getPool()
      const result = await pool.query(`DELETE FROM ${TABLE} WHERE queue = $1`, [name])
      return { removed: result.rowCount ?? 0 }
    },

    async close(): Promise<void> {
      if (poolPromise) {
        poolPromise = null
        await releasePool(connectionString)
      }
    },

    async getJobCounts(): Promise<{ waiting: number; active: number; completed: number; failed: number }> {
      const pool = await getPool()
      const result = await pool.query(
        `SELECT status, count(*)::int AS count FROM ${TABLE} WHERE queue = $1 GROUP BY status`,
        [name],
      )
      const counts = { waiting: 0, active: 0, completed: 0, failed: 0 }
      for (const row of result.rows) {
        const n = Number(row.count)
        if (row.status === 'pending') counts.waiting = n
        else if (row.status === 'active') counts.active = n
        else if (row.status === 'failed') counts.failed = n
      }
      return counts
    },
  }
}
