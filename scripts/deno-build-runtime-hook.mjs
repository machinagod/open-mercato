// Deno `--import` preload that patches Turbopack's Node.js runtime at CJS
// compile-time (Module.prototype._compile), so the fix is present BEFORE Next's
// page-data collection executes the emitted chunks — which is inside `next build`,
// where a post-build file patch can't reach. See scripts/deno-patch-turbopack-runtime.mjs
// for the standalone (post-build) variant and the bug rationale.
//
// Usage: deno run -A --import ./scripts/deno-build-runtime-hook.mjs <next> build

import Module from 'node:module'

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

const INSTANTIATE_HEAD = /function instantiateModule\(id, sourceType, sourceData\) \{\s*const moduleFactory = moduleFactories\.get\(id\);\s*if \(typeof moduleFactory !== 'function'\) \{/

function patch(source) {
  if (source.includes(MARKER)) return source
  if (!source.includes('function loadChunkAsync(chunkData) {')) return source
  if (!INSTANTIATE_HEAD.test(source)) return source
  source = source.replace('function loadChunkAsync(chunkData) {', HELPER + '\nfunction loadChunkAsync(chunkData) {')
  source = source.replace(INSTANTIATE_HEAD, `function instantiateModule(id, sourceType, sourceData) {
    let moduleFactory = moduleFactories.get(id);
    if (typeof moduleFactory !== 'function') {
        __denoEagerLoadAllChunks(id);
        moduleFactory = moduleFactories.get(id);
    }
    if (typeof moduleFactory !== 'function') {`)
  return source
}

const origCompile = Module.prototype._compile
Module.prototype._compile = function (content, filename) {
  if (typeof filename === 'string' && filename.endsWith('[turbopack]_runtime.js')) {
    try { content = patch(content) } catch (e) { /* fail open: use original */ }
  }
  return origCompile.call(this, content, filename)
}
