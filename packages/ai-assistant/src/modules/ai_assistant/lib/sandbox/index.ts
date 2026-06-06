/**
 * Runtime-selected sandbox factory.
 *
 * Picks the engine lazily at execution time so the native `isolated-vm` addon
 * (imported only by `./ivm`) is never loaded under Deno, and the Worker engine
 * (`./worker`) is never loaded under Node.
 */

import { isDenoRuntime, type Sandbox, type SandboxOptions } from './shared'

export { normalizeCode } from './shared'
export type { Sandbox, SandboxOptions, SandboxResult } from './shared'

export function createSandbox(globals: Record<string, unknown>, options: SandboxOptions = {}): Sandbox {
  return {
    async execute(code: string) {
      const engine = isDenoRuntime() ? await import('./worker') : await import('./ivm')
      return engine.createSandboxImpl(globals, options).execute(code)
    },
  }
}
