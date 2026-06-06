/**
 * Shared sandbox contract + runtime-agnostic helpers.
 *
 * Two implementations satisfy this contract, selected at runtime by `index.ts`:
 *   - `ivm.ts`    — isolated-vm (Node); the original engine, unchanged.
 *   - `worker.ts` — Deno Worker with `permissions: "none"` (Deno Deploy target),
 *                   which cannot load native nan addons like isolated-vm.
 */

export interface SandboxOptions {
  /** Execution timeout in milliseconds (default: 30_000) */
  timeout?: number
  /** Maximum output size in bytes (default: 1_048_576 / 1MB) */
  maxOutputSize?: number
  /** Maximum number of api.request() calls allowed (default: 50) */
  maxApiCalls?: number
}

export interface SandboxResult {
  result: unknown
  error?: string
  logs: string[]
  durationMs: number
  apiCallCount?: number
}

export interface Sandbox {
  execute(code: string): Promise<SandboxResult>
}

const sandboxEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
export const MEMORY_LIMIT_MB = parseInt(sandboxEnv.SANDBOX_MEMORY_MB ?? '32', 10)
export const MAX_LOG_ENTRIES = 100
export const MAX_LOG_ENTRY_LENGTH = 1000

/**
 * Normalize AI-generated code: strip markdown fencing and validate shape.
 * Runtime-agnostic — identical behavior under both engines.
 */
export function normalizeCode(code: string): string {
  let normalized = code.trim()

  normalized = normalized
    .replace(/^```(?:javascript|js|typescript|ts)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim()

  if (!/^\s*async\s*\(/.test(normalized)) {
    const isStatement =
      /^\s*(const|let|var|for|while|if|try|switch|return|throw|class|function)\b/.test(normalized)
    normalized = isStatement
      ? `async () => { ${normalized} }`
      : `async () => { return ${normalized} }`
  }

  return normalized
}

/** Format console arguments into a single log line (shared by both engines). */
export function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

/** Append a formatted log entry, honoring the count + length caps. */
export function pushLog(logs: string[], args: unknown[]): void {
  if (logs.length >= MAX_LOG_ENTRIES) return
  const message = formatLogArgs(args)
  logs.push(
    message.length > MAX_LOG_ENTRY_LENGTH
      ? message.slice(0, MAX_LOG_ENTRY_LENGTH) + '...'
      : message
  )
}

/**
 * True when running under the Deno runtime (the Worker engine target).
 * Local copy of @open-mercato/shared/lib/runtime/detect#isDenoRuntime — kept
 * inline so the Deno Worker engine graph stays self-contained.
 */
export function isDenoRuntime(): boolean {
  const d = (globalThis as { Deno?: { version?: { deno?: string } } }).Deno
  return typeof d !== 'undefined' && typeof d?.version?.deno === 'string'
}
