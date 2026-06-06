// Deno-native package builder — the toolchain replacement for `turbo run build
// --filter='./packages/*'` on runtimes where yarn/turbo cannot run (Deno Deploy's
// Deno builder). Reads every packages/*/package.json, topo-sorts by the
// @open-mercato/* dependency graph, and runs each package's build.mjs under the
// current runtime (Deno or Node — both expose the same esbuild build scripts).
//
// Usage (Deno):  deno run -A scripts/build-packages-deno.mjs [pkgName ...]
// Usage (Node):  node scripts/build-packages-deno.mjs [pkgName ...]
//
// With no args it builds the full dependency closure of every workspace package.
// With explicit package names (short suffix, e.g. `core ui`) it builds only the
// closure required to satisfy those targets, in dependency order.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = path.join(repoRoot, 'packages')

const isDeno = typeof globalThis.Deno !== 'undefined'

function readPackages() {
  const byName = new Map()
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(packagesDir, entry.name)
    const manifestPath = path.join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!manifest.name) continue
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    }
    const internalDeps = Object.keys(deps).filter((dep) => dep.startsWith('@open-mercato/'))
    byName.set(manifest.name, {
      name: manifest.name,
      dir,
      hasBuild: existsSync(path.join(dir, 'build.mjs')),
      internalDeps,
    })
  }
  return byName
}

// Kahn topo-sort over the internal dependency graph (deps build before dependents).
function topoSort(byName, targets) {
  const inClosure = new Set()
  const visit = (name) => {
    if (inClosure.has(name) || !byName.has(name)) return
    inClosure.add(name)
    for (const dep of byName.get(name).internalDeps) visit(dep)
  }
  for (const target of targets) visit(target)

  const ordered = []
  const visited = new Set()
  const visiting = new Set()
  const dfs = (name) => {
    if (visited.has(name)) return
    if (visiting.has(name)) return // cycle: emit anyway, esbuild bundles are independent
    visiting.add(name)
    for (const dep of byName.get(name).internalDeps) {
      if (inClosure.has(dep)) dfs(dep)
    }
    visiting.delete(name)
    visited.add(name)
    ordered.push(name)
  }
  for (const name of inClosure) dfs(name)
  return ordered
}

function resolveTargets(byName, argv) {
  if (argv.length === 0) return [...byName.keys()]
  const resolved = []
  for (const arg of argv) {
    const full = arg.startsWith('@open-mercato/') ? arg : `@open-mercato/${arg}`
    if (!byName.has(full)) {
      console.error(`[build-packages-deno] unknown package: ${arg}`)
      exit(1)
    }
    resolved.push(full)
  }
  return resolved
}

function exit(code) {
  if (isDeno) globalThis.Deno.exit(code)
  else process.exit(code)
}

async function runBuild(pkg) {
  const script = path.join(pkg.dir, 'build.mjs')
  if (isDeno) {
    const command = new globalThis.Deno.Command(globalThis.Deno.execPath(), {
      args: ['run', '-A', script],
      cwd: pkg.dir,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const { code } = await command.output()
    return code
  }
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, [script], { cwd: pkg.dir, stdio: 'inherit' })
  return result.status ?? 1
}

async function main() {
  const argv = (isDeno ? globalThis.Deno.args : process.argv.slice(2)).filter(Boolean)
  const byName = readPackages()
  const targets = resolveTargets(byName, argv)
  const order = topoSort(byName, targets).filter((name) => byName.get(name).hasBuild)

  console.log(`[build-packages-deno] runtime=${isDeno ? 'deno' : 'node'} building ${order.length} package(s):`)
  console.log(`  ${order.map((name) => name.replace('@open-mercato/', '')).join(' → ')}`)

  const started = (isDeno ? globalThis.Deno : globalThis.process)
  const startMs = nowMs(started)
  for (const name of order) {
    const pkg = byName.get(name)
    const code = await runBuild(pkg)
    if (code !== 0) {
      console.error(`[build-packages-deno] FAILED: ${name} (exit ${code})`)
      exit(code)
    }
  }
  console.log(`[build-packages-deno] all packages built in ${Math.round((nowMs(started) - startMs) / 1000)}s`)
}

function nowMs() {
  // performance.now() is available on both runtimes and unaffected by the
  // Date.now() restriction in the workflow sandbox; safe in a plain build script.
  return performance.now()
}

await main()
