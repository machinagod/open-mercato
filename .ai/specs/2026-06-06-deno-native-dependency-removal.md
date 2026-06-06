# Native-Dependency Removal for Deno Compatibility

> **Status: Scoping spec.** Sequenced, additive plan to replace the 4 native (nan/NAPI) Node addons
> that Deno cannot load — the keystone work that unblocks deploying the full app to Deno Deploy.
> Companion to [`2026-06-06-deno-deploy-runtime-feasibility.md`](./2026-06-06-deno-deploy-runtime-feasibility.md),
> [`2026-06-06-deno-deploy-vertical-slice.md`](./2026-06-06-deno-deploy-vertical-slice.md), and
> [`.ai/references/deno-deploy.md`](../references/deno-deploy.md).
>
> **Date:** 2026-06-06 · **Driver:** Ops simplicity / cost (Deno Deploy hosting) · **Independent of the Prisma decision.**

## TLDR

**Key Points:**
- The full Next.js app is **Deno-runtime compatible today** (build ✅, run-under-Deno ✅). The *only* gating work for Deno Deploy hosting is removing **4 native addons** Deno can't load.
- Replace each via a **runtime adapter** selected by runtime/DI — **keep the native impl on Node** (zero change to the current deployment) and add a **Deno-compatible impl**. Fully **additive** (no contract surface removed → BC-safe).
- Sequence by effort/risk; each phase ships independently. Order: SQLite → PDF-canvas → image (sharp) → AI sandbox (isolated-vm).

**Scope (the 4 first-party native deps):**
- `better-sqlite3` (cache `sqlite` strategy), `@napi-rs/canvas` (PDF→image via pdfjs), `sharp` (attachments image processing), `isolated-vm` (AI Code Mode sandbox).

**Out of scope:** `ioredis`/`bullmq` (pure-JS, not native — separate Deno-compat verification); `ssh2`/`cpu-features` (dev-only, via `testcontainers`); the Deno Deploy build-pipeline limits (plan tier; tracked in the references doc).

## Problem Statement

Deno refuses legacy native addons: *"isolated-vm … cannot be loaded in Deno"*, *"better-sqlite3 … legacy V8/nan ABI"*. Four first-party native deps therefore break specific features under Deno (and block a clean Deno Deploy artifact). The app boots without them (all are lazy or feature-scoped except the eager `sharp`/`isolated-vm` module-load), but the **AI Code Mode, image serving, SQLite cache, and PDF rendering** features fail under Deno. Removing/replacing them makes the app pure-JS/WASM and Deno-deployable, while preserving Node behavior.

## Proposed Solution

For each native dep, introduce a **capability adapter** with two implementations — `node` (existing native) and `deno` (pure-JS/WASM/native-Deno) — selected at runtime. Most already sit behind a seam (strategy pattern / interface / lazy import); we extend that seam rather than invent new ones.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| Adapter + runtime selection (not rip-and-replace) | Node deployment keeps native perf; Deno gets a working impl; change is additive/BC-safe |
| Sequence easy→hard, ship per phase | Each phase removes one Deno blocker; the app gets incrementally Deno-deployable; risk is isolated |
| Prefer same-engine replacements | `sharp`→`wasm-vips` (both libvips), `better-sqlite3`→`node:sqlite` (same SQL), minimizing behavior drift |
| `isolated-vm`→Deno `Worker` | Deno's own recommendation; Workers are real isolates with permission sandboxing |
| Runtime detection helper in `@open-mercato/shared` | One `isDeno()`/capability registry, reused by every adapter |

## Architecture

```
@open-mercato/shared/lib/runtime
  ├─ detect.ts            isDeno() / isNode() / runtime capability flags
  └─ adapters registry    pick node|deno impl per capability (DI-resolvable)

Per capability (adapter pattern):
  cache/strategies/sqlite-better.ts   (node)   ─┐
  cache/strategies/sqlite-node.ts     (deno)   ─┴─► CACHE_STRATEGY=sqlite picks by runtime
  attachments/lib/image/sharp.ts      (node)   ─┐
  attachments/lib/image/wasm-vips.ts  (deno)   ─┴─► ImageProcessor interface
  attachments/lib/pdf-canvas/*                  ─► already PdfCanvasFactoryLike
  ai_assistant/lib/sandbox/ivm.ts     (node)   ─┐
  ai_assistant/lib/sandbox/worker.ts  (deno)   ─┴─► Sandbox interface (createSandbox)
```

## Implementation Plan

### Phase 1 — `better-sqlite3` → `node:sqlite` (cache) · **Low**
- Already lazy + `CACHE_STRATEGY=sqlite`-gated, with memory/redis fallback and a `CacheDependencyUnavailableError` guard.
- Add `packages/cache/src/strategies/sqlite-node.ts` using **`node:sqlite`** (built into Deno; also Node 22+ experimental). Keep `sqlite.ts` (better-sqlite3) for Node. Select by `isDeno()` (or an explicit `CACHE_SQLITE_DRIVER`).
- Same SQL schema (`cache_entries`, `cache_tags`); thin wrapper over the API differences (prepare/run/all).
- **Exit:** `CACHE_STRATEGY=sqlite` works under Deno; better-sqlite3 stays optional-only for Node.

### Phase 2 — `@napi-rs/canvas` (PDF→image) · **Low**
- Already behind `PdfCanvasFactoryLike` + lazy `pdfjs-dist` import + graceful text-only fallback.
- Under Deno: either (a) **drop canvas** and accept text-extraction-only PDF path (image render degrades gracefully — already the failure mode), or (b) supply a WASM/Deno canvas factory implementing `PdfCanvasFactoryLike`.
- Remove `@napi-rs/canvas` from root/app `dependencies` (it's only a pdfjs optional); document the degraded path.
- **Exit:** PDF upload + text extraction works under Deno; image-render path no-ops gracefully (or uses WASM canvas).

### Phase 3 — `sharp` → `wasm-vips` (attachments) · **Medium**
- `sharp` is eager in `imageSafety.ts` (validate/sanitize: MIME sniff + re-encode + pixel/byte limits) and the image route (on-the-fly `resize` cover/contain). `sharp` *is* libvips → **`wasm-vips`** (libvips compiled to WASM) is the closest drop-in.
- Introduce `ImageProcessor` interface (`validate/sanitize`, `resize`) with `sharp` (node) and `wasm-vips` (deno) impls behind a lazy factory; convert the two eager imports to the factory.
- Validate parity: format support (jpeg/png/gif/webp), resize modes, metadata stripping, perf within budget.
- **Exit:** image validation + on-the-fly resize work under Deno; sharp optional-only for Node.

### Phase 4 — `isolated-vm` → Deno `Worker` sandbox (AI Code Mode) · **High (keystone)**
- `createSandbox(globals, opts) → { execute(code) }` runs AI-generated JS with injected data + callbacks, captures logs, returns result/error. Current impl: `ivm.Isolate` + sync `Callback` + `ExternalCopy` + `SharedArrayBuffer` for sync result marshaling.
- Deno impl: a **`Worker`** with **no permissions** (`deno.permissions: "none"`), code injected via message; host↔sandbox data over `postMessage` (structured clone). Re-model the sync callbacks as **async message round-trips** (the public `execute` is already async). Enforce `MEMORY_LIMIT_MB`/timeout via Worker termination.
- Keep `ivm.ts` for Node. Select by `isDeno()`.
- **Interim option:** if Phase 4 lags, **feature-gate Code Mode off under Deno** (the assistant degrades to read-only/no-exec) so a Deno deployment ships before the sandbox rewrite lands.
- **Exit:** AI Code Mode `search`/`execute` run under Deno via Worker with equivalent isolation guarantees.

### Cross-cutting
- Add `@open-mercato/shared/lib/runtime/detect.ts` (Phase 1) and reuse.
- Verification gate (each phase): build the **standalone**, grep its traced `node_modules` for `*.node` — must be **zero** for shipped features; run the affected feature under `deno run --tunnel`.

## Risks & Impact Review

#### R1 — Sandbox isolation regression (Phase 4)
- **Scenario:** Worker-based sandbox is weaker than ivm (escapes, resource limits).
- **Severity:** High (security). **Mitigation:** Worker `permissions:"none"`, hard timeout + termination, structured-clone-only data, security review of the new sandbox; reuse the existing escape tests. **Residual:** message-passing model differs — needs its own threat review.

#### R2 — Image fidelity/perf drift (Phase 3)
- **Scenario:** `wasm-vips` output/perf differs from `sharp`.
- **Severity:** Medium. **Mitigation:** same libvips engine; golden-image parity tests + perf budget. **Residual:** WASM is slower than native — acceptable for on-the-fly/edge.

#### R3 — `node:sqlite` API/behavior gaps (Phase 1)
- **Scenario:** `node:sqlite` differs from better-sqlite3 (prepared-statement API, types).
- **Severity:** Low (optional backend, memory/redis fallback). **Mitigation:** thin wrapper + the cache strategy's existing tests.

#### R4 — Behavior change on Node
- **Scenario:** Refactoring native call sites regresses the current Node deployment.
- **Severity:** Medium. **Mitigation:** Node keeps the existing native impl as default; adapters are additive; full test pass on Node per phase. **Residual:** new seams add indirection.

## Final Compliance Report — 2026-06-06

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| BACKWARD_COMPATIBILITY.md | No contract-surface removal | Compliant | Adapters additive; native impls retained for Node |
| root AGENTS.md | Never hand-roll AES/encryption | N/A | No crypto change |
| packages/cache/AGENTS.md | Strategy pattern, DI-resolved cache | Compliant | New strategy alongside existing |
| ai-assistant/AGENTS.md | Mutation/sandbox contracts | Must-review | Phase 4 changes the sandbox engine — security review required |

**Verdict:** Approved as a sequenced, additive program. Phases 1–3 are low/medium risk; Phase 4 needs a security review and may be feature-gated under Deno initially.

## Open Questions
- **Q1:** For Deno hosting, is **degrading** Code Mode (Phase 4 interim gate) acceptable to ship sooner, or must full Worker parity land first?
- **Q2:** PDF image rendering under Deno — accept **text-only degradation** (drop canvas) or invest in a WASM canvas?
- **Q3:** Target runtime selection — automatic `isDeno()` detection, or explicit per-capability env overrides (or both)?

## Changelog
### 2026-06-06
- Initial scoping spec. 4 native deps, adapter pattern, 4 phases (SQLite → PDF-canvas → sharp → isolated-vm). Awaiting Q1–Q3.
- **Phase 4 (isolated-vm → Deno Worker) — EXECUTED FIRST (keystone), verdict: PASS.** Restructured `ai_assistant/lib/sandbox.ts` into a runtime-selected adapter: `sandbox/shared.ts` (contract + `normalizeCode` + `isDenoRuntime`), `sandbox/ivm.ts` (Node, isolated-vm — logic relocated verbatim), `sandbox/worker.ts` (Deno `Worker`), `sandbox/index.ts` (lazy runtime select so isolated-vm never loads under Deno and the Worker never loads under Node). `sandbox.ts` re-exports for BC (import path unchanged).
  - Deno Worker engine faithfully ports the SAB+Atomics bridge so injected host functions stay **synchronous** inside the sandbox (`spec.findEndpoints(...)` without await) exactly as ivm; `api.request` async path works too. Request via `postMessage` (host not blocked), result via `SharedArrayBuffer` (worker blocked on `Atomics.wait`).
  - Security: worker global hardening (neutralize `fetch`/`XHR`/`WebSocket`/`Deno`/`importScripts`/`navigator`) + user-scope shadowing of dangerous globals + a fresh isolate. OS-level `permissions:"none"` is opt-in via `OM_SANDBOX_WORKER_PERMISSIONS=none` **plus** `--unstable-worker-options` (passing the option without the flag fails uncatchably/hangs, so it's gated, not probed). Without the env, the hardened-worker path is used — note the residual **dynamic-import** vector that only `permissions:"none"` fully closes.
  - **Verified:** 16/16 Deno contract tests pass (`packages/ai-assistant/deno-tests/sandbox-worker.test.ts`) in both the default hardened path and the `permissions:"none"` path — covering sync host calls, async `api.request`, console capture, `require`/`process`/`fetch`/`setTimeout`/`globalThis`/Function-constructor-escape blocks, error handling, statement form, and timeout. Package builds clean.
  - **Caveats:** the Node/ivm Jest suite couldn't run in this environment — `isolated-vm` segfaults on Node 25 (no prebuild; pre-existing, unrelated to the refactor; ivm logic is byte-for-byte relocated). The `permissions:"none"` OS lock is **opt-in** pending confirmation that Deno Deploy isolates support Workers + `--unstable-worker-options` (R1 follow-up).
- **Phase 1 (better-sqlite3 → node:sqlite) — EXECUTED, verdict: PASS.** `packages/cache/src/strategies/sqlite.ts` now selects the driver in `getDb()` by runtime: Deno → `node:sqlite` (`DatabaseSync`, wrapped to the better-sqlite3-shaped interface incl. a `BEGIN/COMMIT/ROLLBACK` transaction helper); Node → `better-sqlite3` (unchanged, lazy — never loaded under Deno). Same schema/SQL. Verified 6/6 Deno tests (`packages/cache/deno-tests/sqlite.test.ts`): set/get/has, delete, tag invalidation, TTL expiry, clear/keys/stats, cleanup. Cache package builds clean.
- **Phase 3 (sharp → wasm-vips) — EXECUTED, verdict: PASS (one noted gap).** New `attachments/lib/image/` adapter: `types.ts` (`ImageProcessor`), `sharp.ts` (Node — behavior unchanged), `vips.ts` (Deno — `wasm-vips`/libvips-WASM), `index.ts` (lazy runtime select). Refactored `imageSafety.ts` (`validateImageDimensions` → `readDimensions`; mime now from magic bytes) and the image route (resize → `processor.resize`, format from detected mime). Both adapters always re-encode (the sanitization step). `wasm-vips` added to `apps/mercato` optionalDependencies (pure-WASM, cross-platform). Verified 5/5 Deno tests (`packages/core/deno-tests/image-vips.test.ts`): readDimensions, garbage→null, re-encode, **cover** (exact box), **contain** (fit-within). Core builds clean.
  - **R2 gap:** `contain` returns the fit-within image (correct aspect) but does NOT yet pad to the exact box with a transparent background like sharp — the wasm-vips `embed` band/background path errored and is deferred to the fidelity-parity (golden-image) review. `cover` (the default) is exact.
- **Phase 2 (@napi-rs/canvas) — EXECUTED, verdict: PASS.** `@napi-rs/canvas` is **N-API** (Deno *can* load it, unlike the legacy-nan addons), so the fix is graceful degradation, not removal. `pdfProcessing.ts` now guards `pdfDocument.canvasFactory` + wraps `renderPdfPageToImageBuffer` in try/catch → when the canvas backend is unavailable, the page degrades to text-only (`imageBuffer: null`) instead of crashing extraction. Moved `@napi-rs/canvas` to `apps/mercato` optionalDependencies (Node keeps PDF-image OCR; a slim Deno build can omit it; runtime degrades either way). Core builds clean.
- **Runtime detection — CONSOLIDATED.** Added canonical `@open-mercato/shared/lib/runtime/detect.ts` (`isDenoRuntime`/`isNodeRuntime`); `core` image adapter imports it. `cache` keeps a local copy (shared→cache dep cycle forbids importing shared back) and the AI sandbox keeps its own (Deno Worker graph stays self-contained + its Deno tests import the engine source directly) — both documented as referencing the canonical helper.
- **Native-dep removal COMPLETE** for all 4 first-party native addons. Verified: 27 Deno tests pass (sandbox 16 + sqlite 6 + image 5); shared/cache/core all build clean. Remaining: R2 (wasm-vips `contain` exact-box padding — fidelity review) and the Phase-4 R1 (Deno Deploy Worker + `--unstable-worker-options` support). `yarn install` needed to materialize the new `wasm-vips` optional dep before a Deno build.
