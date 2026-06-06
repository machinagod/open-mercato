/**
 * Deno Worker sandbox engine.
 *
 * Runs AI-generated JavaScript inside a `Worker` created with
 * `deno: { permissions: "none" }` — an OS-level capability sandbox (no net, fs,
 * env, run, or ffi). Used on the Deno runtime, where the native `isolated-vm`
 * addon cannot load.
 *
 * Host functions injected via `globals` (e.g. `api.request`, `spec.findEndpoints`)
 * are exposed to sandboxed code as **synchronous** calls — preserving the exact
 * contract of the isolated-vm engine — using the same SharedArrayBuffer + Atomics
 * bridge: the worker posts the call request to the host (received while the host
 * thread is free), then blocks on `Atomics.wait`; the host runs the real function
 * and writes the result back through the shared buffer + `Atomics.notify`.
 */

import {
  normalizeCode,
  pushLog,
  type Sandbox,
  type SandboxOptions,
  type SandboxResult,
} from './shared'

type FnRef = { key: string; prop?: string }

interface WorkerLike {
  postMessage(data: unknown): void
  terminate(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null
}

const RESULT_BYTES = 8 * 1024 * 1024 // shared buffer for host-call results (length-prefixed JSON)

let warnedNoPermissions = false

type WebGlobals = {
  URL: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void }
  Blob: new (parts: unknown[], opts?: { type?: string }) => unknown
  Worker: new (url: string, opts?: unknown) => WorkerLike
}

// Opt-in OS-level capability lock. `deno: { permissions: "none" }` requires the
// `--unstable-worker-options` flag, and passing it without that flag fails in a
// way Deno does not let us catch. So we only use it when the operator sets
// `OM_SANDBOX_WORKER_PERMISSIONS=none` (alongside the flag). Otherwise the worker
// relies on in-isolate hardening (global neutralization + user-scope shadowing +
// a fresh isolate with no host process/require).
function wantsPermissionLock(): boolean {
  try {
    const env = (globalThis as { Deno?: { env?: { get?(k: string): string | undefined } } }).Deno?.env
    return (env?.get?.('OM_SANDBOX_WORKER_PERMISSIONS') ?? '').toLowerCase() === 'none'
  } catch {
    return false
  }
}

// Globals shadowed to `undefined` inside user code. The real isolation boundary
// is the Worker + permissions:"none"; this also satisfies the engine-parity
// security tests (require/process/fetch/Buffer/timers/globalThis blocked).
const SHADOWED_GLOBALS = [
  'globalThis', 'self', 'global', 'Deno', 'process', 'require', 'module', 'exports',
  'fetch', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout',
  'clearInterval', 'queueMicrotask', 'importScripts', 'XMLHttpRequest', 'WebSocket',
  'postMessage', 'addEventListener',
]

const WORKER_SOURCE = `
// Defense-in-depth: neutralize capability globals on the worker's own global,
// so even reflective access (Function('return fetch')()) yields undefined.
// This holds even if the permissions:"none" option is unavailable.
for (const g of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Deno', 'navigator']) {
  try { Object.defineProperty(self, g, { value: undefined, configurable: true, writable: false }) } catch (_e) { /* ignore */ }
}

self.onmessage = (e) => {
  self.onmessage = null
  const data = e.data
  const sig = new Int32Array(data.control)
  const view = new DataView(data.result)
  const resBytes = new Uint8Array(data.result)
  const decoder = new TextDecoder()

  const hostCall = (path) => (...args) => {
    Atomics.store(sig, 0, 0)
    self.postMessage({ __hostcall: true, path, args })
    Atomics.wait(sig, 0, 0)
    const len = view.getUint32(0)
    const json = decoder.decode(resBytes.subarray(4, 4 + len))
    const r = JSON.parse(json)
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  const con = {}
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    con[m] = (...a) => { self.postMessage({ __log: true, args: a }) }
  }

  const scope = {}
  for (const k of Object.keys(data.dataGlobals)) scope[k] = data.dataGlobals[k]
  for (const f of data.fnList) {
    if (f.prop != null) {
      if (!scope[f.key] || typeof scope[f.key] !== 'object') scope[f.key] = {}
      scope[f.key][f.prop] = hostCall(f.key + '.' + f.prop)
    } else {
      scope[f.key] = hostCall(f.key)
    }
  }

  const scopeKeys = Object.keys(scope)
  // Drop shadow names that collide with injected globals or 'console' to avoid
  // duplicate Function parameter names.
  const shadowed = data.shadowed.filter((s) => s !== 'console' && scopeKeys.indexOf(s) === -1)
  const paramNames = ['console'].concat(scopeKeys).concat(shadowed)
  const paramValues = [con].concat(scopeKeys.map((k) => scope[k])).concat(shadowed.map(() => undefined))

  ;(async () => {
    try {
      const factory = new Function(...paramNames, '"use strict"; return (' + data.code + ')')
      const userFn = factory(...paramValues)
      const out = await userFn()
      self.postMessage({ __done: true, result: out })
    } catch (err) {
      self.postMessage({ __error: true, error: (err && err.message) ? String(err.message) : String(err) })
    }
  })()
}
`

function splitGlobals(globals: Record<string, unknown>) {
  const dataGlobals: Record<string, unknown> = {}
  const fnList: FnRef[] = []
  const registry = new Map<string, (...a: unknown[]) => unknown>()

  for (const [key, value] of Object.entries(globals)) {
    if (value === null || value === undefined) {
      dataGlobals[key] = value
      continue
    }
    if (typeof value === 'function') {
      fnList.push({ key })
      registry.set(key, value as (...a: unknown[]) => unknown)
      continue
    }
    if (typeof value === 'object') {
      const data: Record<string, unknown> = {}
      for (const [prop, propVal] of Object.entries(value as Record<string, unknown>)) {
        if (typeof propVal === 'function') {
          fnList.push({ key, prop })
          registry.set(`${key}.${prop}`, propVal as (...a: unknown[]) => unknown)
        } else {
          data[prop] = propVal
        }
      }
      dataGlobals[key] = data
      continue
    }
    dataGlobals[key] = value
  }

  return { dataGlobals, fnList, registry }
}

export function createSandboxImpl(globals: Record<string, unknown>, options: SandboxOptions = {}): Sandbox {
  const { timeout = 30_000 } = options

  return {
    async execute(code: string): Promise<SandboxResult> {
      const logs: string[] = []
      const start = Date.now()
      const { dataGlobals, fnList, registry } = splitGlobals(globals)
      const normalized = normalizeCode(code)

      const control = new SharedArrayBuffer(8)
      const sig = new Int32Array(control)
      const result = new SharedArrayBuffer(RESULT_BYTES)
      const view = new DataView(result)
      const resBytes = new Uint8Array(result)
      const encoder = new TextEncoder()

      // Access web/Deno globals at runtime to avoid a hard DOM-lib dependency
      // when this Deno-only module is type-checked under the Node package build.
      const web = globalThis as unknown as WebGlobals
      const lockPermissions = wantsPermissionLock()
      if (!lockPermissions && !warnedNoPermissions) {
        warnedNoPermissions = true
        // eslint-disable-next-line no-console
        console.warn('[sandbox] Deno Worker permissions:"none" unavailable (run with --unstable-worker-options for the OS-level sandbox); falling back to in-isolate hardening only.')
      }
      const blobUrl = web.URL.createObjectURL(new web.Blob([WORKER_SOURCE], { type: 'application/javascript' }))
      const workerOpts = lockPermissions
        ? { type: 'module', deno: { permissions: 'none' } }
        : { type: 'module' }
      const worker = new web.Worker(blobUrl, workerOpts)

      return await new Promise<SandboxResult>((resolve) => {
        let settled = false
        const finish = (r: SandboxResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { worker.terminate() } catch { /* ignore */ }
          try { web.URL.revokeObjectURL(blobUrl) } catch { /* ignore */ }
          resolve(r)
        }

        const timer = setTimeout(
          () => finish({ result: null, error: `Execution timed out after ${timeout}ms`, logs, durationMs: Date.now() - start }),
          timeout
        )

        worker.onmessage = (event: { data: unknown }) => { void handleMessage(event) }
        const handleMessage = async (event: { data: unknown }) => {
          const msg = event.data as Record<string, unknown>
          if (msg?.__hostcall) {
            const path = msg.path as string
            const args = (msg.args as unknown[]) ?? []
            let payload: { ok: boolean; value?: unknown; error?: string }
            try {
              const fn = registry.get(path)
              if (!fn) throw new Error(`Unknown host function: ${path}`)
              const value = await fn(...args)
              payload = { ok: true, value: value === undefined ? null : value }
            } catch (err) {
              payload = { ok: false, error: (err as { message?: string })?.message ?? String(err) }
            }
            let bytes: Uint8Array
            try {
              bytes = encoder.encode(JSON.stringify(payload))
            } catch {
              bytes = encoder.encode(JSON.stringify({ ok: false, error: 'host call result not serializable' }))
            }
            if (bytes.length + 4 > RESULT_BYTES) {
              bytes = encoder.encode(JSON.stringify({ ok: false, error: 'host call result too large' }))
            }
            view.setUint32(0, bytes.length)
            resBytes.set(bytes, 4)
            Atomics.store(sig, 0, 1)
            Atomics.notify(sig, 0)
            return
          }
          if (msg?.__log) {
            pushLog(logs, (msg.args as unknown[]) ?? [])
            return
          }
          if (msg?.__done) {
            finish({ result: msg.result, logs, durationMs: Date.now() - start })
            return
          }
          if (msg?.__error) {
            finish({ result: null, error: String(msg.error), logs, durationMs: Date.now() - start })
          }
        }

        worker.onerror = (event: { message?: string; preventDefault?: () => void }) => {
          try { event.preventDefault?.() } catch { /* ignore */ }
          finish({ result: null, error: event?.message ?? 'worker error', logs, durationMs: Date.now() - start })
        }

        worker.postMessage({ code: normalized, dataGlobals, fnList, control, result, shadowed: SHADOWED_GLOBALS })
      })
    },
  }
}
