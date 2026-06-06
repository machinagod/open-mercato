# Deno + Deno Deploy — Working Reference (NEW platform)

> Cheat-sheet for running Open Mercato on Deno Deploy. Covers the **new** Deno Deploy only.
> **Deploy Classic shuts down 2026-07-20** — never target it; ignore `docs.deno.com/deploy/classic/*`.
> Mix of official docs + facts proven empirically by the `deno-slice/` spike on 2026-06-06.

## Tooling (verified)

- `deno 2.8.1`, `deployctl 1.13.1` (the `deno deploy` subcommand).
- Node 25 / yarn are NOT required to run a Deno app — but ARE required to build the `@open-mercato/*` packages (`dist/`) if you import them. `yarn`/`corepack` were absent in the spike shell; the monorepo was not installed.

## Auth & org

- Tokens live in repo `.env`: `DENO_DEPLOY_TOKEN`, `DENO_DEPLOY_API_TOKEN` (both 40 chars, **org-scoped**).
- The REST API (`https://api.deno.com/v1/*`) **rejects** these tokens (401) — they are CLI tokens, not REST tokens. Use the `deno deploy` CLI, not curl.
- Pass `--token "$DENO_DEPLOY_API_TOKEN"` on every command. **Always pass `--org machinagod-sandbox`.** Without `--org` and a TTY the CLI tries to prompt and fails (`requires interactive input`).

## App lifecycle (non-interactive)

```bash
# Create a dynamic (server) app from a LOCAL dir. --source local AND --region are REQUIRED.
deno deploy create --org machinagod-sandbox --app <APP> \
  --source local --runtime-mode dynamic --entrypoint main.ts \
  --region us --token "$DENO_DEPLOY_API_TOKEN"     # region: us | eu | global

# Deploy current dir (reads deno.json "deploy": {org, app}; create writes that block for you)
deno deploy --prod --token "$DENO_DEPLOY_API_TOKEN"
```

- Plain `deno deploy` will **not** create a missing app → `The requested app was not found`. Create first.
- Production URL: `https://<APP>.<ORG>.deno.net`. Each deploy also yields a preview URL.

## Managed Postgres (Prisma Postgres)

```bash
deno deploy database provision <DB> --kind prisma --region us-east-1 --org … --token …
deno deploy database assign    <DB> --app <APP>   --org … --token …
deno deploy database list      --org … --token …          # shows region+projectId, NOT a conn string
```

- **One DB per app.** You **cannot** attach both Deno KV and Postgres to the same app. (Confirmed in docs + by stakeholder.) ⇒ for a Postgres app, KV is unavailable; put shared state (cache, rate-limit, queue) on Postgres.
- **Per-environment isolated DBs:** production, preview, and `--tunnel` "local" each get their **own** database. A row written via the tunnel is NOT visible to the production isolate.
- **Injected env** (only into *new* deployments after assign; **not** shown by `deno deploy env list`):
  - `DATABASE_URL` = **direct `postgresql://…` TCP** (this is what MikroORM/`pg` use). ✅ not Accelerate.
  - `PRISMA_ACCELERATE_URL` = `prisma+postgres://…` (HTTP/Accelerate — ignore for TCP ORMs).
  - `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`. ⚠️ **No `PGDATABASE`** was injected, and the `DATABASE_URL` had **no `/dbname` pathname** in practice. `current_database()` = `postgres`, `current_user` = `prisma_migration`.
- Env/DB changes require a **redeploy** to take effect.

## Local dev against the real DB — `--tunnel`

`--tunnel` is on the **standard `deno` CLI**, not `deno deploy`:

```bash
deno run -A --unstable-cron --tunnel main.ts   # injects the linked app's env (DATABASE_URL, PG*, …)
```

- Connects local `:8000` to `https://<APP>--local.<ORG>.deno.net` and injects the app's (local/preview) env.
- Lets you iterate without redeploying. Remember it hits the **per-environment** DB, not production.

## Background work (no Redis, no KV)

- **`Deno.cron(name, schedule, fn)`** — auto-detected/managed on Deploy (runs without a live request; no server needed to stay warm). Locally needs `--unstable-cron`. Executions never overlap.
- **Deno Queues (`Deno.Kv.enqueue`) are NOT supported on the new Deploy.** Use a **Postgres-backed job table drained by `Deno.cron`**. Proven pattern:
  ```sql
  update jobs set status='done', locked_at=now()
   where id in (select id from jobs where status='pending'
                order by created_at for update skip locked limit N)
   returning id;
  ```

## MikroORM v7 on Deno (proven working)

- v7 dropped knex (→ Kysely runner), native ESM, multi-runtime. Connects to Prisma Postgres over TCP from a Deno isolate. ✅
- `deno.json` must set `compilerOptions.experimentalDecorators` + `emitDecoratorMetadata` (emits a *deprecation warning* but works), and `nodeModulesDir: "auto"`. `import 'reflect-metadata'` first.
- Entities use `@mikro-orm/decorators/legacy` (`@Entity/@Property/...`) + `ReflectMetadataProvider` — same as `packages/shared/src/lib/db/mikro.ts`.
- **Must pass `dbName` explicitly** (e.g. `'postgres'`) — the injected `DATABASE_URL` lacks a pathname, else: `clientUrl … missing the pathname`.
- SSL: honor `PGSSLMODE`; use `ssl: { rejectUnauthorized: true }` (valid certs; CA bundle is present on the isolate). **Do not** disable TLS verification.
- Pool: `{ min: 0, max: 1 }` per isolate.
- **v7 API drift to watch:** `orm.getSchemaGenerator()` and `orm.schema.updateSchema()` are NOT available as used in v6; `em.persistAndFlush()` is gone — use `em.persist(e); await em.flush()`. For schema, prefer real migrations or raw DDL.

## Importing the real `@open-mercato` monorepo under Deno (A2 — proven)

- Build first: `corepack` was absent → `npm i -g corepack --force` (EEXIST on a `pnpm` shim), then `corepack enable && corepack prepare yarn@4.12.0 --activate`. Then `yarn install` + `yarn build:packages` (dist is what the package `exports` resolve to).
- `@open-mercato/core` / `shared` deep paths resolve via the `./*` export → `./dist/*.js` (Deno uses the `default` condition, not `types`). e.g. `import * as e from '@open-mercato/core/modules/customers/data/entities'`.
- **Resolve everything from the root `node_modules`** (yarn workspace symlinks: `node_modules/@open-mercato/core -> ../../packages/core`). Use a config with **`"nodeModulesDir": "manual"` and NO `imports` map**, so the slice and the `@open-mercato` dist share **one** `@mikro-orm` instance (separate copies break MikroORM's metadata/`instanceof` checks). Delete any prior `deno-slice/node_modules` (from `nodeModulesDir:"auto"`) so it doesn't shadow root.
- ✅ Proven: 25 real customer entities import; `MikroORM.init` builds metadata for all of them under Deno + queries Prisma Postgres; `findWithDecryption` (+ encryption subscriber/`TenantDataEncryptionService`) imports and executes under Deno.
- ⚠️ This `node_modules`-based config is for **local `--tunnel` runs**. Deploying it would require shipping `node_modules` (the deploy uploads the dir) — that packaging question belongs to the "full Next.js app on Deploy" slice, not here. A1 (npm: specifiers) is the deployable variant.
- v7 API note: `orm.getMetadata().getAll()` shape changed — returned 0 in introspection despite metadata being built; rely on `init` success + a query, or migrations, instead.

## Deno build system — `deno bundle` (A2.5 — proven, solves the unpublished-package problem)

The blocker for deploying the real app: `@open-mercato/*` are **unpublished workspace packages**, so Deno Deploy can't fetch them. `deno bundle` solves it by inlining them.

- `deno bundle` is **experimental** in 2.8.1. Default `--packages bundle` **inlines npm deps too** (mikro-orm, pg, kysely). Output: single ESM file, only `node:` builtins external (Deploy supports those).
- Build (needs the root-`node_modules` resolution config so `@open-mercato` resolves):
  ```bash
  deno bundle --config deno.a2.json -o bundle.js main.ts   # ~2.46MB, 521 modules, ~130ms
  ```
- ✅ **Preserves `emitDecoratorMetadata`** — bundled real-entity MikroORM app runs correctly (tunnel, standalone, AND deployed isolate). `deno check bundle.js` passes.
- **Deploy the bundle:** name it `main.ts` (match the app's entrypoint) in a clean dir + minimal `deno.json` (deploy block) and `deno deploy --prod`. ✅ Proven: bundled real-entity app on the isolate → 25 entities, MikroORM↔Prisma Postgres, `findWithDecryption` all work.
  - ⚠️ Creating a *new* app with `--entrypoint bundle.js` produced an opaque "revision failed" (CLI doesn't surface why; dashboard build log only). Deploying the bundle **as `main.ts`** to the existing app worked — prefer that.
- `deno compile` also exists (self-contained binary) — not needed for Deploy.
- **Plan limit:** 1 Prisma Postgres DB per plan → reuse the single DB across spike apps.

**Implication for the migration:** the real Open Mercato app can be shipped to Deno Deploy as a **bundled single file** (no `node_modules`, no published-package requirement). This is the likely production packaging path for the Deno target.

## Full Next.js app under Deno (the heavy slice — runtime PROVEN, Deploy BLOCKED)

Build order (must): `corepack`→`yarn install`→`build:packages`→**`yarn generate`**→`build:packages` (again — produces `packages/core/dist/generated/entities.ids.generated.js`, the `#generated/` subpath-import target; skipping the second build → 30 `module-not-found`)→`next build`.

- **Gate 1 — build:** ✅ `next build` (Turbopack, 361 API routes) compiles clean. All app routes are dynamic catch-alls (`/`, `/[...slug]`, `/api/[...slug]`, `/backend/[...slug]`) + a Proxy middleware.
- **Gate 2 — run under Deno:** ✅ **decisive.** `deno run -A ../../node_modules/next/dist/bin/next start` boots **Next.js 16.2.6 under Deno** (`Ready in 74ms`) and serves: `/`→200 (1.1MB SSR HTML), `/backend`→307 auth-refresh (RBAC middleware), `/api/docs/openapi`→200 (6.6MB), `/api/auth/login`→400 (Zod validation), `/login`→200. Instrumentation runs incl. **tenant encryption key derivation (`node:crypto`)**. `jsr:@deno/nextjs-start` is pinned to Next 14 — too old; run the `next` bin directly instead.
- **Gate 2b — self-contained artifact:** ✅ `output: 'standalone'` (env-gate it: `apps/mercato/next.config.ts` adds `output:'standalone'` only when `OM_STANDALONE=1`) → `.mercato/next/standalone/` (~294–343MB: `server.js` + traced `node_modules` + `packages`). Copy `static` + `public` in. Runs under Deno, serves 200 — but the app's `"type":"module"` makes Deno treat `server.js` as ESM (`require is not defined`); **rename to `server.cjs`** (or drop a `{"type":"commonjs"}` package.json beside it). `--unstable-detect-cjs` is NOT enough when the nearest package.json is `type:module`.
- **Gate 3 — deploy to Deno Deploy:** ❌ **BLOCKED (the major bottleneck).** Uploaded the 343MB standalone fine; DB assigned; encryption key set — but the **revision fails** with the reason **only in the dashboard** (`console.deno.com/<org>/<app>`). CLI can't surface it: REST API 401s the CLI tokens, `deno deploy logs` is empty for a never-started revision. Can't iterate autonomously past it. Likely causes (unconfirmed, need dashboard): Deploy's dynamic runtime not honoring the **uploaded traced `node_modules`** (it may expect to install deps itself or via npm: specifiers), `.cjs` entrypoint handling, or a boot-time `node:` API the isolate restricts. The Deno-blessed alternative — the **Next.js framework preset (build-on-Deploy)** — instead requires the full monorepo build (yarn4/corepack/turbo/native deps/build-order/non-standard `distDir`) to run on their Linux builders, also dashboard-only to debug.

### The two real bottlenecks for the full app on Deno Deploy

**Bottleneck 1 — Deno can't load legacy native (nan / raw-V8) addons.** Deno's own error strings: *isolated-vm "cannot be loaded in Deno"*; *better-sqlite3 "built on the legacy V8/nan native addon ABI"* (→ use `node:sqlite`/`npm:libsql`). The standalone traces in: `isolated-vm` (AI sandbox — `packages/ai-assistant/.../lib/sandbox.ts`, **eager** `import ivm from 'isolated-vm'`), `@img/sharp-*` (attachments image processing — and it traced the **darwin-arm64** binary from the build host, wrong for Linux isolates), `better-sqlite3` (cache `sqlite` strategy). These are **lazy/feature-scoped** (the app boots + serves under Deno without them), so they don't block boot — but the **features break under Deno** until replaced (Deno hints: `node:vm`/`Worker`, `node:sqlite`/libsql; sharp → WASM or platform-correct build). Sharp also shows the general rule: **native binaries are platform-specific and traced from the build host** — must build on/for Linux for Deploy.

**Bottleneck 2 — packaging the standalone for Deno Deploy's dynamic runtime.** Fully diagnosed via the **v2 API** (`api.deno.com/v2`, NOT `/v1` which 404s/401s). The org token works against **v2** (use `Authorization: Bearer`):
- `GET /v2/apps` → app id; `GET /v2/apps/{app}/revisions` → revisions + status; `GET /v2/revisions/{id}/build_logs`, `/progress`, `/timelines`; `GET /v2/apps/{app}/logs?start=<RFC3339>&end=<RFC3339>` → runtime logs; `PATCH /v2/apps/{app}` with `{config:{runtime:{type:"dynamic",entrypoint:"…"}}}`; `POST /v2/apps/{app}/deploy`. Build `Config`: `framework` (`nextjs`|…) XOR `runtime` ({type:dynamic,entrypoint} | {type:static,cwd,spa}), `install`/`build`/`predeploy` (omit to skip), `crons`.

Two failures found and the chain:
1. **`No runtime entrypoint provided`** — the CLI `create --entrypoint` + a later plain `deno deploy` didn't persist the entrypoint. **Fix:** `PATCH /v2/apps/{app}` setting `config.runtime={type:"dynamic",entrypoint:"apps/mercato/server.cjs"}`. → build then **succeeds** (18.7MB artifact).
2. **`Error: Cannot find module 'next'`** at boot (`require('next')` in `server.cjs`). The uploaded `node_modules` (343MB, `next` present) is **NOT shipped to the runtime** — Deno Deploy's dynamic build ships only the **statically-traced module graph** (18.7MB), and Next standalone's **CommonJS `require()` is not traced**, so `node_modules` is dropped. `nodeModulesDir:"manual"` + a root deno.json didn't change this.

**Why the A2.5 bundle deployed but this doesn't:** the bundle inlines every dep (nothing to resolve at runtime); the Next standalone defers to `node_modules` via CJS `require`, which Deno Deploy's tracer won't carry.

**Fix paths attempted:**

**(a) Next.js framework preset (`config.framework:"nextjs"`, build on Deploy) — BLOCKED by a stack of walls** (all found via `build_logs`; the builder runs commands **under Deno node-compat**, not Node):
1. `--build-timeout 30` → *"exceeds the maximum allowed for your plan (5 minutes)"* — **5-min build cap** (plan tier). A cold monorepo install+build can't fit.
2. install `corepack enable …` → *`corepack: command not found`* (builder PATH lacks it).
3. `npm i -g corepack` → *`EEXIST … /tmp/build/bin/pnpm`* (needs `--force`).
4. `npm i -g corepack --force && corepack prepare yarn@4.12.0` → *`Internal Error: Digest already called` at `ext:deno_node/internal/crypto/hash.ts`* — **corepack crashes on Deno's `node:crypto` shim**, so yarn 4 can't bootstrap on the Deno builder.
5. Bypass via committed `node .yarn/releases/yarn-4.12.0.cjs install` → release file *not found in upload* (deno deploy didn't carry `.yarn/releases`).
- Even past install: **native nan addons can't build/load under Deno** (`isolated-vm`/`better-sqlite3`) and the build still must beat the 5-min cap. The Node-oriented yarn4-monorepo-with-native-deps is fundamentally mismatched with Deno Deploy's Deno-based builder + plan limits.

**(b) Standalone / dynamic runtime — BLOCKED:** Deno Deploy ships only the statically-traced ESM graph; Next standalone's CJS `require('next')` (and `.next` data files read via fs) aren't carried → `Cannot find module 'next'`.

**What would actually land it (a remediation project, not a config fix):** (1) replace the native nan deps — `isolated-vm`→`node:vm`/Worker, `better-sqlite3`→`node:sqlite`/libsql, `sharp`→WASM; (2) make the app self-contained like the A2.5 bundle (no runtime `node_modules`/native deps), OR move to a higher Deno Deploy plan tier (longer build) AND get yarn4 onto the Deno builder without corepack (committed release that actually uploads, or pre-vendored deps). The single-file **bundle** path is the only thing proven to deploy+run on an isolate today.

**Bottom line:** the entire stack — incl. the full Next.js app — is **Deno-runtime compatible at the core** (build ✅, run-under-Deno ✅, SSR/API/middleware/auth/encryption ✅). Shipping it to Deno Deploy needs: (a) replacing 3 Deno-incompatible native deps for full feature parity, and (b) dashboard access to debug the revision failure. Contrast: the single-file **bundle** path (A2.5, data-layer slice) deploys cleanly because it needs no `node_modules` and no native addons on Deploy.

## Gotchas checklist

- [ ] `--org` on every CLI call. [ ] `--source local --region …` on `create`. [ ] redeploy after env/DB change.
- [ ] `dbName` passed to MikroORM. [ ] `--unstable-cron` only needed locally. [ ] tunnel DB ≠ production DB.
- [ ] REST API token 401 is expected — use the CLI. [ ] `env list` won't show injected DB vars.
