/**
 * Deno-only contract tests for the Worker sandbox engine
 * (src/modules/ai_assistant/lib/sandbox/worker.ts).
 *
 * The Jest suite (src/.../lib/__tests__/sandbox.test.ts) covers the isolated-vm
 * engine under Node; this mirrors the security + behavior contract for the Deno
 * Worker engine, which only runs under Deno. Not picked up by Jest (outside
 * src/**​/__tests__) or the Node package build (outside src/).
 *
 * Run:
 *   deno test -A --no-check --sloppy-imports packages/ai-assistant/deno-tests/sandbox-worker.test.ts
 *   # add --unstable-worker-options + OM_SANDBOX_WORKER_PERMISSIONS=none to exercise the OS-level lock
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { createSandboxImpl } from '../src/modules/ai_assistant/lib/sandbox/worker.ts'

Deno.test('basic expression', async () => {
  const r = await createSandboxImpl({}).execute('async () => 1 + 2')
  assertEquals(r.error, undefined)
  assertEquals(r.result, 3)
})

Deno.test('returns objects and arrays', async () => {
  const r = await createSandboxImpl({}).execute('async () => [1,2,3].filter(x => x > 1)')
  assertEquals(r.result, [2, 3])
})

Deno.test('data globals (spec.paths)', async () => {
  const spec = { paths: { '/a': 1, '/b': 2 } }
  const r = await createSandboxImpl({ spec }).execute('async () => Object.keys(spec.paths)')
  assertEquals(r.result, ['/a', '/b'])
})

Deno.test('SYNC host function (spec.findEndpoints, no await)', async () => {
  const spec = {
    findEndpoints: (kw: string) =>
      ['/api/customers/companies', '/api/sales/orders'].filter((p) => p.includes(kw)).map((p) => ({ path: p })),
  }
  const r = await createSandboxImpl({ spec }).execute('async () => spec.findEndpoints("customer")')
  assertEquals(r.error, undefined)
  assertEquals(r.result, [{ path: '/api/customers/companies' }])
})

Deno.test('ASYNC host function (sequential api.request)', async () => {
  let calls = 0
  const api = { request: async (p: { path: string }) => { calls++; return { success: true, statusCode: 200, data: { path: p.path, n: calls } } } }
  const r = await createSandboxImpl({ api }).execute(`async () => {
    const a = await api.request({ method: "GET", path: "/x" })
    const b = await api.request({ method: "GET", path: "/y" })
    return { a: a.data, b: b.data }
  }`)
  assertEquals(r.error, undefined)
  assertEquals(calls, 2)
  assertEquals(r.result, { a: { path: '/x', n: 1 }, b: { path: '/y', n: 2 } })
})

Deno.test('host function rejection surfaces as a thrown error', async () => {
  const api = { request: async () => { throw new Error('Network error') } }
  const r = await createSandboxImpl({ api }).execute('async () => api.request({})')
  assertEquals(r.error, 'Network error')
})

Deno.test('console capture', async () => {
  const r = await createSandboxImpl({}).execute('async () => { console.log("hi", { x: 1 }); return 7 }')
  assertEquals(r.result, 7)
  assert(r.logs.some((l) => l.includes('hi') && l.includes('"x":1')))
})

Deno.test('security: require blocked', async () => {
  assert((await createSandboxImpl({}).execute("async () => require('fs')")).error)
})
Deno.test('security: process blocked', async () => {
  assert((await createSandboxImpl({}).execute('async () => process.env')).error)
})
Deno.test('security: fetch blocked', async () => {
  assert((await createSandboxImpl({}).execute("async () => fetch('http://evil.com')")).error)
})
Deno.test('security: globalThis is undefined', async () => {
  assertEquals((await createSandboxImpl({}).execute('async () => globalThis')).result, undefined)
})
Deno.test('security: setTimeout blocked', async () => {
  assert((await createSandboxImpl({}).execute('async () => setTimeout(() => {}, 100)')).error)
})
Deno.test('security: Function-constructor escape yields no host process', async () => {
  const r = await createSandboxImpl({}).execute("async () => Object.constructor('return process')()")
  const leaked = r.result as { pid?: unknown } | null | undefined
  assert(!leaked || leaked.pid === undefined)
})

Deno.test('error handling: thrown error', async () => {
  const r = await createSandboxImpl({}).execute('async () => { throw new Error("boom") }')
  assertEquals(r.error, 'boom')
  assertEquals(r.result, null)
})

Deno.test('statement form (const + return)', async () => {
  const r = await createSandboxImpl({}).execute('const x = 1; return x + 41')
  assertEquals(r.error, undefined)
  assertEquals(r.result, 42)
})

Deno.test('timeout on infinite loop', async () => {
  const r = await createSandboxImpl({}, { timeout: 300 }).execute('async () => { while(true) {} }')
  assert(r.error)
  assert(/timed out/i.test(r.error!))
})
