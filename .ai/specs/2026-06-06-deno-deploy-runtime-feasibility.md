# Feasibility Memo — Running Open Mercato on Deno + Deno Deploy

> **Status: Pre-spec feasibility research.** This is NOT a spec. It captures findings,
> risks, and open questions to decide whether — and how — to proceed. A spec follows
> only once the de-risking spike (below) validates the critical assumptions.
>
> **Date:** 2026-06-06 · **Driver:** Ops simplicity / cost · **Chosen scope:** Runtime + hosting first, defer Prisma

## TLDR

- **Goal:** Run the app on the Deno runtime and host it on (the new) Deno Deploy, primarily to reduce ops/infra overhead. Prisma deferred.
- **Headline finding:** More feasible than first assumed, because the two scariest blockers dissolved on closer look:
  1. **Next.js 16 is fully supported on the new Deno Deploy** (App Router, SSR/SSG/ISR/PPR, `use cache`). No rewrite to Fresh.
  2. **MikroORM v7 (already in this repo, `@mikro-orm/core@7.1.1`) dropped knex** and officially supports Deno as of April 2026. The ORM is likely **not** on the critical path — so "defer Prisma" is realistic.
- **The real constraint is the background/worker tier, not the web tier.** Deno Deploy is request/response isolates: no long-running worker processes, no writable filesystem, and **the new Deploy dropped Queues**. BullMQ+Redis, the file-based local queue, and `better-sqlite3` cache do not run there.
- **Timing risk:** Deno Deploy **Classic shuts down July 20, 2026** (≈6 weeks out). Target the **new** Deno Deploy only; some primitives (Queues) differ from Classic docs.
- **Recommended next step:** a 1–2 week de-risking spike (one module, deployed end-to-end) before committing a full spec.

## Decompose the ask — three independent changes

The original request ("Deno runtime + Deno Deploy + Prisma") bundles three migrations with very different cost/risk. They are separable:

| # | Change | Independent? | Verdict for this scope |
|---|--------|--------------|------------------------|
| A | **Deno runtime** (app executes under `deno`) | Yes | Feasible; node-compat covers most of it |
| B | **Deno Deploy** (hosting target, edge constraints) | Coupled to A | Web tier feasible; worker tier needs rearchitecture |
| C | **Prisma** (replace MikroORM) | **Fully independent of A/B** | **Deferred.** Not required, because MikroORM v7 supports Deno |

Key reframing: **C is a DX/ops choice, not a prerequisite.** The only thing that made Prisma look mandatory was the (outdated) belief that MikroORM can't run on Deno.

## Current-state coupling (from codebase research)

- **Framework:** Next.js 16.2.6 (App Router), React 19, Turbopack. Build via Turbo + Yarn 4 workspaces.
- **ORM:** MikroORM **v7.1.1** (postgresql driver), decorator entities. 33 `data/entities.ts`, 156 migrations, 45 `.snapshot-open-mercato.json`.
- **Data access:** partial abstraction (`DataEngine` ~280 sites, Kysely-backed query-index engine, `findWithDecryption` ~1,900 sites) over ~1,400 raw `em.find/findOne` calls.
- **Background/infra:** BullMQ+Redis (async queue), file-based local queue (`.mercato/queue/`), scheduler/cron, spawned worker processes (`yarn mercato <module> worker`), `better-sqlite3` cache, optional Meilisearch.
- **Node coupling:** ~220 files use `node:*` built-ins — but the bulk are **dev/CLI tooling** (Turbo, `scripts/*.mjs`, codegen, migrations) that runs locally/CI and **never ships to Deno Deploy**. Runtime-path usage (auth crypto, fs-based bootstrap loader) is the part that matters.
- **Deployment today:** Docker (`node:24-alpine`) multi-stage + docker-compose (Postgres, optional Redis/Meilisearch), PaaS-style.

## Per-component verdict (for Runtime + Hosting, Prisma deferred)

| Component | On Deno Deploy? | Notes / action |
|-----------|-----------------|----------------|
| Next.js web tier | ✅ Supported | Auto-detected; `jsr:@deno/nextjs-start` replaces `next start` |
| MikroORM v7 query/CRUD | ⚠️ Likely OK | v7 is Deno-compatible (knex gone, Kysely runner). **Must spike** — esp. Postgres connection model from edge isolates + migrations path |
| Postgres connection | ⚠️ Needs strategy | Edge isolates ⇒ use pooled/serverless Postgres (e.g. pooler) or HTTP driver; raw TCP pools per-isolate don't fit |
| Encryption helpers | ✅ Likely | `node:crypto` is covered by Deno node-compat; verify |
| Background workers (BullMQ+Redis) | ❌ No | No long-running consumers on edge. Replace or relocate |
| Local file queue (`.mercato/queue/`) | ❌ No | No writable FS on edge |
| Scheduler / cron | ⚠️ Rewrite | `Deno.cron` works on new Deploy; port scheduler to it OR run on separate host |
| Deno Queues | ❌ Removed | **Not on new Deploy.** Use DB-backed job queue or external service |
| `better-sqlite3` cache | ❌ No | Native module. Use Deno KV / external cache |
| Meilisearch | ✅ External | HTTP API; lives off-platform |
| fs-based module discovery (boot) | ⚠️ Verify | Edge FS is limited/read-only. The **generated-registry** path is the production path and may suffice; confirm no runtime dir-scanning |
| Dev/build tooling (Turbo, scripts, CLI) | N/A | Stays on Node locally/CI; not deployed |

## The decisive architectural question: where do background jobs run?

This — not the ORM, not Next.js — is what determines whether the "ops simplicity" goal is actually met. Three shapes:

1. **All-Deno, split responsibilities:** web + `Deno.cron` on Deno Deploy; queues become a **Postgres-backed job queue** (polled by cron or a tiny worker). Removes Redis. Closest to the ops-simplicity goal, but requires rewriting the queue strategy.
2. **Split-tier hosting:** web tier on Deno Deploy; existing BullMQ/Redis worker tier stays on a long-running host (container/VM). Least code change, but **infra does not shrink** — partially defeats the cost/ops motivation.
3. **External managed queue:** web on Deno Deploy + a managed queue/worker service. Trades self-hosted Redis for a SaaS dependency.

> For "ops simplicity / cost," **option 1** is the only one that genuinely reduces moving parts (drops Redis + the SQLite cache + the worker host). It is also the most engineering. This tradeoff should be resolved before speccing.

## Top risks

#### R1 — Background tier doesn't fit edge (the core risk)
- **Scenario:** BullMQ/Redis, file queue, native SQLite cache, and spawned workers cannot run on Deno Deploy. New Deploy also has no Queues.
- **Severity:** High. **Mitigation:** adopt Postgres-backed queue + `Deno.cron`, or keep a separate worker host. **Residual:** rewrite cost (option 1) or unchanged infra footprint (option 2).

#### R2 — MikroORM v7 on Deno Deploy unproven in *this* codebase
- **Scenario:** "v7 supports Deno" is true for the library, but v7.1.1 + heavy migrations + edge Postgres pooling is unverified here.
- **Severity:** High (it gates "defer Prisma"). **Mitigation:** spike one module end-to-end. **Residual:** if it fails, Prisma (C) is pulled back onto the critical path — flips the sequencing.

#### R3 — Platform mid-transition / timing
- **Scenario:** Classic EOL 2026-07-20; new Deploy differs (no Queues; KV not auto-migrated). Docs still split classic vs new.
- **Severity:** Medium. **Mitigation:** target new Deploy only; verify each primitive against new-Deploy docs, not classic.

#### R4 — Postgres connection model from edge isolates
- **Scenario:** Per-isolate TCP pools exhaust connections at the edge.
- **Severity:** Medium. **Mitigation:** serverless/pooled Postgres or HTTP driver; cap pool size to 1 per isolate.

#### R5 — Runtime fs/module-discovery assumptions
- **Scenario:** Boot-time directory scanning or snapshot file reads fail on read-only edge FS.
- **Severity:** Medium. **Mitigation:** confirm production path is the static generated registry; eliminate runtime fs scans.

## Recommended de-risking spike (before any spec)

Pick **one** representative module (e.g. `customers`) and prove the riskiest assumptions end-to-end. ~1–2 weeks.

1. Boot the Next.js app under `deno` locally (node-compat) — capture what breaks.
2. Run MikroORM v7 CRUD for the module against Postgres **from a Deno process** (R2).
3. Deploy that slice to the **new** Deno Deploy; confirm SSR + an API route + a DB read/write work from edge (R2, R4).
4. Stand up a **Postgres-backed job** triggered by `Deno.cron` to validate the background-tier replacement (R1).
5. Confirm the production boot path uses the generated registry, not runtime fs scanning (R5).

**Exit criteria:** if 1–4 pass, "Runtime + hosting first, defer Prisma" is validated → write the spec. If MikroORM (step 2/3) fails, escalate the Prisma decision.

## Open questions (resolve before speccing)

- **Q1 — Background jobs:** option 1 (all-Deno, Postgres-backed queue), 2 (split-tier worker host), or 3 (managed queue)? Directly determines whether the ops/cost goal is met.
- **Q2 — Scope of "hosting":** is the whole app on Deno Deploy, or only the web tier (workers elsewhere)?
- **Q3 — Postgres provider:** which managed/pooled Postgres? (decides connection strategy)
- **Q4 — Migrations on Deno:** keep running migrations from Node CLI/CI (recommended), or must they run on Deno too?
- **Q5 — Prisma later:** is Prisma still a desired end-state (separate future spec), or only a fallback if MikroORM-on-Deno fails?

## Sources

- [Run your Next.js SSR app on Deno Deploy](https://deno.com/blog/nextjs-on-deno-deploy)
- [Deno Deploy — Frameworks](https://docs.deno.com/deploy/reference/frameworks/)
- [Deno Deploy is Generally Available](https://deno.com/blog/deno-deploy-is-ga)
- [MikroORM 7: Unchained (knex dropped, Kysely runner, multi-runtime)](https://mikro-orm.io/blog/mikro-orm-7-released)
- [MikroORM Deno support discussion #3079](https://github.com/mikro-orm/mikro-orm/discussions/3079)
- [Migrating from Deploy Classic to Deno Deploy (Queues unsupported, KV/Cron status)](https://docs.deno.com/deploy/migration_guide/)
- [Deno Cron reference](https://docs.deno.com/deploy/reference/cron/)
- [Deno KV on Deploy](https://docs.deno.com/deploy/kv/manual/on_deploy/)
- [Prisma — Deploy to Deno Deploy](https://www.prisma.io/docs/orm/prisma-client/deployment/edge/deploy-to-deno-deploy)

## Changelog
### 2026-06-06
- Initial feasibility memo. Pre-spec. Awaiting de-risking spike + Q1–Q5 answers.
