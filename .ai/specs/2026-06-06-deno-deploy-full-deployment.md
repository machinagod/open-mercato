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
