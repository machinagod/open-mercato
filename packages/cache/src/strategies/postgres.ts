import type { CacheStrategy, CacheGetOptions, CacheSetOptions, CacheValue } from '../types'
import { CacheDependencyUnavailableError } from '../errors'
import { matchCacheKeyPattern } from '../patterns'

/**
 * Postgres cache strategy with tag-based invalidation.
 *
 * Persistent + shared across processes/instances, using `cache_entries` +
 * `cache_tags` tables (mirrors the SQLite strategy's schema). Intended for the
 * Deno Deploy target where Redis is unavailable, Deno KV can't co-exist with a
 * Postgres app, and the memory/SQLite strategies don't fit edge isolates.
 *
 * Uses `pg` directly (lazy import) against `DATABASE_URL`; the pool is shared
 * per connection string and reference-counted.
 */

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount: number | null }
type PgClient = { query(sql: string, params?: unknown[]): Promise<PgQueryResult>; release(): void }
type PgPool = {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>
  connect(): Promise<PgClient>
  end(): Promise<void>
}

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS cache_entries (
    key text PRIMARY KEY,
    value text NOT NULL,
    expires_at bigint,
    created_at bigint NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cache_tags (
    key text NOT NULL,
    tag text NOT NULL,
    PRIMARY KEY (key, tag),
    FOREIGN KEY (key) REFERENCES cache_entries(key) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_cache_tags_tag ON cache_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at ON cache_entries(expires_at);
`

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
    const ready = pool.query(CREATE_TABLES_SQL).then(() => undefined)
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

async function withTransaction<T>(pool: PgPool, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    throw error
  } finally {
    client.release()
  }
}

export function createPostgresStrategy(connectionStringArg?: string, options?: { defaultTtl?: number }): CacheStrategy {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const connectionString = connectionStringArg || env.CACHE_DATABASE_URL || env.DATABASE_URL
  const defaultTtl = options?.defaultTtl
  let poolPromise: Promise<PgPool> | null = null

  async function getDb(): Promise<PgPool> {
    if (!connectionString) {
      throw new CacheDependencyUnavailableError('postgres', 'pg', new Error('DATABASE_URL not set'))
    }
    if (!poolPromise) {
      poolPromise = acquirePool(connectionString).catch((error) => {
        poolPromise = null
        throw new CacheDependencyUnavailableError('postgres', 'pg', error)
      })
    }
    return poolPromise
  }

  const isExpired = (expiresAt: number | null): boolean => expiresAt !== null && Date.now() > expiresAt
  const toMs = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

  const deleteKey = async (key: string): Promise<boolean> => {
    const pool = await getDb()
    return withTransaction(pool, async (client) => {
      await client.query('DELETE FROM cache_tags WHERE key = $1', [key])
      const info = await client.query('DELETE FROM cache_entries WHERE key = $1', [key])
      return (info.rowCount ?? 0) > 0
    })
  }

  const get = async (key: string, opts?: CacheGetOptions): Promise<CacheValue | null> => {
    const pool = await getDb()
    const row = (await pool.query('SELECT value, expires_at FROM cache_entries WHERE key = $1', [key])).rows[0]
    if (!row) return null
    try {
      const value = JSON.parse(row.value as string) as CacheValue
      if (isExpired(toMs(row.expires_at))) {
        if (opts?.returnExpired) return value
        await deleteKey(key)
        return null
      }
      return value
    } catch {
      await deleteKey(key)
      return null
    }
  }

  const set = async (key: string, value: CacheValue, opts?: CacheSetOptions): Promise<void> => {
    const pool = await getDb()
    const ttl = opts?.ttl ?? defaultTtl
    const tags = opts?.tags || []
    const expiresAt = ttl ? Date.now() + ttl : null
    const serialized = JSON.stringify(value)
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM cache_tags WHERE key = $1', [key])
      await client.query(
        `INSERT INTO cache_entries (key, value, expires_at, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at`,
        [key, serialized, expiresAt, Date.now()],
      )
      for (const tag of tags) {
        await client.query('INSERT INTO cache_tags (key, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, tag])
      }
    })
  }

  const has = async (key: string): Promise<boolean> => {
    const pool = await getDb()
    const row = (await pool.query('SELECT expires_at FROM cache_entries WHERE key = $1', [key])).rows[0]
    if (!row) return false
    if (isExpired(toMs(row.expires_at))) {
      await deleteKey(key)
      return false
    }
    return true
  }

  const deleteByTags = async (tags: string[]): Promise<number> => {
    if (tags.length === 0) return 0
    const pool = await getDb()
    const rows = (await pool.query('SELECT DISTINCT key FROM cache_tags WHERE tag = ANY($1)', [tags])).rows
    let deleted = 0
    for (const row of rows) {
      if (await deleteKey(String(row.key))) deleted++
    }
    return deleted
  }

  const clear = async (): Promise<number> => {
    const pool = await getDb()
    return withTransaction(pool, async (client) => {
      const count = Number((await client.query('SELECT COUNT(*)::int AS count FROM cache_entries')).rows[0].count)
      await client.query('DELETE FROM cache_tags')
      await client.query('DELETE FROM cache_entries')
      return count
    })
  }

  const keys = async (pattern?: string): Promise<string[]> => {
    const pool = await getDb()
    const allKeys = (await pool.query('SELECT key FROM cache_entries')).rows.map((r) => String(r.key))
    if (!pattern) return allKeys
    return allKeys.filter((key) => matchCacheKeyPattern(key, pattern))
  }

  const stats = async (): Promise<{ size: number; expired: number }> => {
    const pool = await getDb()
    const size = Number((await pool.query('SELECT COUNT(*)::int AS count FROM cache_entries')).rows[0].count)
    const expired = Number(
      (await pool.query('SELECT COUNT(*)::int AS count FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at < $1', [Date.now()])).rows[0].count,
    )
    return { size, expired }
  }

  const cleanup = async (): Promise<number> => {
    const pool = await getDb()
    const info = await pool.query('DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at < $1', [Date.now()])
    return info.rowCount ?? 0
  }

  const close = async (): Promise<void> => {
    if (poolPromise && connectionString) {
      poolPromise = null
      await releasePool(connectionString)
    }
  }

  return { get, set, has, delete: deleteKey, deleteByTags, clear, keys, stats, cleanup, close }
}
