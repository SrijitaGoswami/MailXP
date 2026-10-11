# B7 Report — Durable Outbox, Database-Backed Jobs, Account-Deletion Processing

Phase: B7 (spec `docs/phase_b7.md`) · Date: 2026-10-10 · Status: **COMPLETE — stopping for explicit approval before B8.**

## 1. Completion status, blockers, deferred items

Complete: transactional outbox, PostgreSQL-backed job queue, safe in-process development worker, and B4 account-deletion lifecycle processing are implemented, tested (mocked + live), and documented. **No blockers; no stop condition (phase §14) triggered** — the four upfront question-round decisions (timing/scope/startup/diagnostics) resolved ambiguity before implementation.

Deferred (per spec/plan/decisions, not gaps in B7): Cloud Tasks/Pub/Sub adoption (production), cross-instance worker coordination, ops/status HTTP endpoints (logs-only decision), Gmail/Gemini job types (B9/B10).

## 2. Baseline and final sequential command results

Baseline (before any B7 edit): `vitest run` 374/374 (30 files) · `tsc --noEmit` 0 · `build` 0 · `prisma validate` valid · `migrate status` up to date.

Final (2026-10-10, run sequentially in phase §11 order on the unchanged final state):

| # | Command | Result |
|---|---|---|
| 1 | `npx vitest run` | **444/444 passed, 35 files** |
| 2 | `npx tsc --noEmit` | **exit 0** |
| 3 | `npm run build` | **exit 0** |
| 4 | `npx prisma validate` | **valid** |
| 5 | `npx prisma migrate status` | **up to date** |
| 6 | live smoke (`b7_smoke.mjs`) | **30/30 passed** (real PostgreSQL + running worker) |

Post-run DB check: exactly the 2 pre-existing accounts, `jobs: 0`, `outbox: 0`, `account_erased audits: 0`. Two intermediate command failures occurred during iteration (both disclosed in §11); after fixes, the full sequence was rerun to completion.

## 3. Outbox/job schema and migration

Migration **`20261010132336_b7_outbox_jobs`** — additive only; generated SQL reviewed before/after applying: two `CREATE TYPE` (`OutboxStatus`: pending/published/dead; `JobStatus`: pending/running/succeeded/dead), two `CREATE TABLE`, five indexes. No `ALTER`/`DROP`/`DELETE` on any existing object; all B0–B6 tables byte-identical.

- **OutboxEvent**: `id`, `eventType` (String, registry-validated), `eventVersion`, `payload Json?` (internal ids only), `status`, `attempts`, `nextAttemptAt`, `lastErrorClass` (safe category), `createdAt`, `publishedAt`; index `[status, nextAttemptAt]`.
- **Job**: `id`, `jobType` (String, registry-validated → unknown dead-letters), `payload Json?`, `status`, `dedupeKey @unique` (one live job per key ever), `outboxEventId @unique` (relay idempotency), `attempts`, `maxAttempts` (default 5), `availableAt`, `leaseExpiresAt`, `leaseOwner`, `startedAt`, `finishedAt`, `lastErrorClass`, `createdAt`, `updatedAt`; indexes `[status, availableAt]`, `[status, leaseExpiresAt]`, `[jobType, status]`.

Plain strings (not enums) for `eventType`/`jobType` so future phases add types without enum migrations; unknown values fail safely. **`npx prisma generate` was run explicitly after the schema change** (B6 stale-client lesson) before any code touched the new models.

## 4. Transactional outbox guarantees and integration points

- **One integration point**: `app/api/v1/me/route.ts` DELETE — inside the existing B4 `$transaction`, guarded by `claimed.count === 1`: marker update + session revocation + `auth.deletion_requested` audit + `appendOutboxEvent(account.deletion_requested {userId})` commit or roll back **together**. Rollback → no publishable event (unit-tested against real snapshot-rollback semantics); commit → event exists.
- The relay only ever sees committed rows — nothing is "emitted" before the domain transaction commits.
- **Idempotent conversion**: `Job.outboxEventId` unique — a crash between "job created" and "event acknowledged" re-runs the relay, resolves the existing job (P2002 path), and completes the acknowledgement. No duplicates, no losses.
- Events are **never deleted**: `pending → published` (ack, `publishedAt` stamped) or → `dead` (terminal, `lastErrorClass` set). Transient relay failures back off with the same bounded policy (max 5 attempts) before dead-lettering.
- Only genuinely async work emits events: B6 purchases/rewards remain synchronous (phase §4); no other event types exist.

## 5. Claim / lease / recovery / retry semantics

- **Claim** = candidate scan (pending ∧ `availableAt ≤ now`, OR running ∧ lease expired; oldest first) plus a per-row **conditional UPDATE with the same predicate** — exactly one claimer can flip a row; competitors match 0 rows. `attempts` increments **at claim** (at-least-once is the contract); `startedAt` records the first claim only. Lease default 60 s.
- **Success** recorded only after the handler's durable effect returns, guarded by `status=running ∧ leaseOwner=me`. A lost lease reports `"lost"` and never overwrites the new owner's record.
- **Failure classification**: permanent classes (`validation`, `unsupported_type`, `not_requested`, `config`) → terminal `dead` on the first attempt; anything else retries with backoff; `attempts ≥ maxAttempts` (5) → `dead`.
- **Backoff**: `raw = 1s · 2^(N−1)`, symmetric jitter ±25 %, absolute cap 5 min → attempt 1 ≈ 0.75–1.25 s, 2 ≈ 1.5–2.5 s, 3 ≈ 3–5 s, 4 ≈ 6–10 s, 5+ ≤ 300 s. Clock and randomness are **injected** for deterministic tests.
- **Recovery**: expired leases are reclaimable by the next scan (no sweeper job); a crashed worker's job re-runs idempotently. Dead-letter inspection/recovery = `requeueDeadJob()` — an internal function that requeues **in place** (unique `dedupeKey` never doubles); **not exposed over HTTP** (contract §207).

## 6. Worker startup, shutdown, local development command

- **Start**: `npm run dev` → Next.js boots → root `instrumentation.ts` `register()` (called once per server instance) → dynamic `import("./lib/server/workerRuntime")` → `startDevWorker()`. First tick immediately, then every **2 s** (batch 5). No separate process or command.
- **Guards, in order**: `NEXT_RUNTIME !== "nodejs"` → no-op (Edge) · `NEXT_PHASE === "phase-production-build"` → no-op (build/static render never starts the loop) · `WORKER_ENABLED === "false"` → explicit kill-switch. All three are executable + static tests.
- **One loop per process**: handle lives on `globalThis` (survives dev hot reload); `createWorker().start()` is additionally idempotent — hot reload cannot stack polling loops.
- **Shutdown**: SIGTERM/SIGINT → `stop()` cancels the pending timer and drains the in-flight tick. Durability never depends on graceful stop (lease expiry + idempotent handlers). `stopDevWorker()` is idempotent.

## 7. Account-deletion selection, scope, retry, audit retention

- **Selection**: only accounts with `User.deletionRequestedAt` set (B4 marker). The handler validates the payload **before any side effect**; a non-requested account raises `PermanentJobError("not_requested")` → dead-letter with zero side effects; malformed payload → `validation` → dead. "User already gone" → **idempotent success no-op** (at-least-once safe).
- **Scope** (your decisions: immediate timing, full personal wipe): one `$transaction` erases user, profile, sessions, auth tokens, inventory, DraftCoin ledger entries, and idempotency records — explicit FK-safe order (identical behavior on real PostgreSQL and the test double; no reliance on cascade).
- **Retry**: mid-work failure rolls back the whole transaction (evidence row included), **the marker is never undone**, and the job retries with bounded backoff — durable state is always sufficient for safe retry.
- **Audit retention**: every `AuditEvent` survives. Existing rows are tombstoned explicitly (`userId → null`, mirroring `ON DELETE SET NULL`), plus a new `auth.account_erased` evidence row written with `userId: null` and `requestId = jobId` (contract: deletion audits retained as non-personal tombstones).
- **Consequence worth noting**: erasure is complete, so the email is immediately free for re-registration (verified live).
- **No provider code**: no Gmail/Google/OAuth/network code exists anywhere in the pipeline (source-scan test, comments stripped).

## 8. All job types and permitted side effects

Exactly one job type — **`account.deletion`** (handler `runAccountDeletion` in `lib/server/deletion.ts`): side effects limited to **local database row deletion + audit writes**. Registered in `JOB_HANDLERS` (dispatch) and `OUTBOX_PLANNERS` (event → job). Unknown event/job types dead-letter **without executing any code**. **No public job-enqueue or worker-trigger endpoint was added** (contract §207 honored; none exists in `app/api/**`).

## 9. Security / redaction review

- Worker/outbox log lines pass only whitelisted scalars (`jobId`, `jobType`, `attempts`, counts, `durationMs`, `owner`, `errorClass`, `outcome`) through the B3 redacting logger. **Payloads are never logged** — a test injects password-looking payload fields and asserts their absence from captured output. Raw error messages/stacks are never logged (coarse `errorCategory` classes only).
- No new endpoints of any kind (logs-only diagnostics decision). No secrets or `.env` values were read or printed at any point.
- Request-ID conventions unchanged; the erasure audit correlates to the job id. No claim of distributed coordination or cross-instance guarantees (see §13).

## 10. Exact changed / untouched files

**Created**: `prisma/migrations/20261010132336_b7_outbox_jobs/migration.sql` · `lib/server/jobQueue.ts` · `lib/server/outbox.ts` · `lib/server/deletion.ts` · `lib/server/worker.ts` · `lib/server/workerRuntime.ts` · `instrumentation.ts` · tests: `lib/server/jobQueue.test.ts`, `lib/server/outbox.test.ts`, `lib/server/deletion.test.ts`, `lib/server/worker.test.ts`, `instrumentation.test.ts` (root) · `docs/B7_REPORT.md`.

**Modified**: `prisma/schema.prisma` (+2 models, +2 enums) · `app/api/v1/me/route.ts` (outbox append inside the B4 transaction + docstring) · `lib/server/audit.ts` (+`auth.account_erased` event type) · `lib/server/fakeDb.ts` (+OutboxEvent/Job models, generic `deleteMany`/increment-aware `updateMany` helpers, snapshot stores) · `app/api/v1/me/me.test.ts` (+2 outbox tests) · `app/api/v1/auth/integration.test.ts` (worker-race tolerance + B7 artifact cleanup) · `vitest.config.mts` (root `*.test.ts` include) · `docs/phase_b7.md`, `docs/BACKEND_ARCHITECTURE.md`, `docs/BACKEND_PHASE_PLAN.md` (records).

**Untouched**: entire frontend (`game/**`, `components/**`, `app/page.tsx`, `app/layout.tsx`), `public/assets/mailxp/**`, `next.config.ts`, and all server modules not listed above (`economy`, `session`, `password`, `http`, `logger`, `catalog`, `sseHub`, `prisma`, B4 auth routes). All B0–B6 migrations untouched; **no pre-existing database rows deleted** (smoke/cleanup scripts removed only rows their own runs created).

## 11. Mock vs live PostgreSQL test results

**Mocked** (in-memory fake with real transaction-rollback semantics): +70 tests across 5 new suites —
- `jobQueue.test.ts` (20): enqueue dedupe (both unique keys), competing claimers never share a job, ordering/batch limits, active vs expired lease, owner-guarded complete/fail, backoff formula/jitter/cap bounds, permanent vs exhaustion vs lost-lease, requeue, restart durability of persisted rows.
- `outbox.test.ts`: commit-with-domain / rollback-leaves-nothing atomicity, relay → exactly one job with dedupe key + outbox id, crash-window idempotency, due/oldest-first/ignored-state selection, unknown-type and invalid-payload terminal failures with no job, transient failure backoff → dead after 5, planner payload policy (deletion-only, `{userId}` only).
- `deletion.test.ts`: full wipe with FK-order deletes, audit tombstones + evidence row, refuse non-requested (no side effects), `not_found` idempotency, mid-tx failure → complete rollback → clean retry, payload validation before side effects, B4 marker/login preservation, no-provider source scan, registry contains only approved types.
- `worker.test.ts`: end-to-end outbox→relay→claim→handler→success in one tick, no re-claim after success, unknown type/invalid payload dead-letter with zero side effect, transient retry honoring backoff then exhaustion, lease-loss safety, at-least-once redelivery, log redaction, `start()` double-call + `stop()` halting a live 5 ms loop, safe failing-tick logs.
- `instrumentation.test.ts` (9): Edge/build-phase/kill-switch/no-NEXT_RUNTIME guards each provably start no worker, `startDevWorker` singleton identity + idempotent stop, static guard-order + dynamic-import + single-call assertions.

**Live PostgreSQL**: auth integration suite 8/8 (DELETE flow now tolerates concurrent erasure and cleans job/outbox artifacts) · **live smoke 30/30** (health → register → 202 → uniform-401 login → worker erases within its poll → job `succeeded`, attempts 1, lease released → outbox `published` → profile/sessions/tokens erased → both audit tombstones present → same email re-registers 201 → control account untouched → zero dead/stuck rows → scripted cleanup) · browser pass: `/` and `/preview` each mount **exactly one canvas, 0 console errors**.

**Disclosed anomalies (honesty over polish):**
1. During iteration the live DELETE test failed twice. First cause identified and fixed: Prisma rejects a `requestId: null` filter (`?? ""`, which `tsc` had also flagged as `TS2322`). The second occurrence could not be reproduced; after the fix the suite passed **10 consecutive runs including a dedicated 6× back-to-back loop**, and assertions were additionally hardened (accept marker-set *or* erased; query sessions by the registration-captured id; correlate audits by the 202's `X-Request-Id`). Residual risk judged low but recorded here rather than hidden.
2. `instrumentation.test.ts` was initially **silently excluded** by vitest's include globs (root-level file). Caught while reconciling file counts (30+5≠34), the config now includes root `*.test.ts`, and the suite ran 9/9 inside the final green sequence.
3. Unplanned but valid durability evidence: three outbox events written by the live suite while no worker was running were relayed and executed by the worker started after a dev-server restart — real cross-process persistence.

## 12. B2–B6 regression results and manual checks

444/444 across 35 files = the **374-test B0–B6 baseline with zero failures** (B4 marker/uniform-401/pending-deletion-cannot-login, B6 economy/idempotency/concurrency, static mount/no-network/server-only scans all green) + 70 new B7 tests. `health`/auth/game/shop/SSE flows covered by the live smoke and existing suites. Manual: dev server boots and logs `worker.started` (redacted, structured), `outbox.published` + `worker.job.ok` observed during the smoke; Phaser canvas-once and clean console verified on `/` and `/preview`; tsc/build stayed green throughout.

## 13. Single-process/deployment limitations and B8 handoff notes

- **In-process worker = a development/single-process guarantee**, not a production multi-instance delivery guarantee: leases make *competing* instances safe, but there is no leader election or presence guarantee. Cloud Tasks/Pub/Sub remain deferred to production (B0 decision). This limitation is documented in `worker.ts` itself.
- Worker lifetime is tied to the Next server; `WORKER_ENABLED=false` disables it without affecting build or rendering; **restart the dev server after changing instrumentation** (the hook runs once per boot).
- Poll (2 s), batch (5), lease (60 s), and backoff numbers are documented constants in `worker.ts`/`jobQueue.ts` (injectable for tests) — dev-tuned, revisit at production deployment.
- Ops visibility is **structured logs only** (approved decision); dead-letter recovery is the internal `requeueDeadJob()` function, documented here as the manual path.
- **For B8**: new event/job types must be registered in `OUTBOX_PLANNERS` + `JOB_HANDLERS` (unknown types dead-letter by design — that is the safety net, not a bug); prefer synchronous flows (B6 pattern) and use the outbox only for genuinely async work; Google OAuth token storage needs its own additive migration **followed by explicit `prisma generate`**; because erasure is complete, a deleted account's email is immediately re-registerable — OAuth account-linking must handle "email absent" rather than "email soft-deleted"; Google credentials `.env` entries remain user-created and must never be printed.

## 14. Provider integration confirmation

**Google OAuth, Gmail, Gemini, and all other provider integrations were NOT started.** No provider/network/queue-integration code (`googleapis`, `gmail`, `gemini`, `oauth`, `fetch(`, `axios`, `calendar`, `cloud tasks`, `pub/sub`) exists in any B7 module — enforced by a source-scan test over all six pipeline files with comments stripped. The job registry contains exactly one type (`account.deletion`); no revocation logic was invented (no integrations exist to revoke). DraftCoin remains simulated; no real money. Nothing under `public/assets/mailxp/` was touched; the game is unchanged.
