# Vertical Slice — Validate Open Mercato data + worker backbone on Deno Deploy

> **Status: Spike spec (de-risking).** Small, time-boxed. Its only job is a clear go/no-go
> on "defer Prisma; runtime + hosting first." It is NOT a production design and ships no
> user-facing feature. Companion to [`2026-06-06-deno-deploy-runtime-feasibility.md`](./2026-06-06-deno-deploy-runtime-feasibility.md).
>
> **Date:** 2026-06-06 · **Driver:** Ops simplicity / cost · **Timebox:** ~1–2 weeks

## TLDR

**Key Points:**
- Prove, on a *deployed* Deno Deploy isolate, that the platform's stateful backbone works **without Redis, without KV, without a writable filesystem**: MikroORM v7 → Postgres over TCP, encrypted reads via `findWithDecryption`, and a `Deno.cron` + Postgres-backed job.
- Deliberately deploy a **minimal standalone Deno service** (extending the existing `main.ts` scaffold) that imports the *real* `@open-mercato` data layer — NOT the full Next.js app. This isolates the decisive data/worker risk from the separable "does the whole app port" risk.

**Scope (in):**
- Deno service on the new Deno Deploy, reusing real MikroORM v7 entities + the shared ORM bootstrap.
- One non-encrypted entity CRUD + one encrypted-field read (proves `node:crypto` path).
- One Postgres-backed job drained by `Deno.cron`.
- Programmatic app creation + deploy using the provided Deno Deploy tokens.

**Scope (out, deferred to later slices):**
- Booting the full `apps/mercato` Next.js app under Deno.
- Porting the queue/scheduler/cache strategy implementations.
- Any Prisma work. Any production hardening.

**Concerns:**
- DB is a **Deno Deploy-attached Prisma Postgres** (managed DB), provisioned at app creation; connection strings auto-injected as env. MikroORM must use the **direct `postgres://` TCP string**, not the Accelerate `prisma://` HTTP string.
- Two Deno Deploy tokens exist (`DENO_DEPLOY_TOKEN`, `DENO_DEPLOY_API_TOKEN`); org + app name still unconfirmed (Q2).

## Problem Statement

We want to move hosting to Deno Deploy for ops/cost simplicity, deferring the MikroORM→Prisma swap. That plan only holds if MikroORM v7 truly runs on a deployed Deno Deploy isolate against Postgres, and if the Redis/file/long-poll-dependent background tier has an edge-native replacement. Both are currently *believed* (MikroORM v7 dropped knex → Kysely, multi-runtime as of Apr 2026; DB access on new Deploy confirmed by stakeholder) but **unproven in this codebase on the live platform**. A wrong assumption flips the entire sequencing (pulls Prisma onto the critical path), so it must be tested cheaply before any broad spec.

## Proposed Solution

Build `deno-slice/` — a minimal Deno HTTP service (evolved from the repo's `main.ts` + `Deno.serve`) that:
1. Imports real entities from `@open-mercato/core` (customers) and the shared MikroORM bootstrap from `@open-mercato/shared`, via npm/node compat.
2. Connects to Postgres over TCP using the standard `REDIS`-free config path (`MikroORM.init` + postgresql driver).
3. Exposes routes that exercise the make-or-break paths, then is deployed to Deno Deploy and re-tested **on the isolate** (local success is necessary but not sufficient).

This reuses production code (no reimplementation), so a pass is real evidence the data layer survives Deno.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| Minimal Deno service, not the Next.js app | Decouples the decisive data/worker risk from the heavy app-port risk; fails fast and cheap |
| Reuse real `@open-mercato` entities + ORM bootstrap | Proves *this codebase*, not a toy; tests the actual `node:*` + Kysely + decorator-metadata paths under Deno |
| Include one encrypted-field read | `findWithDecryption` is ~1,900 call sites on `node:crypto`; must confirm it works on Deno |
| Postgres-backed job + `Deno.cron` | Validates the Option-1 worker replacement (no Redis, no KV, no FS) directly |
| DB = Deno Deploy-attached **Prisma Postgres**, MikroORM over its direct TCP string | Uses the platform-native managed DB (matches the ops-simplicity goal) while keeping the ORM as MikroORM. **Prisma Postgres (DB) ≠ Prisma ORM** — "defer Prisma [ORM]" is unaffected |
| Spike-only encryption keys | Throwaway keys generated for the slice; no real key material reaches the sandbox |

## Architecture

```
Deno Deploy isolate ── Deno.serve(handler)
  ├─ GET  /health                 → liveness
  ├─ GET  /db/ping                → MikroORM v7 connect + trivial SELECT      [proves R2 + R4]
  ├─ POST /db/entity              → create a non-encrypted record (CRUD write) [proves R2]
  ├─ GET  /db/entity              → read it back                              [proves R2]
  ├─ GET  /db/encrypted           → findWithDecryption on an encrypted field  [proves node:crypto on Deno]
  └─ Deno.cron("drain-jobs", …)   → claim+process from a Postgres job table   [proves R1 worker replacement]
                                     using SELECT … FOR UPDATE SKIP LOCKED
        │
        └── TCP/TLS (direct postgres:// URL) ──►  Deno Deploy-attached Prisma Postgres
```

- ORM bootstrap reused from `packages/shared/src/lib/db/mikro.ts` (`getOrm()` / `registerOrmEntities`).
- Job table is a tiny purpose-built `slice_jobs(id, payload, status, locked_at)` — NOT the real queue tables; we are validating the *pattern*, not migrating the queue.
- No writable FS, no Redis env, no KV used anywhere — proves the edge constraints are satisfiable.

## Implementation Plan

### Phase A — Local proof (fail-fast, no deploy)
1. Create the Deno Deploy app + attached **Prisma Postgres** first (so the DB exists), and read back its **direct `postgres://` URL** for local use. (App creation also unblocks Phase B; we just don't deploy yet.)
2. Scaffold `deno-slice/` with `deno.json` import map resolving `@open-mercato/*` workspace packages (built output) via npm/node-compat.
3. Stand up the service locally against that direct Prisma Postgres URL; implement `/health`, `/db/ping`, `/db/entity` (POST+GET). Pool size 1.
4. Generate **spike-only encryption keys** (env); add `/db/encrypted` exercising `findWithDecryption` on a customers encrypted field.
5. Add `slice_jobs` table + `Deno.cron` drainer using `FOR UPDATE SKIP LOCKED`; enqueue via a route, confirm the cron processes it.
- **Exit A:** all routes + cron pass locally under `deno run` against the Prisma Postgres direct URL. If MikroORM v7 won't init or query under Deno here, **stop — escalate Prisma [ORM] decision.**

### Phase B — Deployed proof (the real test)
1. Configure the app's env on Deno Deploy: confirm the **direct** `postgres://` string is wired to the var MikroORM reads (the injected Accelerate `prisma://` URL is ignored for the ORM path); set spike-only encryption keys. Secrets never committed.
2. Deploy with `DENO_DEPLOY_TOKEN` (deployctl / `deno deploy`) to the **new** platform, scoped to the org from Q2; app/DB created via `DENO_DEPLOY_API_TOKEN` in Phase A step 1.
3. Re-run every route **against the deployed URL**; confirm `Deno.cron` fires on the isolate and drains a job.
- **Exit B (go/no-go):** deployed isolate connects to Postgres over TCP, CRUD + encrypted read succeed, and the cron-driven Postgres job drains. → "defer Prisma" validated; proceed to write the production migration spec. Any failure → documented blocker + recommendation (likely: pull Prisma/serverless-PG forward, or reconsider Deno Deploy).

### File Manifest
| File | Action | Purpose |
|------|--------|---------|
| `deno-slice/deno.json` | Create | Import map, tasks, cron permissions |
| `deno-slice/main.ts` | Create | `Deno.serve` handler + route table + `Deno.cron` |
| `deno-slice/db.ts` | Create | MikroORM v7 init reusing shared bootstrap + entities |
| `deno-slice/jobs.sql` | Create | `slice_jobs` table DDL (applied manually for the spike) |
| `deno-slice/README.md` | Create | How to run locally + deploy; env var names (no secrets) |

> Lives in a top-level `deno-slice/` throwaway dir, NOT under `apps/` or `packages/` — it is spike scaffolding, not a module. Remove or graduate after the go/no-go.

## Risks & Impact Review

This is throwaway, non-tenant, non-production code — blast radius is the spike DB only. Mapping to feasibility-memo risks:

#### R2 — MikroORM v7 unproven on Deno (the gating risk)
- **Scenario:** decorator metadata / Kysely runner / driver fails under Deno on the isolate.
- **Severity:** High. **Mitigation:** Phase A fails fast locally before any deploy spend. **Residual:** if it fails, Prisma returns to the critical path — captured as the spike's primary output.

#### R4 — Postgres TCP from edge isolate
- **Scenario:** connections refused/exhausted from the isolate.
- **Severity:** Medium (stakeholder reports DB access works; this confirms it for *this* driver). **Mitigation:** pool size 1 per isolate; Prisma Postgres direct connection. **Residual:** may require its pooled endpoint.

#### R6 — Wrong Prisma Postgres connection mode
- **Scenario:** MikroORM is pointed at the injected Accelerate `prisma://` HTTP URL instead of the direct `postgres://` TCP URL and can't connect.
- **Severity:** Low (config). **Mitigation:** Phase B step 1 explicitly wires the direct URL. **Residual:** none.

#### R1 — Worker tier replacement
- **Scenario:** `Deno.cron` + Postgres job pattern doesn't behave on Deploy.
- **Severity:** Medium. **Mitigation:** validated directly in Phase B. **Residual:** informs Option-1 vs split-tier in the real spec.

#### Spike-ops risks
- **Secrets:** tokens + DB URL set as Deno Deploy env vars and local `.env` only; **never committed**. `deno-slice/` adds `.env` to ignore.
- **Cost/cleanup:** delete the sandbox app + spike DB after go/no-go.

## Prerequisites / Open Questions

- **Q1 — Spike DB:** ✅ Resolved. Deno Deploy-attached **Prisma Postgres**, created at app provisioning; MikroORM uses the injected **direct `postgres://` URL**.
- **Q2 — Deno Deploy org/app:** ⏳ Open. Confirm the **org** the tokens belong to and a name for the throwaway app (proposed: `om-deno-slice`). Confirm `DENO_DEPLOY_API_TOKEN` is the org-scoped token for app + DB creation.
- **Q3 — Encryption keys:** ✅ Resolved. Generate **spike-only** keys; no real key material in the sandbox.

## Final Compliance Report — 2026-06-06

This is spike scaffolding outside the module system, so most module rules (acl.ts, makeCrudRoute, CrudForm, openApi, i18n) are intentionally **N/A**. Applicable rules:

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | Never commit credentials/tokens | Compliant | Env-only; `.env` ignored |
| root AGENTS.md | Filter by organization_id | N/A (spike) | Throwaway entity; documented |
| Data & Security | Use `findWithDecryption` not `em.find` | Compliant | Explicitly exercised in `/db/encrypted` |
| root AGENTS.md | No code under `apps/mercato/src/` | Compliant | Lives in throwaway `deno-slice/` |

**Verdict:** Approved as a time-boxed spike pending Q1–Q3.

## Changelog
### 2026-06-06
- Initial spike spec. Two-phase (local fail-fast → deployed go/no-go).
- Resolved Q1 (DB = Deno Deploy-attached Prisma Postgres, direct TCP URL; Prisma Postgres ≠ Prisma ORM) and Q3 (spike-only encryption keys). Added R6 (connection-mode). Q2 (org/app) still open. Awaiting spec review before implementation.
- **EXECUTED — verdict: GO.** Built `deno-slice/` (A1: MikroORM v7 via `npm:` specifiers + toy entity, same decorator/`ReflectMetadataProvider` mechanism as `mikro.ts`). Q2 resolved: org `machinagod-sandbox`, app `om-deno-slice`, DB `om-deno-slice-db` (Prisma Postgres). Proven on the **deployed isolate**: decorator-metadata compiles under Deno; MikroORM v7 connects to Prisma Postgres over **direct TCP** (`DATABASE_URL=postgresql://`); CRUD + unit-of-work + column mapping; Postgres-backed queue drained by `Deno.cron`. R6 closed favorably (direct URL injected, not Accelerate). R2/R4/R1 all passed.
- Findings captured in `.ai/references/deno-deploy.md`. Platform notes: KV+Postgres can't coexist on one app (KV is out → Postgres backbone, matches the ops-simplicity goal); Deno Queues unsupported on new Deploy (use Postgres+`Deno.cron`); per-environment isolated DBs; MikroORM v7 needs explicit `dbName` + API drift (`persist`/`flush`, raw DDL for schema).
- **Next:** A2 — swap the toy entity for a real `@open-mercato/core` entity (requires `yarn install` + `build:packages`) to prove the codebase imports under Deno; then the separable "full Next.js app under Deno" slice.
- **Encryption note:** Q3's spike-only-keys `findWithDecryption` test was deferred to A2 (needs the real `@open-mercato` encryption layer; the A1 toy entity has no encrypted fields).

### A2 — EXECUTED — verdict: PASS (2026-06-06)
- Toolchain: enabled yarn via `npm i -g corepack --force` → `corepack prepare yarn@4.12.0`; `yarn install` (1517 pkgs) + `yarn build:packages` both clean.
- `deno-slice/db.real.ts` registers **all 25 real `@open-mercato/core` customers entities**; `/real` route added (dynamic import so A1 stays bootable). Config `deno.a2.json`: `nodeModulesDir: "manual"` + no import map → unify on **root `node_modules`** (one `@mikro-orm` instance; deep dist imports via `./*` export).
- **Proven under Deno (local `--tunnel`):** 25 real entities import; `MikroORM.init` builds metadata for all + queries Prisma Postgres (`ping ok`); **`findWithDecryption` imports AND executes** (encryption subscriber + `TenantDataEncryptionService` chain load under Deno) — only a missing-table error, since we never created the customers schema. A1 routes unaffected.
- **Caveats / not yet done:** full encrypted round-trip (create customers schema + enable tenant encryption + spike-only keys → write/read an encrypted field exercising `node:crypto`) deferred — `findWithDecryption` ran with encryption disabled (no-op decrypt), so `node:crypto` not yet directly exercised end-to-end. The A2 `node_modules` config is local-tunnel only (deploying it needs `node_modules` packaging — belongs to the full-app slice). `orm.getMetadata().getAll()` v7 shape quirk noted.
- **Net:** "defer Prisma, runtime + hosting first" is validated for both a toy slice (deployed isolate) AND the real entity/encryption layer (local under Deno). Remaining risk concentrated in the **full Next.js app** (220 `node:*` files, build/packaging on Deploy) — the separable heavy slice.

### A2.5 — Deno build system (`deno bundle`) — EXECUTED — verdict: PASS (2026-06-06)
- Question: can we use Deno's build system to package the app for Deploy? Critical because `@open-mercato/*` are **unpublished workspace packages** Deno Deploy can't fetch.
- `deno bundle --config deno.a2.json -o bundle.js main.ts` → single **2.46MB** ESM, 521 modules, **inlines `@open-mercato` + all npm deps** (mikro-orm/pg/kysely); only `node:` builtins external; **`emitDecoratorMetadata` preserved**; `deno check` clean.
- **Bundled real-entity app proven on a deployed Deno Deploy isolate** (`/real`: 25 entities, MikroORM↔Prisma Postgres `ping ok`, `findWithDecryption` executes). Deploy the bundle **as `main.ts`** (a fresh app with `--entrypoint bundle.js` gave an opaque "revision failed" — dashboard-only diagnosis).
- **Implication:** the real app can ship to Deno Deploy as a **bundled single file** — the likely production packaging path. Details in `.ai/references/deno-deploy.md`.
- Plan limit observed: **1 Prisma Postgres DB per plan** (couldn't provision a second) → reuse the one DB.

### Full Next.js app on Deno — EXECUTED — runtime PASS, Deploy BLOCKED (2026-06-06)
- **Gate 1 (build):** ✅ `next build` clean (361 routes). Build order matters: `build:packages → generate → build:packages → next build` (2nd packages build emits `core/dist/generated/entities.ids.generated.js`; skipping → 30 `module-not-found`).
- **Gate 2 (run under Deno):** ✅ **decisive.** Next.js 16.2.6 boots under Deno (`next` bin, `Ready in 74ms`) and serves SSR `/`→200 (1.1MB), `/backend`→307 auth, `/api/docs/openapi`→200 (6.6MB), Zod 400, `node:crypto` encryption init. `jsr:@deno/nextjs-start` is Next-14-only — use the `next` bin.
- **Gate 2b (artifact):** ✅ `output:'standalone'` (env-gated `OM_STANDALONE=1` in `next.config.ts`) runs under Deno as `server.cjs` (app is `type:module` → must be `.cjs`; `--unstable-detect-cjs` insufficient). Serves 200.
- **Gate 3 (deploy):** ❌ blocked by two bottlenecks (detail in `.ai/references/deno-deploy.md`): (1) **legacy native addons Deno can't load** — `isolated-vm` (AI sandbox), `sharp` (images; also traced wrong-platform `darwin-arm64`), `better-sqlite3` (sqlite cache) — lazy/feature-scoped (don't block boot) but break those features under Deno; (2) **opaque Deploy revision failure** — 343MB standalone uploads, revision fails, reason is **dashboard-only** (org token works for CLI but **401s the REST API** everywhere; `deno deploy logs` empty for a non-booted revision). Apps live: `om-deno-slice` (bundle, working), `om-mercato-app` (revision failing).
- **Verdict:** full app is **Deno-runtime compatible at the core**; productionizing on Deno Deploy needs (a) replacing 3 native deps (`node:vm`/Worker, `node:sqlite`/libsql, WASM/Linux sharp) and (b) dashboard access to debug the revision.
