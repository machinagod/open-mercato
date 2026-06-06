/**
 * Sandboxed Code Execution Engine (runtime-selected).
 *
 * Re-exports the runtime-selected sandbox factory. On Node the isolated-vm
 * engine runs; on Deno (where isolated-vm cannot load) a `Worker` engine with
 * `permissions: "none"` runs instead. Both satisfy the same contract.
 *
 * See ./sandbox/shared.ts for the contract and ./sandbox/{ivm,worker}.ts for
 * the two engines.
 */

export { createSandbox, normalizeCode } from './sandbox/index'
export type { Sandbox, SandboxOptions, SandboxResult } from './sandbox/shared'
