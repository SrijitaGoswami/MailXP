MailXP — Backend Phase Plan
Status: B0-finalized (2026-10-10). Sequence ready for user approval; each phase still requires its own start approval.
Execution rule: One phase at a time. Read its specification, implement only its scope, verify, write a report, and stop for explicit approval.

Confirmed decisions applied throughout this plan (user, B0):
- Backend lives INSIDE this repository (Next.js route handlers under app/api/** + server-only service modules; one deployable toward Cloud Run).
- Auth: custom sessions (email+password, httpOnly session cookie, users/sessions tables, bcrypt; Google OAuth hand-flow in B8). No auth library/provider.
- Local database: native PostgreSQL installed on Windows (user rejects Docker). Prisma is the recommended ORM/migration tool — final confirmation at B2 entry.
- Login gate: players register/sign in before Play (gate UI wired in B5; canvas still mounts once behind it).
- Realtime: SSE (server→browser), formalized in B1, implemented in B5; API refetch on reconnect.
- Queue: transactional DB outbox + DB-backed queue + worker (B7); Cloud Tasks deferred to production if needed.
- Google Cloud project + Gemini API key: available, so B8/B10 are not credential-blocked.

Phase workflow rules
1. Confirm the actual project root before doing work.
2. Read context.md, frontend_file_structure.md, docs/FRONTEND_PHASE_PLAN.md, the latest frontend phase report, docs/MASTER_REQUIREMENTS.md, docs/BACKEND_ARCHITECTURE.md, docs/BACKEND_API_CONTRACT.md, and the current phase specification where available.
3. Inspect current code before proposing changes. Do not assume documented architecture perfectly matches implementation.
4. Preserve the frontend, Phaser one-time mount, game/bridge.ts, /preview, assets under public/assets/mailxp/, SSR/hydration safety, accessibility, sound, touch support, and green build.
5. Do not modify unrelated files or add dependencies unless required by the approved phase and explained in the report.
6. Never put network work inside OfficeScene.update(); the game loop must never await network.
7. Do not implement future phases early.
8. Run relevant verification and report exact commands/results. If a check cannot run, state why. Report only checks actually run.
9. Update documentation only where the phase explicitly requires it.
10. Stop at phase completion and wait for user approval.

Proposed roadmap
The roadmap is a planning proposal reconciled with the repository at B0 (see docs/B0_REPORT.md). Phase boundaries may be adjusted with documented rationale.

B0 — Read-only discovery and backend planning  [EXECUTED 2026-10-10 — awaiting roadmap approval]
Goal: Understand the existing app and convert confirmed product decisions into an implementation-ready backend plan.
Prerequisites: none.
Scope: inspect source, package metadata, frontend plan/report, persistence, Phaser bridge, routing, build scripts; identify documentation/code conflicts; confirm decisions; propose dependency-ordered plan.
Deliverables: docs/MASTER_REQUIREMENTS.md, docs/BACKEND_PHASE_PLAN.md, docs/BACKEND_ARCHITECTURE.md, docs/BACKEND_API_CONTRACT.md, docs/phase_b0.md (execution record), docs/B0_REPORT.md.
Verification: four master docs exist and are internally consistent; repository inspection evidence recorded; no application file changed (no source/asset/dependency created, edited, or deleted; no .env introduced).
Exit criteria: all four master documents exist, unresolved decisions are visible, roadmap approved by the user, and no application files have changed.
Out of scope: any application source change, dependency installation, migrations, deployment, Gmail/Google/Gemini calls.

B1 — API contract and integration boundary finalization
Goal: Finalize route naming, schemas, authentication expectations, errors, pagination, idempotency, versioning, SSE event shapes, and frontend integration patterns.
Prerequisites: B0 approved (user sign-off on this roadmap).
Scope: exact paths/methods for every first-release endpoint (auth, profile, economy, shop, notifications, SSE); request/response schemas; status codes and safe error envelope; ownership rules; idempotency keys and retention; rate-limit classes; pagination; resource IDs/version fields; SSE event names/payloads/reconnect semantics; shared typed contract location (game/backend/contract.ts or equivalent, owned by backend chat).
Deliverables: revised docs/BACKEND_API_CONTRACT.md (proposal markers resolved for first-release endpoints), B1_REPORT.md.
Verification: every first-release endpoint in the contract has schema + error + auth + ownership defined; contract cross-checked against this plan and MASTER_REQUIREMENTS; no code written; frontend ownership boundaries stated.
Exit criteria: frontend/backend ownership and every first-release API have an agreed contract. No endpoint is implemented merely because it appears in a draft contract.
Out of scope: any route handler implementation, database work, frontend changes.

B2 — Persistence design and adapter seam
Goal: Define persistent domain entities and isolate existing localStorage persistence behind a migration-friendly adapter with zero behavior change.
Prerequisites: B1 contract approved; PostgreSQL installed natively on Windows; ORM choice (Prisma recommended) confirmed at phase start.
Scope: entity model draft (player, profile snapshot, preferences, integration metadata, inbox metadata, jobs, notifications, reward ledger, inventory/purchases, audit events); local-cache vs server-authoritative field table; refactor game/profile.ts behind a storage adapter (localStorage implementation only in this phase); decide how xp/level/mailCount enter the saved profile (currently ephemeral).
Deliverables: data-model section appended to BACKEND_ARCHITECTURE.md or a docs/DATA_MODEL.md, adapter implementation in game/profile.ts (or game/profile/*), B2_REPORT.md.
Verification: `npx tsc --noEmit` = 0 errors; `npx next build` = 0 errors; profile round-trip checks (new profile defaults, save/load, schema-version migration path, sanitizer rejects corrupt data); seeded legacy `mailxp.profile.v1` data loads unchanged; console clean; Play-flow smoke (menu, shop buy, decor place, save across reload) unchanged.
Exit criteria: reviewed data model, migration approach, adapter boundaries, and safe local-cache behavior; existing behavior provably unchanged.
Out of scope: any server code, Prisma schema in code (design only unless explicitly expanded), frontend UX changes.

B3 — Backend application skeleton and deployment foundations
Goal: Add the smallest maintainable backend foundation inside this repository aligned to the deployment target.
Prerequisites: B2 approved; Prisma confirmed.
Scope: app/api/health route handler; environment variable validation with clear startup errors (names only in docs — never values); Prisma client wiring to local PostgreSQL; migration mechanism and initial empty/baseline migration; structured logging + request correlation; local development instructions (setup Postgres, env, migrate, run).
Deliverables: app/api/**/health/route.ts, server-only lib (e.g. lib/server/**), prisma/ baseline, .env.example (variable names, no secrets), B3_REPORT.md.
Verification: `npx tsc --noEmit` and `npx next build` green; `GET /api/health` returns 200 JSON; missing/invalid env produces a clear actionable error; migration applies cleanly on a fresh local database; frontend smoke unchanged; new dependencies listed in report.
Exit criteria: app starts, health checks work, configuration failures are clear, and existing frontend still builds/runs.
Out of scope: auth, profile/economy endpoints, queues, deployment to Cloud Run.

B4 — Authentication, player profile, and account lifecycle
Goal: Implement email/password auth, session lifecycle, email verification, password recovery, player profile records, and account lifecycle safeguards (server side only).
Prerequisites: B3 approved; health endpoint and DB migrations in place.
Scope: users/sessions schema; password hashing (bcrypt) and policy; register/login/logout endpoints; httpOnly SameSite=Lax session cookie + rotation; expiring single-use password reset; email-verification flow (dev-mode delivery documented); player data isolation enforced server-side; account deletion workflow with documented retained records; audit logging and auth rate limits.
Deliverables: auth route handlers + service modules, schema migration, B4_REPORT.md (with test tooling added as an explicit dependency change).
Verification: automated API tests covering register/login/logout/reset/verify happy and failure paths; wrong-credentials generic error; rate limits trip; cross-account access returns 403/404 without data leakage; cookie flags (HttpOnly, SameSite, Secure outside dev) asserted; session revocation after logout/reset; `npx tsc --noEmit` and `npx next build` green; no frontend files changed.
Exit criteria: auth/profile flows are verified, protected data cannot be accessed cross-account, and deletion behavior is documented/tested.
Out of scope: Google OAuth (B8), login-gate UI (B5), profile sync payloads beyond the account record.

B5 — Server-authoritative profile sync and frontend wiring
Goal: Connect the frontend to the backend while retaining a responsive local cache, and add the confirmed login gate.
Prerequisites: B4 approved; contract for profile/bootstrap endpoints in B1 doc.
Scope: login/register gate in the title overlay (frontend change, minimal and reviewed); bootstrap/profile endpoints; server-authoritative XP, level, DraftCoin, inventory, outfit, decorations, reward history; local cache remains responsive with conflict handling and rejection rollback; SSE stream for profile/notification events with refetch-on-reconnect; approved migration of local-only preferences/cosmetic data; route all game-facing updates through game/bridge.ts.
Deliverables: frontend auth/sync wiring (AppShell/Menu additions), SSE consumer in React layer, B5_REPORT.md.
Verification: end-to-end script: register → login gate → play → profile survives refresh/logout/login; client-side tampering of authoritative fields (crafted localStorage/bridge values) cannot alter server state; canvas remains mounted exactly once (no Phaser remount), bridge is still the only channel; `npx tsc --noEmit`, `npx next build`, console 0 errors; sound/touch/a11y smoke.
Exit criteria: profile survives refresh/login and client manipulation cannot alter authoritative fields; game loop still contains no network awaits.
Out of scope: economy authority switch (B6), Gmail/Gemini, quest persistence beyond what the profile snapshot already covers.

B6 — Economy ledger, rewards, and shop
Goal: Implement verified reward issuance, DraftCoin ledger, daily cap, and atomic shop purchases.
Prerequisites: B5 approved (sync path live).
Scope: server-side fixed reward configuration; qualifying-action verification and per-action/per-email deduplication; UTC daily cap and reset; atomic ledger/balance mutations; atomic shop deduction + inventory grant; idempotency keys on reward/purchase requests; client rollback on rejection (optimistic UI path in ShopScreen/OfficeScene call sites).
Deliverables: economy endpoints + service modules + schema migration, B6_REPORT.md.
Verification: automated tests — duplicate/replayed reward requests cannot double-credit; concurrent purchases cannot overspend (balance never negative); daily cap enforced across UTC boundary; rollback path returns client to pre-action balance; no secrets in logs; tsc/build green; frontend regression smoke.
Exit criteria: duplicate/replayed requests and concurrent requests cannot mint duplicate rewards or overspend balance.
Out of scope: real-Gmail reward evidence (until B11 — use test fixtures or explicit development-only mechanisms), ALGO purchases (B14).

B7 — Durable jobs and operational reliability  [EXECUTED 2026-10-10 — report: docs/B7_REPORT.md; awaiting approval before B8]
Goal: Establish durable background processing for integrations and AI workflows using the decided queue design.
Prerequisites: B6 approved; outbox/job tables in the data model.
Scope: transactional DB outbox + job table + worker loop (dev in-process; Cloud Tasks launcher deferred to production); idempotent job records and retry policy; exponential backoff with jitter; provider rate-limit handling; dead-letter/manual recovery; job status/tracing/metrics and safe logs; UTC scheduling and missed-work recovery.
Deliverables: worker module + job schema/migration + ops notes in docs, B7_REPORT.md.
Verification: kill/restart mid-job test — jobs survive restart; retries do not duplicate side effects (idempotency asserted); backoff+jitter observed; dead-letter path exercisable; logs contain no secrets/token values; tsc/build green.
Exit criteria: jobs survive restart, retries do not duplicate side effects, and failure/recovery behavior is tested.
Out of scope: Gmail/Gemini job types themselves (B9/B10), Cloud Tasks/Pub/Sub adoption.

B8 — Google OAuth connection and integration management  [EXECUTED 2026-10-10 — report: docs/B8_REPORT.md]
Goal: Securely connect/disconnect Google accounts and manage Gmail/Calendar service permissions.
Prerequisites: B4 auth; B7 queue; Google Cloud project (confirmed available) with OAuth consent + scopes approved.
Scope: guided setup and consent explanation; minimal scopes with independent service management; token encryption at rest (key handling per architecture §12) and refresh behavior; stable Google identity deduplication; one active MailXP owner per Gmail mailbox; transfer/release flow; per-mailbox failure isolation; disconnect revokes credentials where supported and removes retained analysis/drafts per policy.
Deliverables: connection endpoints + schema + UI entry point, B8_REPORT.md.
Verification: multi-mailbox isolation and lifecycle tests (connect → refresh → disconnect → re-link); no plaintext tokens in DB or responses; background sync does not start before setup completes; error paths pause only the affected mailbox; tsc/build green.
Exit criteria: multi-mailbox isolation and connection lifecycle are tested without starting background sync before setup completes.
Out of scope: actual sync (B9), Calendar mutations (B12).

B8a — Google sign-in and verification convenience  [EXECUTED 2026-10-10 — addendum report: docs/B8_REPORT.md §15; awaiting explicit approval before B9]
Goal: Add the standard Google-hosted sign-in/create-account entrance alongside existing email/password auth, and let players resend email verification from Settings.
Prerequisites: B8 completed; explicit user approval of Google sign-in and its account-match/consent policy.
Scope: signed-out `intent=signin` OAuth start; verified identity locate-or-create; session rotation + Google connection; audit events; AuthPanel button/outcome handling; Settings resend and development verification convenience.
Deliverables: `docs/phase_b8a.md`, report addendum in `docs/B8_REPORT.md` §15, nullable OAuthState bindings migration.
Verification: 570 automated tests; TypeScript/build/Prisma checks; 22 live smoke assertions; real Google sign-in E2E and browser verification flow, recorded in §15.
Exit criteria: both Google and email/password entrances coexist; no Gmail data sync begins until B9 is separately approved.
Out of scope: Gmail fetch/sync (B9), Gemini (B10), Google password collection, provider changes by MailXP.

B9 — Gmail sync and inbox data
Goal: Implement continuous Gmail sync, historical import, and inbox metadata.
Prerequisites: B8 approved; Gmail API credentials live.
Scope: player-selected initial range (7/30/90 days or all); Gmail push watch + renewal; scheduled reconciliation for missed events; idempotent ingestion and version/history tracking; priority inbox metadata; search/filter data model; attachment metadata with secure preview boundaries (no persistent attachment content by default); no automatic Gmail mutation.
Deliverables: sync worker job types + schema + ingest services, B9_REPORT.md.
Verification: fixture/test mailbox — new and historical mail sync; duplicate push notifications/messages do not create duplicate records; reconnect reconciliation closes gaps; no Gmail-write calls present; tsc/build green.
Exit criteria: new and historical mail sync reliably; duplicate notifications/messages do not create duplicate records.
Out of scope: AI analysis (B10), Gmail actions (B11), search UX polish (B13).

B10 — Gemini analysis, drafts, limits, and pause controls
Goal: Implement the complete per-email analysis-and-reply-draft workflow.
Prerequisites: B9 data; Gemini API key (confirmed available); model/schema decision recorded.
Scope: classification, summary, tasks/deadlines, recommendations, urgency, contextual reply draft; one server-configured model; prompt-injection isolation and schema validation; global AI pause (background and player-triggered); oldest-first queue; daily per-player limit with 00:00 UTC reset; one unit only on successful complete workflow (retry adds none); version-aware reanalysis; persistent results/drafts with useful failure states; stored results readable while paused.
Deliverables: analysis job types + endpoints + limits schema, B10_REPORT.md.
Verification: automated tests for limits, pause, versioning, retries, auth expiry, usage accounting; prompt-injection fixture does not leak cross-player data; no double-billing on retry; tsc/build green.
Exit criteria: limits, pause, versioning, retries, auth expiry, and usage accounting have automated verification.
Out of scope: Gemini attachment analysis (B13 boundary), UI search grounding (B13).

B11 — Approved Gmail actions and reward verification
Goal: Execute approved Gmail actions safely and verify provider outcomes before rewards.
Prerequisites: B6 economy; B9 sync; B10 analysis context.
Scope actions: create draft, send approved reply, archive, apply/change label, mark read — individual approval only (no batches); approval binds exact action + payload; recipient/subject/body review for send; draft creation vs sending are separate approvals; edit/regenerate invalidates prior approval; revalidate email version and stale recommendation; reconcile uncertain sends before retry; verify provider success before reward issuance; audit attempts/outcomes/approvals.
Deliverables: action endpoints + approval records + verification service, B11_REPORT.md.
Verification: no action executes without a valid current approval (stale/edited/tampered approvals rejected); uncertain send results never blindly resend (reconciliation path tested); provider-verified reward issuance only; audits written; tsc/build green.
Exit criteria: no Gmail-changing action can execute without a valid current approval; uncertain send results never blindly resend.
Out of scope: batch operations, new action types beyond the five listed, wallet purchases.

B12 — Notifications, quests, and Calendar experience
Goal: Persist and sync in-game notifications, email-derived quests, and upcoming Calendar events.
Prerequisites: B9/B10 data contracts stable.
Scope: notification types (new mail, analysis complete, urgent, sync error, reconnect required); toast + persistent unread panel/counter; read/dismiss/clear-read; cross-device state; quest priority/deadlines/linked email/progress; checkbox alone never earns reward; Calendar event creation/modification requires individual approval.
Deliverables: notification/quest endpoints + frontend wiring, B12_REPORT.md.
Verification: clearing notifications does not delete underlying data; quest completion cannot bypass B6/B11 reward verification; cross-device sync test; tsc/build green; toast/a11y smoke.
Exit criteria: notification clearing does not delete underlying data and quest completion cannot bypass reward verification.
Out of scope: quest reward value redesign, Calendar write without approval flow.

B13 — Search, attachment previews, and product hardening
Goal: Complete supported search/filter UX and secure attachment metadata/preview behavior.
Prerequisites: B9 metadata + B10 analysis results stable.
Scope: natural-language search grounded in stored metadata/analysis (model calls only when needed); advanced filters; supported attachment allowlist with sanitization and size/type handling; Gmail-authorized download/preview paths; no permanent attachment storage; accessibility and safe failure states.
Deliverables: search/preview endpoints + frontend search UI, B13_REPORT.md.
Verification: search avoids unnecessary model calls; allowlist rejects disallowed types (tests); preview path re-checks Gmail authorization per request; a11y checks; tsc/build green.
Exit criteria: search avoids unnecessary model calls and attachment handling does not bypass Gmail access control.
Out of scope: Gemini attachment analysis, permanent attachment storage.

B14 — Pera Wallet and ALGO purchase verification
Goal: Add optional Pera Wallet connection and verified ALGO-based purchase benefits, only after the off-chain economy is secure.
Prerequisites: B6 stable in production-like conditions; network/transaction policy decided and recorded.
Scope: wallet connection is not payment proof; explicit user-approved transaction; server-side verification of network, destination, amount, status/confirmation policy, eligibility, replay; idempotent transaction processing and audit ledger; strict separation of off-chain earned DraftCoin from on-chain ALGO purchase benefits; no NFT implementation.
Deliverables: wallet endpoints + verification service + audit schema, B14_REPORT.md.
Verification: replayed, wrong-network, wrong-recipient, wrong-amount, failed, and unconfirmed transactions cannot credit benefits (test fixtures/testnet); benefit ledger isolated from DraftCoin ledger; tsc/build green.
Exit criteria: replayed, wrong-network, wrong-recipient, wrong-amount, failed, or unconfirmed transactions cannot credit benefits.
Out of scope: NFTs, fiat payments, automatic purchasing.

B15 — Production readiness, privacy lifecycle, and launch gate
Goal: Prepare the system for a controlled production rollout.
Prerequisites: B7–B12 complete for in-scope features; B13/B14 as approved.
Scope: load/rate-limit and abuse testing; OAuth/provider policy readiness; backup/restore and migration verification; observability and alerting; privacy/deletion/export verification; secret management and environment separation; security + dependency review; incident/recovery runbooks; end-to-end tests across auth, Gmail, AI, approval, rewards, shop; frontend regression/build checks; rollout and rollback plan.
Deliverables: runbooks + test reports + B15_REPORT.md + release checklist.
Verification: backup restore drill; E2E suite green; frontend regression (`npx tsc --noEmit`, `npx next build`, Play smoke) green; load test results recorded; rollback rehearsed.
Exit criteria: release checklist signed off, known limitations recorded, and rollback/recovery verified.
Out of scope: new product features.

Phase dependencies
- B0 precedes every implementation phase.
- B1 must be approved before endpoint implementation.
- B2 precedes durable data-dependent integration work.
- B3 precedes backend services.
- B4 precedes user-specific integration and economy endpoints.
- B5 precedes full production frontend/backend synchronization.
- B6 depends on reliable verification evidence for rewards; B11 completes Gmail-action verification.
- B7 precedes production Gmail/Gemini background processing.
- B8 precedes B9 and Calendar access.
- B9 precedes full B10 and B11.
- B10 precedes AI-assisted recommendations in the UI.
- B11 is required for real Gmail-changing actions and related rewards.
- B12/B13 can proceed after their underlying data contracts are stable.
- B14 must remain separate from ordinary earned DraftCoin.
- B15 is the production launch gate.

Required phase report template
Each report should include:
- Phase and date
- Scope completed
- Files changed/created
- Architecture decisions and rationale
- Commands/checks run and exact results
- Tests added and outcomes
- Security/privacy considerations
- Known limitations and unresolved decisions
- Regression assessment for frontend/Phaser
- Confirmation that no future phase was implemented
- Recommended next phase
- Explicit stop awaiting user approval
