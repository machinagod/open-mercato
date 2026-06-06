/**
 * isolated-vm sandbox engine (Node).
 *
 * Runs AI-generated JavaScript inside a separate V8 isolate. Each execution
 * gets a fresh isolate with no shared prototype chain, heap, or handle access
 * to the host process — preventing the node:vm escape via the Promise prototype
 * chain (NEW-01, CVSS 9.9). Native nan addon — does NOT load under Deno; the
 * Worker engine (`worker.ts`) is used there instead.
 */

import ivm from 'isolated-vm'
import {
  MEMORY_LIMIT_MB,
  normalizeCode,
  pushLog,
  type Sandbox,
  type SandboxOptions,
  type SandboxResult,
} from './shared'

export function createSandboxImpl(globals: Record<string, unknown>, options: SandboxOptions = {}): Sandbox {
  const { timeout = 30_000 } = options

  return {
    async execute(code: string): Promise<SandboxResult> {
      const logs: string[] = []
      const start = Date.now()

      const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB })

      try {
        const ctx = await isolate.createContext()

        await bootstrapConsole(ctx, logs)
        await injectGlobals(ctx, globals)

        // Shadow globalThis so user code cannot navigate to the isolate's global
        await ctx.global.set('globalThis', undefined)

        const normalized = normalizeCode(code)
        const script = await isolate.compileScript(`(${normalized})()`)

        const result = await Promise.race([
          script.run(ctx, { promise: true, copy: true }),
          new Promise<never>((_, reject) =>
            globalThis.setTimeout(
              () => reject(new Error(`Execution timed out after ${timeout}ms`)),
              timeout
            )
          ),
        ])

        return { result, logs, durationMs: Date.now() - start }
      } catch (error) {
        const err = error as { message?: string }
        return {
          result: null,
          error: err?.message ?? String(error),
          logs,
          durationMs: Date.now() - start,
        }
      } finally {
        isolate.dispose()
      }
    },
  }
}

async function bootstrapConsole(ctx: ivm.Context, logs: string[]): Promise<void> {
  const cb = new ivm.Callback((...args: unknown[]) => pushLog(logs, args), { ignored: true })
  await ctx.evalClosure(
    `globalThis.console = {
      log:   (...a) => $0(...a),
      info:  (...a) => $0(...a),
      warn:  (...a) => $0(...a),
      error: (...a) => $0(...a),
      debug: (...a) => $0(...a),
    }`,
    [cb]
  )
}

async function injectGlobals(ctx: ivm.Context, globals: Record<string, unknown>): Promise<void> {
  const jail = ctx.global

  for (const [key, value] of Object.entries(globals)) {
    if (value === null || value === undefined) {
      await jail.set(key, value as null | undefined)
      continue
    }

    if (typeof value === 'function') {
      await injectFn(ctx, value as (...a: unknown[]) => unknown, `globalThis[${JSON.stringify(key)}]`)
      continue
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const dataEntries: Record<string, unknown> = {}
      const fnProps: Array<[string, (...a: unknown[]) => unknown]> = []

      for (const [prop, propVal] of Object.entries(obj)) {
        if (typeof propVal === 'function') {
          fnProps.push([prop, propVal as (...a: unknown[]) => unknown])
        } else {
          dataEntries[prop] = propVal
        }
      }

      await jail.set(key, new ivm.ExternalCopy(dataEntries).copyInto())

      for (const [prop, fn] of fnProps) {
        await injectFn(ctx, fn, `globalThis[${JSON.stringify(key)}][${JSON.stringify(prop)}]`)
      }
      continue
    }

    await jail.set(key, value as string | number | boolean)
  }
}

async function injectFn(
  ctx: ivm.Context,
  fn: (...a: unknown[]) => unknown,
  target: string
): Promise<void> {
  const sab = new SharedArrayBuffer(4)
  const signal = new Int32Array(sab)
  const pending: { result: { ok: boolean; v?: unknown; e?: string } | null } = { result: null }

  const startCb = new ivm.Callback(
    (...args: unknown[]) => {
      try {
        const ret = fn(...args)
        const p = ret instanceof Promise ? ret : Promise.resolve(ret)
        p.then(
          (v) => {
            pending.result = { ok: true, v }
            Atomics.store(signal, 0, 1)
            Atomics.notify(signal, 0)
          },
          (e: unknown) => {
            const err = e as { message?: string }
            pending.result = { ok: false, e: err?.message ?? String(e) }
            Atomics.store(signal, 0, 1)
            Atomics.notify(signal, 0)
          }
        )
      } catch (e) {
        const err = e as { message?: string }
        pending.result = { ok: false, e: err?.message ?? String(e) }
        Atomics.store(signal, 0, 1)
        Atomics.notify(signal, 0)
      }
    },
    { ignored: true }
  )

  const getResultCb = new ivm.Callback(() => {
    const r = pending.result!
    pending.result = null
    Atomics.store(signal, 0, 0)
    return new ivm.ExternalCopy(r).copyInto()
  })

  await ctx.evalClosure(
    `const _s=$0,_sig=new Int32Array(_s),_start=$1,_get=$2
     ${target} = function(...a) {
       _start(...a)
       Atomics.wait(_sig, 0, 0)
       const r = _get()
       if (!r.ok) throw new Error(r.e)
       return r.v
     }`,
    [new ivm.ExternalCopy(sab).copyInto(), startCb, getResultCb]
  )
}
