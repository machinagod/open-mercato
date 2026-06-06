// Patches Turbopack's emitted Node.js runtime chunks so the Next build can run
// under Deno. Under Deno's node-compat, the Turbopack async-module runtime can
// evaluate a synchronous import chain that reaches a module whose defining chunk
// is only scheduled via an async/dynamic-import path that hasn't executed yet, so
// its factory isn't registered ("module factory is not available" during page-data
// collection). Node's evaluation order loads it in time; Deno's doesn't.
//
// The patch makes instantiateModule self-heal: on a missing factory it eagerly
// require()s every not-yet-loaded sibling chunk (synchronous; only runs on the
// miss path) so the factory becomes available, then retries. No-op under Node and
// once all chunks are loaded.
//
// Idempotent. Run after every `next build` that targets the Deno runtime, against
// the build output dir (default apps/mercato/.mercato/next).
//
// Usage: deno run -A scripts/deno-patch-turbopack-runtime.mjs [buildDir]

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..')
const buildDir = (typeof Deno !== 'undefined' ? Deno.args[0] : process.argv[2])
  || join(repoRoot, 'apps/mercato/.mercato/next')

const MARKER = '__denoEagerLoadAllChunks'

const HELPER = `
let __denoAllChunksLoaded = false;
function __denoEagerLoadAllChunks(id) {
    if (__denoAllChunksLoaded) return;
    let fs;
    try { fs = require('fs'); } catch (e) { return; }
    let names;
    try { names = fs.readdirSync(__dirname); } catch (e) { return; }
    for (const name of names) {
        if (!isJs(name)) continue;
        const full = require('path').join(__dirname, name);
        const chunkPath = require('path').relative(RUNTIME_ROOT, full);
        if (loadedChunks.has(chunkPath) || chunkCache.has(chunkPath)) continue;
        try {
            installCompressedModuleFactories(require(full), 0, moduleFactories);
            loadedChunks.add(chunkPath);
        } catch (e) {}
        if (moduleFactories.has(id)) return;
    }
    __denoAllChunksLoaded = true;
}
`

function findRuntimes(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch (e) { continue }
    for (const entry of entries) {
      const full = join(cur, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      if (entry.name === '[turbopack]_runtime.js') out.push(full)
    }
  }
  return out
}

function patchOne(file) {
  let source = readFileSync(file, 'utf8')
  if (source.includes(MARKER)) return 'already'

  // 1. Inject the helper just before loadChunkAsync's definition.
  const anchor = 'function loadChunkAsync(chunkData) {'
  if (!source.includes(anchor)) return 'no-anchor'
  source = source.replace(anchor, HELPER + '\n' + anchor)

  // 2. Make instantiateModule recover before throwing. The emitted code is:
  //      function instantiateModule(id, sourceType, sourceData) {
  //          const moduleFactory = moduleFactories.get(id);
  //          if (typeof moduleFactory !== 'function') {
  const head = /function instantiateModule\(id, sourceType, sourceData\) \{\s*const moduleFactory = moduleFactories\.get\(id\);\s*if \(typeof moduleFactory !== 'function'\) \{/
  if (!head.test(source)) return 'no-instantiate'
  source = source.replace(
    head,
    `function instantiateModule(id, sourceType, sourceData) {
    let moduleFactory = moduleFactories.get(id);
    if (typeof moduleFactory !== 'function') {
        __denoEagerLoadAllChunks(id);
        moduleFactory = moduleFactories.get(id);
    }
    if (typeof moduleFactory !== 'function') {`,
  )

  writeFileSync(file, source)
  return 'patched'
}

const runtimes = findRuntimes(buildDir)
if (runtimes.length === 0) {
  console.error(`[deno-patch-turbopack] no [turbopack]_runtime.js under ${buildDir}`)
  if (typeof Deno !== 'undefined') Deno.exit(1); else process.exit(1)
}
let patched = 0, skipped = 0, failed = 0
for (const file of runtimes) {
  const result = patchOne(file)
  if (result === 'patched') patched++
  else if (result === 'already') skipped++
  else { failed++; console.error(`[deno-patch-turbopack] FAILED (${result}): ${file}`) }
}
console.log(`[deno-patch-turbopack] runtimes=${runtimes.length} patched=${patched} already=${skipped} failed=${failed}`)
if (failed > 0) { if (typeof Deno !== 'undefined') Deno.exit(1); else process.exit(1) }
