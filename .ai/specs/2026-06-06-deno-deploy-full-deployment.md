# Full Deno Deploy Deployment of Open Mercato

> **Status: Production-deployment spec.** Synthesizes the prior Deno specs into an
> actionable plan to run the full Open Mercato app on Deno Deploy. Some phases are
> **gated on platform/plan decisions** (called out explicitly) rather than code.
>
> Builds on: [`…-runtime-feasibility`](./2026-06-06-deno-deploy-runtime-feasibility.md),
> [`…-vertical-slice`](./2026-06-06-deno-deploy-vertical-slice.md),
> [`…-native-dependency-removal`](./2026-06-06-deno-native-dependency-removal.md),
> and [`.ai/references/deno-deploy.md`](../references/deno-deploy.md).
>
> **Date:** 2026-06-06 · **Driver:** Ops simplicity / cost · **Defer Prisma [ORM]** (MikroORM v7 stays).

## TLDR

**Proven (green):** Next.js 16 builds and **runs under Deno** (SSR/API/middleware/auth/encryption); MikroORM v7 connects to **Prisma Postgres over direct TCP** from a Deno Deploy isolate; `Deno.cron` + a Postgres job drains on the isolate; the **native-addon surface is now Deno-compatible** (sandbox/SQLite/images/canvas — see the native-dep PR). A single-file **bundle** of the data layer deploys+runs on an isolate.

**Gating walls (not code — platform/plan):**
1. **Build-on-Deploy is capped at 5 minutes** (plan tier) — a cold monorepo `yarn install + build:packages×2 + generate + next build` does not fit.
2. **Deno Deploy builders run commands under Deno node-compat**, where **corepack crashes** (`node:crypto` `Digest already called`) — yarn 4 can't bootstrap.
3. **Prebuilt standalone**: Deno Deploy's dynamic runtime ships only the statically-traced ESM graph — Next standalone's CJS `require('next')` + `.next` fs-reads aren't carried (`Cannot find module 'next'`).

**This spec's job:** define the target architecture + the two viable unblock paths and their exact requirements, and sequence the implementable work (worker/cache tiers) ahead of the gated build/deploy step.

## Target Architecture

```
                    Deno Deploy (new platform, region us/eu)
  ┌───────────────────────────────────────────────────────────┐
  │ Web tier — Next.js 16 (App Router) under Deno              │
  │   • SSR + API routes + Proxy middleware  (all proven)      │
  │   • runtime adapters pick Deno engines (sandbox/sqlite/img)│
  │ Background — Deno.cron (no live server needed)             │
  │   • drains a Postgres job table (FOR UPDATE SKIP LOCKED)   │
  └───────────────┬───────────────────────────────────────────┘
                  │ direct TCP (DATABASE_URL=postgresql://…)
        ┌─────────▼─────────┐        external (HTTP):
        │ Prisma Postgres   │        • Meilisearch (search)
        │ (managed, 1/plan) │        • Stripe / Resend (HTTP APIs)
        └───────────────────┘
```

- **Data:** Prisma Postgres, **direct `postgres://` TCP** (MikroORM v7). The Accelerate `prisma://` URL is ignored. Prisma Postgres is the *DB*, not the ORM — **Prisma [ORM] stays deferred.**
- **No Redis, no Deno KV.** KV and Postgres can't coexist on one app; Deno Deploy dropped Queues. ⇒ **Postgres is the single shared-state backbone** (queue, cache, rate-limit, locks, events). This matches the ops-simplicity driver.
- **Workers/scheduler:** `Deno.cron` + a Postgres-backed job queue (proven pattern) instead of BullMQ+Redis and the spawned-worker/file-queue tiers (which can't run on edge).
- **Cache / rate-limit:** Postgres-backed strategies (memory is per-isolate and useless at the edge; SQLite needs a writable FS).
- **Native engines:** selected at runtime — Deno Worker sandbox, `node:sqlite`, `wasm-vips`, graceful PDF-canvas degradation (native-dep PR).

## The build/packaging decision (the crux)

| Path | How | Blockers / requirements |
|---|---|---|
| **A. Framework preset** (`config.framework:"nextjs"`, build on Deploy) | Deploy installs + `next build` + serves Next natively (handles `node_modules`) | ❌ 5-min build cap (plan); ❌ corepack-under-Deno-builder (yarn 4). **Unblock:** higher plan tier for build minutes **AND** a yarn-4-without-corepack install (committed `.yarn/releases` run via `node`, or pre-vendored deps) — pending confirmation the Deno builder can run it. |
| **B. Prebuilt standalone** (build locally on Node, upload artifact) | `OM_STANDALONE=1 next build` → `server.cjs` + traced `node_modules`; deploy as `runtime:dynamic` | ❌ dynamic runtime doesn't ship the CJS-required `node_modules`/`.next` data. **Unblock:** get those files carried (no `--include` knob found) OR bundle the server self-contained (Next's server resists `deno bundle`). |
| **C. Bundle** (proven for the data slice) | `deno bundle` inlines everything into one file | ✅ for plain Deno services; ⚠️ Next's server (dynamic requires + fs reads of `.next`) is not cleanly bundleable today. |

**Recommendation:** pursue **A (framework preset) on a build-capable plan tier** — it's the Deno-blessed Next path and avoids the artifact-shipping problem. Treat the plan-tier build minutes + a corepack-free yarn bootstrap as explicit prerequisites. Keep **C** as the proven fallback for any extracted Deno-native services.

## Implementation Plan

### Phase 0 — Native-dep removal · **DONE** (separate PR)
Runtime adapters for sandbox / SQLite / images / canvas. Prereq for any Deno runtime.

### Phase 1 — Postgres-backed worker tier · *implementable now*
- Add a `postgres` queue strategy to `@open-mercato/queue` (alongside `local`/`async`): a `jobs` table drained via `FOR UPDATE SKIP LOCKED`, triggered by `Deno.cron` (and a Node poller for parity). Selected by `QUEUE_STRATEGY=postgres`.
- Port the scheduler to the same (it already has a DB-polling `local` mode — wire `Deno.cron` to it).
- **Exit:** events/search-indexing/workflow async activities run on Postgres+cron under Deno; no Redis, no spawned workers.

### Phase 2 — Postgres-backed cache + rate-limit · *implementable now*
- Add a `postgres` cache strategy (`@open-mercato/cache`) with tag invalidation (schema mirrors the sqlite strategy). Add a Postgres rate-limit store (`@open-mercato/shared/lib/ratelimit`). Select under Deno when no Redis.
- **Exit:** shared state works on the edge without Redis/KV/FS.

### Phase 3 — DB + connection model · *config*
- Provision Prisma Postgres; wire the **direct** `postgresql://` to `DATABASE_URL`; pool size 1 per isolate; confirm migrations run from Node CI (not on the isolate).

### Phase 4 — Build + deploy pipeline · **GATED** (platform/plan)
- Choose Path A/B/C per the decision table; resolve the plan-tier build cap + yarn bootstrap.
- Wire env (DB, encryption keys, `OM_SANDBOX_WORKER_PERMISSIONS`, `--unstable-worker-options` if Workers supported), `Deno.cron` registration, region.
- **Exit:** full app serves on a Deno Deploy URL with DB-backed reads/writes.

### Phase 5 — Cutover & ops
- Parity tests vs the Node deployment; performance budgets; rollback to the Node/Docker target if needed (kept in parallel).

## Risks & Impact Review

#### R-PLAT — Platform/plan gating (Phase 4)
- **Scenario:** 5-min build cap + corepack-under-Deno-builder block build-on-Deploy; dynamic runtime won't ship a prebuilt standalone's node_modules.
- **Severity:** High (blocks the deploy). **Mitigation:** plan-tier upgrade for build minutes + corepack-free yarn; or escalate the standalone-artifact gap with Deno. **Residual:** depends on platform — not solvable in app code alone.

#### R-WORKER — Worker support on isolates (Phase 4, R1 carry-over)
- **Scenario:** Deno Deploy isolates don't support nested Workers / `--unstable-worker-options`.
- **Severity:** Medium. **Mitigation:** feature-gate AI Code Mode off under Deno (stakeholder-accepted). **Residual:** Code Mode degraded on Deno until resolved.

#### R-PARITY — Postgres-backbone throughput (Phases 1–2)
- **Scenario:** Postgres queue/cache underperforms Redis at scale.
- **Severity:** Medium. **Mitigation:** indexed claim queries, batched cron drains, TTL cleanup; benchmark before cutover. **Residual:** noisy-neighbor at very high volume — revisit Redis-on-a-side-host if needed.

#### R-IMG — wasm-vips fidelity (carry-over R2)
- `contain` exact-box padding deferred; `cover` exact. **Mitigation:** golden-image review before serving production images under Deno.

## Final Compliance Report — 2026-06-06

| Rule Source | Rule | Status | Notes |
|---|---|---|---|
| BACKWARD_COMPATIBILITY.md | No contract-surface removal | Compliant | New queue/cache strategies are additive; runtime-selected |
| packages/queue/AGENTS.md | Worker contract / strategy pattern | Compliant (planned) | `postgres` strategy alongside `local`/`async` |
| packages/cache/AGENTS.md | DI-resolved cache, strategy pattern | Compliant (planned) | `postgres` strategy added |
| root AGENTS.md | Tenant scoping on all scoped entities | Must-honor | Postgres queue/cache rows scoped by tenant/org |

**Verdict:** Approved as a phased program. Phases 0–3 are implementable now and BC-safe; Phase 4 is gated on a platform/plan decision (documented).

## Open Questions
- **Q1 (Phase 4):** which Deno Deploy plan tier (build minutes) — confirm the cap that fits the monorepo build, or commit to the prebuilt-artifact path if the platform gap is closed.
- **Q2:** Workers on isolates — supported? (decides AI Code Mode on Deno).
- **Q3:** keep the Node/Docker deployment in parallel during cutover (recommended) or hard-switch?

## Changelog
### 2026-06-06
- Initial full-deployment spec. Target architecture (Postgres backbone, Deno engines), build/packaging decision table, 6-phase plan (Phase 0 done; 1–3 implementable; 4 gated on platform/plan). Awaiting Q1–Q3.
- **Phase 1 (Postgres worker tier) — IMPLEMENTED, verdict: PASS.** Added a `postgres` queue strategy to `@open-mercato/queue` (`QUEUE_STRATEGY=postgres`): durable `queue_jobs` table drained via `FOR UPDATE SKIP LOCKED`; `process()` claims+runs a batch and returns counts (Deno.cron-friendly); `pg` against `DATABASE_URL`, ref-counted pool; retry/backoff. Additive — `local`/`async` unchanged. Verified end-to-end against the real Prisma Postgres (enqueue/process/counts/retry-backoff/clear) + env-gated Deno test. Queue package builds clean.
- **Phase 2 (cache) — IMPLEMENTED, verdict: PASS.** Added a `postgres` cache strategy to `@open-mercato/cache` (`CACHE_STRATEGY=postgres`): `cache_entries`/`cache_tags` (mirrors the SQLite schema), tag invalidation, TTL, cleanup; `pg`/`DATABASE_URL`, transactional set/delete/clear; `pg` added as optional peer dep. Verified against real Prisma Postgres (set/get/has/delete/tags/ttl/cleanup) + env-gated Deno test. Cache builds clean.
- **Phase 2 (rate-limit) — DEFERRED.** `rate-limiter-flexible` ships `RateLimiterPostgres` (needs a managed store client + table lifecycle); rate-limiting degrades safely to in-process memory meanwhile. Tracked as a follow-up.
- **Net:** the Postgres shared-state backbone (jobs + cache) is implemented and verified on the live DB — so once the Phase-4 build/deploy gate clears, the worker + cache tiers are Deno-ready with no Redis/KV. Phase 3 (DB wiring) is config; Phase 4 remains platform/plan-gated.
- **Phase 4 prep — generate-time module selection (CRM slimming) — IMPLEMENTED.** Added opt-in `OM_MODULE_PRESET=crm` / `OM_ENABLED_MODULES=…` to the generator's resolver (`packages/cli/src/lib/resolver.ts`): filters the modules baked into the generated registries → the CRM app compiles `customers`+`catalog`+deps only (dropping `sales`/`ai_assistant`/`webhooks`/`portal`/…). CRM `next build` compiles in **7.8s vs 13s** full; smaller `.next` output. Also fixed two full-build bugs surfaced en route (image dir import; `wasm-vips` externalize+install).
  - **Honest build-time decomposition (important for the 5-min cap):** module selection trims **`next build` + generate + output size + runtime footprint**, but does **NOT** reduce **`yarn install`** (deps are package-level, not module-gated) or **`yarn build:packages`** — `@open-mercato/core` is a **single package** holding *all* modules' source, so it's compiled in full regardless of the preset. Those two dominate the cold Deno Deploy builder time. So CRM selection **alone doesn't fit the 5-min build-on-Deploy cap**.
  - **What it does unlock:** a smaller, cleaner **prebuilt bundle** — build the CRM-slim app **locally on Node**, `deno bundle` it, upload → sidesteps the 5-min builder cap *and* the standalone `node_modules`-shipping gap. This is the recommended path for a CRM-only Deno Deploy.
  - **To cut build-on-Deploy further** would require splitting `@open-mercato/core` into per-module packages (so `build:packages` skips commerce/AI/etc.) + pruning deps — a larger refactor (the literal "break up the modules").
  - PR note: the 2 build fixes pertain to PR #1's adapter but currently sit in PR #2 (stacked); merge #1+#2 together or cherry-pick the 2 files to #1.

### DECISIVE VERDICT — the full Next app cannot deploy to Deno Deploy (any current path)
All three Phase-4 paths are now empirically closed — and the CRM slimming, while it shrank the app (197MB standalone, 7.8s build), does **not** unblock any of them:
1. **Framework preset (build on Deploy) — DEAD, not even a plan upgrade fixes it.** Deno Deploy runs build commands under **Deno node-compat**, and the Node toolchain doesn't run there: corepack crashes (`node:crypto` "Digest already called") **and** a direct yarn 4 release crashes (`Error: Dynamic require of "util" is not supported`). No way to bootstrap yarn 4 → can't install/build the workspace monorepo. (`next build` is similarly Node-native.)
2. **Prebuilt standalone (upload) — DEAD.** Deno Deploy's dynamic runtime ships only the statically-traced module graph; Next standalone's CJS `require('next')` + `node_modules` aren't carried.
3. **`deno bundle` the standalone — DEAD.** Bundling Next's server fails resolving react-dom's pruned conditional dev/prod export files (`react-dom-server.node.development.js` not found) — Next's server isn't `deno bundle`-able.

**Conclusion:** the **runtime** is Deno-compatible (proven: `next start` serves under Deno; native deps replaced; Postgres backbone works), but **Deno Deploy's build + packaging model is fundamentally incompatible** with this Next + yarn-workspace monorepo. This is a platform/toolchain mismatch, not a code or plan-tier issue.

**Viable alternatives (recommended):**
- **(A) Host the Next app on a Node/Deno container** (Fly/Railway/Cloud Run/etc.) that runs the prebuilt standalone with `next start` — the runtime is ready; only Deno Deploy's build model is the blocker. Lowest effort, keeps the full app.
- **(B) Use Deno Deploy only for extracted Deno-native services.** A single-file `deno bundle` of a **non-Next** Deno service deploys + runs on an isolate cleanly (proven: the data slice). A CRM **API** could be re-expressed as a Deno-native service (Hono/Oak + the MikroORM customers entities, which run under Deno against Prisma Postgres) and deployed there — without the Next UI.
- **(C) Split `@open-mercato/core` into per-module packages + drop the yarn-workspace build from the deploy** — large refactor; still bounded by yarn-not-running-on-the-Deno-builder unless the deployed unit avoids a workspace install entirely.

The native-dep removal + Postgres backbone (PRs #1, #2) remain the necessary foundation for any of these — they make the app Deno-runtime-ready regardless of host.

### VERDICT REVERSAL — the build IS Deno-native; one Turbopack-worker bug is the only remaining blocker
The "DECISIVE VERDICT" above rested on premise #1: *"the Node toolchain doesn't run on the Deno builder (corepack/yarn crash), so the framework preset is dead."* That premise assumed the build must go **through yarn**. Ripping yarn and going **Deno-native** invalidates it. Empirically (all run with **zero yarn**, the Deno binary only):
- **`deno install` — PASS.** Resolves the workspace (`workspace:*`) + npm deps into `node_modules`; no corepack/yarn bootstrap needed.
- **`deno run scripts/build-packages-deno.mjs` — PASS.** A topo-sorting builder (replaces `turbo run build`) runs each package's existing `build.mjs` (esbuild) under Deno. Full CRM closure (11 packages) builds in ~4s.
- **`deno run packages/cli/dist/bin.js generate` — PASS.** All generators complete; CRM preset emits 135 API routes (vs 361 full).
- **`deno run …/next/dist/bin/next build` — PARTIAL.** Compiles (✓ 7.9s) **and type-checks (✓ 14.6s)**, then **fails at "Collecting page data"**: a Turbopack *runtime* error — `Module … instantiated … but the module factory is not available` — thrown while Deno's node-compat **build workers** execute the compiled server chunk for `packages/shared/dist/lib/auth`. The **identical `next build` under Node is fully green** (static pages generated, route table printed). So this is **not** a code error and **not** a yarn/install problem — it is a Turbopack-prod-runtime/Deno-`worker_threads` chunk-loading incompatibility (Node tolerates the chunk-factory instantiation order; Deno's worker loader doesn't). `--webpack` is not a fallback here (repo is Turbopack-native; webpack emits barrel-export errors).
- These wired as `deno task build:crm` / `build:deno` in `deno.json`; builder is `scripts/build-packages-deno.mjs`.

**Revised conclusion:** the toolchain mismatch is **gone** — install + package build + generate + compile + type-check all run on the Deno builder. The blocker is narrowed to a **single, well-characterized Turbopack-runtime-under-Deno-workers bug** at page-data collection. Two paths forward, in priority order:
- **(A — recommended, proven) Build with Node, serve with Deno.** The `.mercato/next` artifact is runtime-agnostic; Node produces it green and Deno `next start` serves it (proven: 200s under Deno). On Deno Deploy this needs the build-command to invoke `node` (if present on their builder) or a prebuilt artifact upload; the runtime/serve tier is Deno-native today.
- **(B) Fix the Turbopack/Deno worker bug** so the whole pipeline runs on the Deno builder via the framework preset. **Investigated in depth below (PATH B DEEP-DIVE): it is not a single bug but a class of Deno↔Turbopack-runtime incompatibilities with a hard mid-build delivery blocker — an upstream-grade effort, not a clean in-repo fix.**

Also fixed en route: a latent `AlertProps` type collision (`style` intersected `CSSProperties & AlertStyle`, making both un-passable) that blocked **any** production `next build` once core's `./*`→src `types` export put the page under type-check. One-line `Omit<…, 'role' | 'style'>` fix; no behavior change (inline CSS on `Alert` was already un-typable).

### PATH B DEEP-DIVE — it is not one bug; it is a class of Deno↔Turbopack-runtime incompatibilities, with a hard mid-build delivery blocker
Pursued path B (fix the worker bug → framework preset). Findings, each empirically established (repro: `require()` the built `route.js` in a standalone Deno process — it fails identically to the in-build worker; **Node runs the same Deno-built chunks fine**, so the chunk graph is correct and the divergence is purely runtime execution):

1. **Bug #1 — async-chunk-load ordering (root-caused + mechanism-fixed).** Turbopack code-splits the catch-all route's graph; an **async module** does a *synchronous* `ctx.i(...)` chain that reaches a module (e.g. `mammoth`'s `createBodyReader`) whose defining chunk is only scheduled via a dynamic-import (`ctx.l`) path. Node's evaluation order requires that chunk in time (its factory is registered); Deno's does not → `module factory is not available`. **Fix that works:** make `instantiateModule` self-heal — on a missing factory, eagerly `require()` the not-yet-loaded sibling chunks (registration only, no factory execution), then retry. Implemented two ways: `scripts/deno-patch-turbopack-runtime.mjs` (post-build file patch) and `scripts/deno-build-runtime-hook.mjs` (a `--import` preload that patches the runtime at CJS `_compile` time). Validated: the standalone repro advances **past** bug #1 with the patch applied.

2. **Delivery blocker — the fix can't reach where it runs.** Page-data collection executes the emitted chunks **inside `next build`**, in **forked jest-worker child processes** (`getNumberOfWorkers()` ≥ 1, always forks; no inline mode). The emitted Turbopack runtime is generated from a template **compiled into Turbopack's native binary** (not a patchable JS file), so a post-build patch is too late, and the `--import` preload patches only the **main** process — Deno's forked workers don't inherit `--import` (no `execArgv` propagation), so the workers still use the unpatched runtime and bug #1 re-fires. Confirmed: `deno run --import scripts/deno-build-runtime-hook.mjs next build` still fails at collection.

3. **Bug #2 — mangled external specifiers.** With bug #1 patched, the repro surfaces a *distinct* failure: `externalImport("@mikro-orm/core-ee398878cb81640c")` → Deno `import()` rejects ("not a dependency"). Turbopack tags externalized packages with a `-<hash>` suffix. (Node also can't import that bare specifier in isolation, so this may partly be a collection-environment artifact — but it is a second, independent resolution concern beyond bug #1.)

**Path B conclusion:** the framework-preset path needs **upstream** fixes — Deno node-compat (forked-worker `execArgv`/preload inheritance; async-module + dynamic-chunk scheduling parity) and/or a Turbopack runtime that tolerates Deno's load order and a non-mangled external resolution. The in-repo eager-load patch is a real, validated fix for bug #1 but cannot be injected into the build's worker processes today. **Recommendation stands: ship via path A (build-Node / serve-Deno), and file bug #1 (with the standalone repro) and the worker-`execArgv` gap upstream to Deno/Next.** The two scripts are committed as the documented repro + fix for that upstream report.
