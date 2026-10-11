MailXP — Phase B7: Durable Outbox, Database-Backed Jobs, and Account Lifecycle
Prerequisites: B0–B6. Scope: B7 only. Create docs/B7_REPORT.md and stop before B8.
1. Mission and established architecture
Implement the durable asynchronous-work foundation for the existing MailXP Next.js project: a PostgreSQL transactional outbox, database-backed job queue, explicit in-process development worker, and B4 account-deletion lifecycle processing.
Architecture decisions already established:
- One existing Next.js repository/deployable; PostgreSQL + Prisma.
- Transactional DB outbox + DB-backed queue + in-process development worker.
- Cloud Tasks deferred to production deployment; Pub/Sub only if later fan-out requires it.
- In-process worker is not a cross-instance delivery guarantee.
- Google/Gmail integrations do not yet exist; do not invent provider revocation work.
2. Mandatory discovery
Before editing, read MASTER_REQUIREMENTS.md, BACKEND_PHASE_PLAN.md, BACKEND_ARCHITECTURE.md, BACKEND_API_CONTRACT.md, this file, and available B0–B6 reports. Inspect actual Prisma schema/migrations, B4 User.deletionRequestedAt and AuditEvent, B5 services, B6 purchase/reward/idempotency transactions, scripts and tests. Record baseline results.
B6 report said it stopped pending approval; the user has now explicitly requested B7. This is approval for B7 only, not B8. If the master requirements specify different B7 scope, preserve their terminology and document the resolution. Do not silently expand scope.
3. Non-negotiable boundaries
- Work in the existing repository; no separate backend.
- Preserve B0–B6 behavior, auth, game, shop, ledger, SSE, /, /preview, assets and one-time Phaser canvas mounting.
- No worker/network/database logic in OfficeScene.update().
- Keep server-only modules behind the existing server-only boundary.
- No Google OAuth, Gmail, Gemini, Calendar, wallet/ALGO, production email delivery, Cloud Tasks or Pub/Sub integration in B7.
- No public endpoint allowing arbitrary users to enqueue jobs or execute workers.
- PostgreSQL is the source of truth; no in-memory queue as the durable source.
- Never run prisma migrate reset, drop tables or destructively recreate data.
- Do not start B8.
4. Transactional outbox
Implement a durable outbox using the smallest safe additive Prisma schema change, following existing architecture conventions. An outbox event that represents a domain change must be written in the same database transaction as that change. A rolled-back domain transaction must not leave a publishable event.
Include fields needed for stable identity, event type/version if required, minimal validated JSON payload, creation/processing status, attempts, next-attempt time, safe last-error category and indexes for efficient pending scans. Follow the actual phase plan if it specifies exact fields.
Requirements:
- Survives process restart.
- Delivery is idempotent; crash after effect but before acknowledgement is recoverable.
- No raw cookies, session/auth tokens, passwords, provider credentials, message bodies or unnecessary PII in payloads.
- No event is emitted or marked externally delivered before the source transaction commits.
- Do not enqueue every B6 operation unless requirements say it needs asynchronous work. Keep purchase/reward correctness intact.
5. PostgreSQL-backed job queue
Implement the queue defined by the architecture docs. It must persist job ID/type, validated minimal payload, status, creation/availability/start/completion timestamps, attempts, retry time, safe failure category, dedupe key where needed, and a lease/lock or equivalent safe claim mechanism.
- Claim jobs atomically with PostgreSQL-supported transactions/locking/conditional updates.
- Competing workers must not process the same active lease concurrently under normal operation.
- Recover expired leases after crashes.
- Mark success only after the durable handler effect completes.
- Assume at-least-once processing and make handlers idempotent; do not claim exactly-once execution.
- Use bounded exponential backoff with jitter, max delay and max attempts/terminal failure according to existing requirements.
- Permanent validation/unsupported-type failures must not retry forever.
- Inject time/randomness into retry logic where consistent with existing test conventions.
- Unknown job types and invalid payloads must fail safely without executing arbitrary code.
6. Worker and dispatcher
Create a server-only dispatcher/worker that polls the durable queue at a bounded interval, claims batches safely, records attempts/outcomes, recovers stale leases and supports clean shutdown where practical.
- Do not start an infinite worker loop on every API request.
- Prevent duplicate loops during Next.js dev hot reload.
- Worker disabled must not prevent app build/static rendering.
- Do not add an unauthenticated “run worker” route.
- Use structured, redacted logs with job/request correlation where available.
- If Next.js has no safe lifecycle hook, use an explicit server-only worker entry point and documented local command rather than hiding a fragile loop in a route. Ask before choosing a substantially different deployment topology.
- Document that an in-process worker is for development/single-process use and is not a production multi-instance guarantee.
7. Account deletion lifecycle
B4 DELETE /api/v1/me sets User.deletionRequestedAt, revokes sessions and writes an audit event; physical erasure was deferred to B7. Implement the deletion worker only to the scope and timing defined in master requirements.
- Process only explicitly deletion-requested accounts; never delete accounts merely for inactivity.
- If grace period, erasure scope or audit retention is not defined clearly enough, stop and ask instead of inventing it.
- Make processing idempotent and retry-safe.
- Ensure pending-deletion users cannot authenticate; preserve B4 behavior.
- Respect foreign keys, related inventory/ledger/idempotency records, and AuditEvent ON DELETE SET NULL / tombstone requirements.
- Revoke external integrations only when such integrations exist and their revocation has been implemented in an authorized phase.
- Do not delete or mutate Gmail messages; no Gmail integration exists yet.
- A failure must leave durable state sufficient for safe retry. Do not undo the deletion marker.
- Do not erase required non-personal audit evidence if requirements say it must survive.
8. Allowed job types and side effects
Use only job types grounded in master requirements and B7 scope. Account deletion is in scope if requirements support it. Do not invent future Gmail/Gemini jobs. No provider API calls in B7. If an unknown type appears, record a safe terminal failure. Validate payloads before side effects. Do not add a public job-enqueue API unless explicitly in the contract.
9. Observability and security
Only add a status/diagnostics endpoint if authorized by the API contract/phase plan; otherwise use structured logs and internal testable services. Log safe job/outbox counts, attempts, lease/retry state and failure category. Never log raw payloads, cookies, tokens, email content, passwords or credentials. Preserve request IDs/redaction conventions. Do not claim distributed rate limits or cross-instance worker coordination.
10. Migration safety
- Prefer minimal additive tables/indexes.
- Review generated migration SQL before applying.
- Run npx prisma generate explicitly after every schema change; B6 found stale generated client types when this was omitted.
- Apply migration without reset/drop/recreate; verify Prisma validation/status.
- Verify B2–B6 models and existing user data remain intact.
- Clean only test rows explicitly tagged as B7-created; never delete pre-existing user data.
- Report exact migration name and evidence the migration is additive.
11. Tests and sequential validation
Use existing Vitest conventions; label mocks vs live PostgreSQL evidence honestly.
Required outbox/queue tests:
- Outbox is committed atomically with domain transaction; rollback leaves no outbox event.
- Work survives restart (using persisted rows/integration test).
- Atomic claims prevent competing workers holding the same active lease.
- Expired lease recovery; retry/backoff bounds; permanent failure terminal state.
- At-least-once redelivery does not duplicate durable effects.
- Unknown job type and invalid payload cause no side effect.
- Success/failure/attempt/lease transitions are correct.
- Logs redact sensitive payloads.
- Worker can be disabled; build/static rendering does not require it.
- Dev hot reload does not create unbounded polling loops.
Required account-deletion tests:
- Requested account is selected; non-requested account is never selected.
- Repeated processing is safe.
- Mid-work failure can be retried.
- Foreign keys and audit tombstone/retention semantics are correct.
- Pending deletion cannot authenticate.
- No unrelated account is erased and no provider call is attempted.
Regression:
- B2–B6 tests pass.
- B6 purchases, rewards, idempotency and ledger remain correct.
- /, /preview, /api/v1/health, auth, game state, shop and SSE remain intact.
- Phaser remains mounted once; no worker/network code enters OfficeScene.update().
Run sequentially, never concurrently:
1. npx vitest run
2. npx tsc --noEmit
3. npm run build (or documented repo equivalent)
4. npx prisma validate
5. npx prisma migrate status
6. Live PostgreSQL worker/outbox/deletion smoke tests if supported.
If a command fails, fix within B7 and rerun the full sequence. Never claim a check passed unless it actually ran successfully.
12. Out of scope
Google OAuth/Gmail (B8/B9), Gemini (B10), approved Gmail actions/rewards (B11), Calendar/notifications/quests/wallet, production email provider, Cloud Tasks and Pub/Sub integrations, distributed rate limiting/SSE migration, game redesign, and all B8 work.
13. Required docs/B7_REPORT.md
Include:
1. Completion status, blockers and deferred items.
2. Baseline/final sequential command results.
3. Outbox/job schema and migration name.
4. Transactional outbox guarantees and transaction integration points.
5. Claim/lease/recovery/retry semantics.
6. Worker startup/shutdown and local development command.
7. Account-deletion selection, scope, retry behavior and audit retention.
8. All job types and permitted side effects.
9. Security/redaction review and confirmation no public worker trigger was added.
10. Exact changed/untouched files.
11. Mock vs live PostgreSQL test results.
12. B2–B6 regression results and manual checks.
13. Single-process/deployment limitations and B8 handoff notes.
14. Explicit confirmation that Google OAuth/Gmail/Gemini/provider integration was not started.
14. Stop conditions
Stop and ask for approval if deletion timing/scope/audit retention is unclear; a safe worker lifecycle requires an unapproved deployment topology; claims/leases cannot be made safe; a migration risks existing data; the outbox cannot be committed atomically with the relevant transaction; a job needs an unapproved provider side effect; or a core acceptance criterion cannot be verified honestly.
15. Final instruction
Implement B7 only in the existing MailXP repository. Build the durable transactional outbox, PostgreSQL-backed queue, safe in-process development worker and account-deletion lifecycle processing exactly as supported by project requirements. Preserve B0–B6 behavior. Run all checks sequentially, create docs/B7_REPORT.md, summarize actual results, and stop for explicit approval before B8.
16. Execution record (2026-10-10)
- Discovery: read MASTER_REQUIREMENTS, BACKEND_PHASE_PLAN, BACKEND_ARCHITECTURE (§6 queue decision), BACKEND_API_CONTRACT (me.delete 202 async; §207 no public ops endpoints), B0–B6 reports, B4 DELETE transaction (app/api/v1/me/route.ts), schema/AuditEvent SetNull design.
- Question round (user-approved, four answers): timing = immediate (next worker tick after 202, no grace period); scope = full personal wipe in one transaction (user/profile/sessions/tokens/inventory/ledger/idempotency; audits survive as tombstones); startup = instrumentation.ts register() with globalThis single-loop guard + WORKER_ENABLED=false kill-switch; diagnostics = structured logs only (no ops endpoint).
- Implementation: schema (OutboxEvent/Job + status enums) → migration 20261010132336_b7_outbox_jobs (additive, SQL reviewed) → explicit npx prisma generate → lib/server/{jobQueue,outbox,deletion,worker,workerRuntime}.ts → outbox append inside the B4 DELETE transaction → root instrumentation.ts → auth.account_erased audit type → fakeDb extensions → 5 new test suites + 2 route tests + live-suite hardening → vitest.config root include.
- Baseline before edits: vitest 374/374 (30 files), tsc 0, build 0, validate valid, migrate status up to date.
- Iteration fixes (each followed by reruns): Prisma Json create rejects plain null (omit instead); interface narrowing for Prisma structural compatibility (OutboxAppendDb = create-only); worker tick typing; one test-data ordering bug (claim ordering fixture); TS18046 unknown row field in a test; Prisma rejects null requestId filter in the live suite (?? ""); vitest root-glob omission of instrumentation.test.ts (config) and its comment-stripping static assertion.
- Final sequential run: vitest 444/444 (35 files) → tsc 0 → build 0 → prisma validate valid → migrate status up to date → live smoke 30/30 → DB check (2 pre-existing accounts; jobs 0, outbox 0, erased audits 0).
- Live evidence: worker started via instrumentation on dev-server boot; smoke verified 202 → uniform 401 → relay → succeeded job (attempts 1, lease released) → physical erasure → audit tombstones → email freed → controls untouched → zero dead/stuck rows. Browser pass: / and /preview single canvas, 0 console errors. Cross-process durability observed: 3 events written while no worker ran were relayed after a server restart.
- Anomalies disclosed in B7_REPORT.md §11 (one unreproduced live-test failure, 10 consecutive greens after fix; initial exclusion of the root test suite from vitest globs, caught by file-count reconciliation).
- Cleanup: smoke rows removed by script, integration suite cleans its own B7 artifacts, 3+3 orphan job/outbox rows from pre-cleanup runs swept; no pre-existing user data touched.
- Report: docs/B7_REPORT.md (14 required sections). Stopped before B8, awaiting approval.