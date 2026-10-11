MailXP — Backend Architecture
Status: B0-reviewed architecture baseline (2026-10-10). Confirmed decisions are marked; open ones remain open until their phase.
Hosting direction: Managed Google Cloud, Cloud Run, managed PostgreSQL
Important: The exact repository layout, authentication library, queue product, migration tool, and API conventions must be verified/approved during B0. This document does not authorize implementation by itself.
1. Architectural goals
- Keep the existing Next.js/React/Phaser game stable.
- Introduce a secure backend for identity, integrations, profile, economy, and durable workflows.
- Treat PostgreSQL as the source of truth for player progression and financial-like ledgers.
- Keep Gmail and Gemini work asynchronous and outside the Phaser game loop.
- Require explicit individual approval for every Gmail- or Calendar-changing action.
- Make jobs, provider callbacks, and mutations idempotent.
- Minimize retained email content and protect provider credentials.
- Support multiple mailboxes per player while isolating each mailbox's failures.
- Make production operations observable and recoverable.
2. Logical component view
Browser
  ├── Next.js / React UI
  ├── Phaser 2D game
  └── Existing game/bridge.ts (only React ↔ Phaser boundary)
             │ HTTPS API / authenticated realtime channel
             ▼
Cloud Run application services
  ├── Authentication/session boundary
  ├── Player profile and preferences
  ├── Integration connection manager
  ├── Gmail sync orchestration
  ├── Gemini analysis orchestration
  ├── Approval and Gmail action executor
  ├── Quest / Calendar services
  ├── Notification service
  ├── Economy / reward ledger / shop
  └── Wallet payment verification (later phase)
             │
             ├── Managed PostgreSQL
             │     ├── players and profiles
             │     ├── linked Google identities/mailboxes
             │     ├── message metadata and analysis
             │     ├── drafts, recommendations, approvals
             │     ├── jobs and idempotency records
             │     ├── notifications and quests
             │     ├── XP/DraftCoin ledger, inventory, purchases
             │     └── audit and integration events
             │
             ├── Durable queue / scheduled work (product TBD)
             ├── Managed secret storage
             └── Observability
External providers:
  Google Identity / OAuth, Gmail API, Google Calendar API, Gemini API,
  Pera Wallet and the relevant ALGO network (later phase)
This is a logical architecture. B0 must determine whether these responsibilities are modules in one backend service initially or separate deployable services. Prefer the simplest architecture that meets isolation, reliability, and scaling needs; do not split services merely for theoretical scalability.
3. Trust boundaries
Browser is untrusted
The browser and game client may display profile state, collect user intent, render AI results, and request operations. They must not decide:
- XP or DraftCoin awards
- balances or prices
- inventory ownership
- reward eligibility
- whether Gmail/Calendar action approval is valid
- payment confirmation
- access to another player's records
Every protected mutation is authenticated, authorized, validated server-side, and recorded as needed.
Email content is untrusted
Email bodies, sender display names, links, quoted messages, signatures, and attachment metadata can contain malicious instructions. They are data to analyze, not authority. Prompt injection must not override system policy, user settings, tool permissions, or explicit approval requirements.
External providers are asynchronous and fallible
Google push events may be duplicated or missed; token refresh may fail; APIs can rate-limit; Gemini may time out; a send request may have an uncertain outcome. The backend must persist state, reconcile provider truth, and use idempotency rather than assuming exactly-once delivery.
4. Suggested domain boundaries
These are logical modules; final physical placement follows repository inspection.
Identity and player profile
- MailXP player identity and verified contact
- Session lifecycle
- Shared profile across all linked mailboxes
- Profile preferences and approved local-only preference migration
- Account deletion state
Google integration manager
- OAuth connection and refresh tokens
- Stable Google identity mapping
- Gmail and Calendar permission state
- Mailbox ownership and transfer
- Disconnect/reconnect workflows
- Minimal scope tracking
Gmail ingestion
- Initial history import
- Push notification/watch lifecycle
- Scheduled reconciliation
- Message metadata/version ingestion
- Deduplication and change detection
- Priority inbox inputs and search index fields
AI workflow
- Eligibility/category rules
- Durable analysis job lifecycle
- Gemini model/configuration adapter
- Structured response validation
- Prompt-injection controls
- Summary, classification, task, urgency, recommendation, and reply-draft storage
- Usage metering, global pause, and reanalysis policy
Approval and Gmail action executor
- Immutable approval record tied to exact payload/version
- Approval expiry/staleness policy (configurable)
- Revalidation before execution
- Gmail draft/send/archive/label/read operations
- Provider outcome reconciliation
- Audit trail
Quest, Calendar, and notifications
- Email-derived tasks and quest progress
- Calendar event reads and approved mutations
- Persistent notifications and cross-device read state
Economy
- XP and level rules
- DraftCoin ledger and balance projection
- Reward rules, caps, idempotency, and verification
- Shop catalog, purchase transaction, inventory grant
- Separation of off-chain DraftCoin from ALGO purchase records
Wallet verification (later)
- Wallet association, transaction intent, server verification, replay protection
- Network/recipient/amount/confirmation checks
- No NFT functionality in initial scope
5. Data ownership and consistency
PostgreSQL is authoritative
At minimum, PostgreSQL owns:
- Player/profile and persistent preferences
- XP/level and progression
- DraftCoin ledger and balance projection
- Inventory, outfits, decorations, shop purchases
- Reward history
- Integration ownership/state
- Synced email metadata, analysis, drafts, tasks, and notification state according to retention policy
- Job lifecycle and idempotency keys
- Approvals and Gmail action results
- Wallet transaction verification records when introduced
- Audit events
The frontend may use localStorage or another local cache for responsive rendering, but must not overwrite server-authoritative values. During login/bootstrap, fetch authoritative state. After important actions, refresh it. For remote updates, use a realtime channel or polling strategy selected in B0. Do not migrate arbitrary local data; only explicitly approved local-only preferences/cosmetic data may be migrated.
Transactions and ledger
- Coin ledger entries and balance projection updates must be atomic.
- Shop purchase deduction and item grant must be atomic.
- Reward issuance must be idempotent and tied to verified evidence.
- Database constraints should reinforce uniqueness and ownership boundaries.
- Use a transactional outbox or equivalent reliable dispatch pattern if database commits trigger asynchronous jobs/events; final choice depends on queue selection.
6. Background processing
Background processing handles:
- Gmail initial history import and incremental sync
- Push-notification processing and watch renewal
- Scheduled reconciliation
- Gemini analysis and draft creation
- Retry/recovery
- Calendar sync if required by approved scope
- Cleanup/retention tasks
- Future wallet transaction reconciliation
Required semantics
- Persist a job before or atomically with the event that requires it.
- Jobs have stable IDs, state, attempt count, schedule, provider/resource version, and correlation IDs.
- Make handlers idempotent.
- Use bounded exponential backoff with jitter and provider rate-limit signals.
- Do not retry permanent authorization failures until the user reconnects.
- Do not let one mailbox failure block other mailboxes.
- Reconcile ambiguous Gmail send/draft outcomes before repeating side effects.
- Preserve jobs through restarts and deploys.
- Keep a manual inspection/recovery path for dead-letter or exhausted jobs.
Queue decision (B0, 2026-10-10)
Managed Google Cloud remains the hosting direction, and the durable queue design is now decided for the first releases: a **transactional DB outbox plus a database-backed job queue processed by a worker loop**, so job rows commit atomically with the state that requires them and everything runs/test locally with no GCP dependency. Dispatch may migrate to Cloud Tasks at production without redesign (same job records, different launcher). Pub/Sub stays deferred until genuine multi-consumer fan-out exists. Evaluation criteria that drove this: delivery/retry guarantees, oldest-first per-player ordering for the Gemini queue, duplicate delivery handled by idempotent handlers, rate limiting via worker concurrency, minimal operational complexity/cost, and local testability. Do not choose a different product in a later phase without a documented re-evaluation.
7. Gmail lifecycle and safety
Connection setup
1. Player authenticates to MailXP and verifies email.
2. Player starts guided Google setup.
3. Explain Gmail/Calendar data use and scopes.
4. Player selects services and grants consent.
5. Persist the connection and encrypted token material.
6. Begin sync only after setup completes.
Sync
- Ingest new mail from push notifications.
- Reconcile on a schedule to recover missed notifications.
- Renew Gmail watches before expiry.
- Deduplicate provider events and messages.
- Track relevant message/history versions.
- Queue historical import according to the selected 7/30/90-day/all setting.
- Keep Gmail sync operating during global Gemini pause.
Disconnect
- Stop new sync and work for that mailbox.
- Revoke/delete credentials where supported.
- Delete retained analysis/drafts for that mailbox according to policy.
- Preserve game progression, economy, and reward history.
- Do not touch the original Gmail messages.
- Leave other linked mailboxes running.
Auth expiry
- Pause only the affected mailbox.
- Preserve existing records and queued work.
- Notify the player to reconnect.
- On reconnect, resume automatically subject to global AI pause, categories, and limits.
8. Gemini workflow and metering
A single configurable model is used initially. For each eligible email:
1. Confirm mailbox is connected and not paused.
2. Check global AI pause and player category settings.
3. Check usage limit and queue ordering.
4. Retrieve only the necessary email content.
5. Treat all email content as untrusted input.
6. Request structured classification, summary, tasks/deadlines, urgency, recommendations, and reply draft.
7. Validate and persist results, source version, and model/config version.
8. Count one usage unit only when the full analysis-plus-draft workflow succeeds.
9. On retry, reuse the same logical job and do not count an extra unit.
10. If content changes, mark the prior recommendation stale/outdated, preserve it for history, and queue updated analysis when eligible.
Global pause blocks background and user-triggered analysis, but does not block Gmail sync or access to stored results. In-flight analysis may finish and is accounted normally. New jobs wait oldest-first until resume and available daily quota. Reset quota at 00:00 UTC.
9. Approval state machine
Every Gmail-changing action is individual and explicit.
Suggested conceptual lifecycle:
RECOMMENDED
   │ player reviews exact action and payload
   ▼
PENDING_APPROVAL
   │ player explicitly approves exact version
   ▼
APPROVED
   │ revalidate auth, target, content version, and payload hash
   ▼
EXECUTING
   ├── provider confirms success ──> SUCCEEDED
   ├── definitive failure ─────────> FAILED / RETRYABLE
   └── ambiguous outcome ──────────> RECONCILIATION_REQUIRED
- Editing/regenerating a draft invalidates prior approval.
- Sending requires review of exact recipient, subject, and body.
- Draft creation and sending are separate actions and approvals.
- A stale message/recommendation must be refreshed before execution.
- Never auto-approve and never batch-approve.
- Rewards are granted only after independently verified success.
- Store enough information to prove what was approved, without retaining unnecessary sensitive content.
10. Economy architecture
Reward flow
1. A player requests or performs a qualifying action.
2. Backend validates the authenticated owner and current approval.
3. Backend performs or verifies the provider action.
4. Backend records provider evidence and action outcome.
5. Reward service checks eligibility, duplicate keys, reward rule, and UTC daily cap.
6. In a database transaction, append ledger entry and update balance projection.
7. Return authoritative profile/economy state.
Candidate qualifying actions: approved reply sent and confirmed; archive; label change; mark read; Gmail draft created; extracted task completion only when linked to a separately verified qualifying action. Opening or receiving mail is never rewarded.
Shop flow
1. Client submits item identifier and idempotency key, not a trusted price.
2. Server loads current price and eligibility.
3. Server checks balance and ownership.
4. In one transaction, record purchase, debit DraftCoin, and grant inventory.
5. Return authoritative state.
ALGO purchase flow (later)
- Player connects Pera Wallet and explicitly approves a transaction.
- Backend creates/records the expected payment intent if required by final design.
- Server verifies the transaction on the correct network, destination, amount, status/confirmation policy, eligibility, and replay state.
- Credit only the separately defined purchase benefit, atomically and idempotently.
- Do not treat wallet connection as payment.
- Do not merge ALGO and earned DraftCoin ledgers.
- NFTs remain deferred.
11. Notifications, quests, Calendar
- Store notifications durably and synchronize read state across devices.
- Toasts are non-blocking; notifications remain in an inbox until read/dismissed according to rules.
- Clear-all applies only to read notifications in the active list and does not delete source records.
- Urgent mail appears in Priority inbox and emits a notification, but never triggers a Gmail action.
- Email tasks can become quests with deadlines, priority, linked email, and progress.
- Checkbox completion alone does not mint a reward.
- Calendar event creation/modification requires an individual approval separate from Gmail approvals.
12. Security and privacy controls
- Keep OAuth refresh tokens encrypted and inaccessible to the browser.
- Store secrets in managed secret storage, not source files.
- Use TLS and platform encryption at rest.
- Authenticate and authorize every private resource; scope every query to the player.
- Rate-limit login, reset, OAuth, AI, and mutation endpoints.
- Validate structured AI output and all request bodies.
- Prevent CSRF where applicable, XSS, injection, IDOR, replay, and duplicate side effects.
- Use audit events for approvals, provider actions, rewards, purchases, wallet credits, and account lifecycle.
- Avoid logging full email bodies, tokens, reset links, passwords, wallet secrets, or private keys.
- Define retention/deletion jobs and backup access controls.
- Complete OAuth/provider policy and privacy review before public launch.
13. Observability and operations
Every request and background job should carry correlation IDs. Logs should identify player/mailbox/job using non-sensitive internal IDs, record status/duration/retry counts, and omit message contents and secrets.
Track:
- Gmail notification lag, reconciliation results, watch expiry/renewal
- Queue depth/age and failed jobs
- Gemini success/failure, latency, usage, and quota deferrals
- Gmail action success/failure/ambiguous outcomes
- Reward deduplication and cap rejections
- API latency/error rate
- Database health and connection saturation
- OAuth refresh failures
- Wallet verification outcomes when implemented
Use health/readiness checks, alerting, backup/restore testing, migrations with rollback planning, and per-environment configuration.
14. Architecture decisions — B0 status
Decided at B0 (user-confirmed 2026-10-10):
- Backend placement: INSIDE the existing repository (Next.js route handlers + service modules, one Cloud Run deployable). Alternative (separate service/repo) rejected for now: unnecessary CORS/two-server overhead at this stage.
- Auth/session: custom sessions — email+password, httpOnly session cookie, users/sessions tables, bcrypt hashing; Google OAuth as a hand-rolled code flow in B8. Alternatives (Auth.js, managed provider) rejected: library-compatibility risk with Next 16 and vendor dependence.
- Local database: native PostgreSQL on Windows (user rejects Docker). CONFIRMED at B2: Prisma 7.10 (stable line — npm's `latest` channel served an 8.0.0 release candidate with a platform-centric workflow, deliberately not adopted), applied to local PostgreSQL 18.6. Prisma 7 specifics: the migrate connection URL lives in prisma.config.ts (the schema datasource no longer accepts `url`), and the client generates to node_modules/@prisma/client.
- Stats persistence: xp/level/mailCount/quest progress stay EPHEMERAL through B2 (user sign-off, 2026-10-10); server-authoritative persistence arrives with B5 sync via a dedicated migration.
- Resource IDs: UUIDv7 via Prisma's `@default(uuid(7))` (supported on the confirmed toolchain).
- Queue/orchestration: transactional DB outbox + DB-backed queue + worker (see section 6).
- Realtime profile/notification updates: SSE (server→browser), authenticated with the session cookie, player-scoped events, API refetch on reconnect. Polling is the fallback; WebSockets rejected as unnecessary.
- Login UX: login gate before Play (product decision, affects frontend in B5).

Still open (resolve in the named phase):
- ORM/query layer and migration tooling — Prisma recommended, confirm at B2. (Resolved at B2: Prisma 7.10 confirmed; see the decided list above.)
- API versioning, error envelope, pagination conventions — B1.
- OAuth scopes and token encryption approach — B8 (KMS/envelope encryption choice at B8).
- Gemini model, structured-output schema, safety filters, cost controls — B10.
- Data retention periods and deletion workflow details — B15 (with privacy review).
- Search indexing approach — B13.
- Attachment preview allowlist and delivery mechanism — B13.
- ALGO network/transaction confirmation policy and purchase benefits — B14.
- Cloud Run service topology, database connectivity (Cloud SQL), environment strategy, backups, monitoring — B3 foundations + B15 production gate.

15. Repository reconciliation (B0 evidence, 2026-10-10)
The logical component view in section 2 maps to the actual repository as follows — one Next.js App Router application, no separate backend code today:
- Browser: components/AppShell.tsx (shell/title/HUD), components/GameMenu.tsx + components/screens/* (all game UI), game/bridge.ts (the ONLY React↔Phaser channel), Phaser canvas mounted once by components/PhaserCanvas.tsx.
- Application services: to be added as Next.js route handlers under app/api/**/route.ts plus server-only service modules — placed in this repository per the confirmed decision. OfficeScene.update() must never gain network calls; server responses arrive on the React side and flow through bridge/profile subscribers.
- Persistence seam today: game/profile.ts — synchronous localStorage ("mailxp.profile.v1", schema version 1) with a sanitizer; single choke point for draftCoin, ownedItems, equippedOutfit, placedDecor, prefs. B2 wraps it behind an adapter; the local cache stays for responsiveness (section 5 unchanged).
- State seam today: game/bridge.ts GameSnapshot carries xp/level/mailCount/quest state that is NOT persisted anywhere (in-memory only). PostgreSQL must become authoritative for these (requirement 8.1) — B2 decided they remain ephemeral (user sign-off); B5 adds the authoritative persistence. Since B2, localStorage access in game/profile.ts routes through a synchronous ProfileStorage adapter (game/profileStorage.ts; active backend unchanged) so a server-backed sync can swap storage without rewriting consumers.
- Economy today: client-side only (purchaseItem/spendDraftCoin/addDraftCoin in game/profile.ts; call sites in components/screens/ShopScreen.tsx and game/scenes/OfficeScene.ts). No server validation exists — B6 replaces the authority, keeping optimistic client behaviour with rollback (section 10 flows).
- Auth today: none. No app/api directory, no .env files, no sessions. The confirmed login gate adds frontend work in B5.
- Verification available today: `npx tsc --noEmit`, `npx next build`, asset scripts under scripts/. No test framework exists; backend test tooling is an explicit, reported dependency change in B3.
- Secrets: no environment files exist yet; .gitignore already excludes .env*. Never commit values; document names only.

16. Trust-boundary note for the login gate
The confirmed login gate changes the boot flow but not the architectural invariants: the Phaser canvas still mounts exactly once behind the gate (paused), React↔game traffic still uses game/bridge.ts only, and the session cookie is httpOnly — the game code must never read or carry tokens.

17. B3 implementation details (confirmed 2026-10-10)
- Database access: lib/server/prisma.ts exports getDb() — LAZY construction (env validated at first server use, never at import, so builds pass without runtime secrets), Prisma 7.10 + @prisma/adapter-pg 7.10 (`new PrismaPg({ connectionString })` → `new PrismaClient({ adapter })`), single client reused across dev hot reloads via globalThis (one pool, never per request).
- Environment validation: lib/server/env.ts validates only DATABASE_URL (present + postgresql:// shape); errors are SERVER_ENV_MISSING / SERVER_ENV_INVALID and never contain the value.
- Logging: lib/server/logger.ts — always JSON lines ({ts, level, msg, …fields}); secret-ish field keys (pass/secret/token/auth/cookie/credential/connection/database/apikey/private) are dropped defensively; no stack traces, SQL, bodies, or raw driver errors are ever logged.
- Request IDs: safe inbound X-Request-Id accepted only as /^[A-Za-z0-9_-]{8,64}$/; anything else becomes crypto.randomUUID(); every handled response (200 and 503) returns X-Request-Id.
- Health route: app/api/v1/health/route.ts, `export const dynamic = "force-dynamic"`; probes `SELECT 1` through Prisma with a 2 s Promise-race timeout; success 200 {status:"ok", db:"ok", version} with version read from package.json (user decision); failure 503 with the B1 error envelope (code SERVICE_UNAVAILABLE) and only a coarse category (config/timeout/db) in server logs.
- Boundary: server modules (lib/server/**, app/api/**, @prisma/*) are kept out of client/game bundles, enforced by the static-scan test lib/server/serverOnly.test.ts.

18. B4 implementation details (confirmed 2026-10-10)
- Route wrapper: lib/server/http.ts exports handle(routeId, fn) — per-request requestId (safe inbound X-Request-Id or random UUID), uniform error envelope {error:{code,message,requestId,details?}}, 400 for validation/schema violations, sanitized 500 INTERNAL_ERROR (message never logged — only routeId + error category), and a uniform Origin gate applied to EVERY mutation (host-equality check: protocol-agnostic, same host+port required; missing/null/garbage Origin → 403 CSRF_ORIGIN_REJECTED). No double-submit token — contract's trigger ("only if origin checks prove insufficient") not reached.
- Sessions: lib/server/session.ts — opaque 256-bit token (randomBytes(32), base64url), only its SHA-256 hash persisted; cookie `mailxp.session` httpOnly, SameSite=Lax, Path=/, 30-day sliding (Max-Age 2592000), Secure only in production. Sliding expiry writes throttled to at most one per session per hour. Login rotates (old session revoked + new issued in one transaction); password reset and account deletion revoke ALL sessions.
- Auth tokens: lib/server/tokens.ts — purpose-scoped AuthToken rows (EMAIL_VERIFICATION 24h, PASSWORD_RESET 1h), SHA-256 at rest, atomic single-use consumption (guarded UPDATE, one winner), issuing supersedes prior outstanding tokens of that purpose. Raw tokens exist only in the dispatch path — never in DB rows, logs, or production responses.
- Passwords: bcryptjs 3.0.3, cost 10, pure JS (no install scripts, bundled types); password policy 10–128 chars + ~200-entry static common-password blocklist (no composition rules); unknown-email logins pay identical bcrypt cost via burnPasswordCheck (timing parity, uniform 401 INVALID_CREDENTIALS).
- Rate limits: lib/server/rateLimit.ts — process-local in-memory Map behind a replaceable RateLimitStore interface; fixed windows with injected clock. Classes (contract §1.8, signed off at B4): register 5/h/IP, login 10/15min per normalized-email+IP, forgot and resend 5/h per email+IP (separate per-route counters), general 60/min keyed by player id (authenticated) else IP (first X-Forwarded-For entry). NOT distributed across instances — documented replacement seam; keys never logged.
- Audit: lib/server/audit.ts writes AuditEvent rows (event type, user, requestId, minimal meta) using logger's exact redaction; never emails, content, passwords, tokens, or IPs. FK is SetNull so rows survive as non-personal tombstones after eventual user deletion.
- Email delivery: lib/server/emailDelivery.ts — dev-only `devDelivery {purpose, token, expiresAt}` field on register/resend/forgot when NODE_ENV !== "production"; production responses carry exactly the contract shape with no token. No provider configured — production verification/reset delivery is BLOCKED until an approved provider phase; no token is ever logged.
- Account deletion: DELETE /me re-authenticates with password → single transaction (guarded deletionRequestedAt marker WHERE IS NULL + revoke all sessions + audit) → 202; login immediately returns uniform 401; physical erasure/integration revocation deferred to the B7 lifecycle worker (marker is idempotent and worker-friendly). No Gmail/provider code exists in B4.
- Account data: register creates the PlayerProfile row in the same transaction with prefs byte-identical to game/profile.ts DEFAULTS.prefs (B5 finds every user profiled). Nothing reads server profiles yet — game behavior unchanged.
- Tests: vitest (vitest.config.mts loads .env via process.loadEnvFile for the live suite, testTimeout 15s) — 143 tests across 13 files: unit suites, mocked-route suites (fake DB + real crypto), and a clearly-labelled LIVE integration suite against mailxp_dev that self-skips if unreachable and cleans its own rows.

19. B5 implementation details (confirmed 2026-10-10)
- Game state: GET /api/v1/game/state derives identity ONLY from the session, includes inventoryItems, returns contract defaults when the profile row is missing (never create-on-read) and excludes all internal material. Schema additions are purely additive: PlayerProfile +xp/+level/+stats (all defaulted) and a new LedgerEntry table with LedgerType enum, cascading FK and a [profileId, createdAt DESC, id DESC] index for §1.5 cursor pagination.
- Preferences: PATCH /api/v1/game/preferences — strict Origin → session → general 60/min rate → six-key allowlist validation → required integer expectedVersion → atomic conditional updateMany (count 0 → 409 STALE_VERSION whose details carry the safe currentVersion) → version increment → profile.updated published to the SSE hub only AFTER commit. Empty patch → 400; unknown keys/smuggled economy fields → 400 with field details; missing profile → 404.
- Ledger: GET /api/v1/game/ledger — session-scoped, opaque base64url cursor (createdAt DESC, id DESC tie-break; default 25, max 100; nextCursor null at end), strict query-param whitelist (400 otherwise), honest {items:[], nextCursor:null} until B6 writes rows (user-approved: table created empty rather than faking entries).
- SSE: GET /api/v1/events — lib/server/sseHub.ts process-local hub (subscribe cap 3/player → 429 + Retry-After 60; player-scoped fan-out; throwing sinks dropped) and route behavior: retry: 5000 directive, named events (profile.updated {version}; economy.updated at B6), named ping heartbeat ~25 s, server-side close at 30 min, teardown on cancel/abort/max-age. Route does not use handle() (streaming body) but reproduces its request-id/logging semantics. ORIGIN RULE: originConflicts() — browsers omit Origin on same-origin EventSource GETs (found live: the strict check 403'd the app's own stream), so ABSENT is allowed on this read-only stream while PRESENT cross-site/null/garbage still 403s; mutations keep the strict originMismatch (Origin is always sent on PATCH/POST), with SameSite=Lax cookies as the second gate.
- Client sync: components/authStore.ts (module store + useSyncExternalStore; one boot probe via GET /me, StrictMode-guarded; single-transition session-lost handling — no retry loops), components/apiClient.ts (fetch wrappers, envelope→ApiError, NETWORK_ERROR mapping), components/gameSync.ts (one-time migration + hydration mapping + stream/polling state machine) and components/useGameSync.ts (effect lifecycle: backup → capture legacy prefs → hydrate → one-time prefs import → subscribe → EventSource open/refetch, profile.updated→refetch, ≥3 failures→30 s polling; full cleanup; no Phaser touches). game/backend/contract.ts is the types-only shared contract.
- Local migration (user-approved field authority): backup-first byte-identical copy under mailxp.profile.v1.legacy-backup + mailxp.profile.v1.migrated marker (never re-runs, never deletes the backup); only the 6 preference keys import one-time; draftCoin/ownedItems/equippedOutfit/placedDecor/xp/level/stats are server-won and mirrored into the local cache on every refetch (local gameplay earnings are non-authoritative until B6 — approved).
- Gate: AppShell probes auth at boot; checking/signedOut → AuthPanel on the existing title overlay (tabs, role=alert, B4-exact requests), signedIn → Play + email + Sign out; started is forced off whenever not signedIn and the game menu closes with the play session (live-found fix: Settings→Sign out sits inside the open menu). The PhaserCanvas block is untouched — one unconditional mount (static guard test + live dataset-tag proof across sign-out/sign-in).
- Tests: 297 across 24 files (4 new route suites, gameState/preferences/sseHub/http units, apiClient/gameSync/authStore client units, static mount/no-network guards). Dev and production smokes: 41/41 each. DB left at zero rows. Known limits restated: process-local hub and rate limiter (no cross-instance guarantee), no SSE replay (B12), until-B6 economy not server-issued.
20. B6 implementation details (confirmed 2026-10-10)
- Economy values (user-confirmed at B6): quest reward 20 DraftCoin, cap 100 per UTC day (reset 00:00Z), XP/level awards untouched until a later phase; DraftCoin stays simulated (no real money). Every item ownable exactly once — re-purchase 409 CONFLICT, catalog available = !owned.
- Catalog: GET /api/v1/shop — canonical server prices/kinds from the shipped config (lib/server/catalog.ts, 47 entries), 12-hex sha256 catalogVersion, availability derived from the caller's inventory; GET-origin policy (absent allowed). Client buy buttons stay disabled until this loads — a price is never charged from local config.
- Purchase: POST /api/v1/shop/purchases — strict Origin → session → general rate → REQUIRED Idempotency-Key (UUID) → strict {itemId, expectedVersion} body → idempotency reserve (REPLAY/MISMATCH/IN_PROGRESS resolved before execution; failures release the key so an honest same-key retry works) → ONE interactive transaction: conditional updateMany {id, version, draftCoin gte price} deduct+version bump (count 0 → rollback → re-read → STALE_VERSION/ALREADY_OWNED with authoritative riders) → inventory grant (PK P2002) → ledger row (amount −price, reason shop:purchase:<itemId>, sourceRef transactionId) → economy.purchase audit (no PII) → replayable 2xx idempotency outcome (phase §6 step 9 completed INSIDE the tx) → after commit: SSE economy.updated + profile.updated keyed by session.user.id, then 201. Insufficient funds → 409 INSUFFICIENT_FUNDS carrying currentBalance/currentVersion in details (FieldError gained currentBalance, mirroring B5's currentVersion).
- Idempotency store: DB table IdempotencyRecord with @@unique([profileId, endpoint, key]) (migration 20261010113031_b6_economy_idempotency, additive) — durable across instances, unlike the B5 process-local limiter/hub. 24 h retention; stale in_progress (crashed request) taken over after 2 min; replay body equals the stored summary as JSON deep equality (jsonb reorders keys).
- Rewards: GET /api/v1/rewards/rules (fixed config) and GET /api/v1/rewards/status (today's quest_reward sums vs cap, resetsAtUtc) — B7/B11 reward issuance reads the same tables; missing profile → zeroed safe defaults, no create-on-read. Development fixture POST /api/v1/dev/rewards (user-approved): 404 in production BEFORE any work, otherwise the same atomic issueQuestReward service with the in-tx UTC cap; capped claims return 200 {awarded:0, capped:true} with no write and no SSE.
- Client: apiClient carries the Idempotency-Key header; ShopScreen fetches a fresh GET /game/state for expectedVersion per click (profile.version is the local storage schema version, not an economy version), commits only after server confirmation, and applies authoritative currentBalance from rejections; useGameSync listens economy.updated → refetch (pointer semantics like profile.updated). Local profile.purchaseItem stays isolated (unit-tested, static-guarded out of the storefront).
- Tests: 374/374 across 30 files (+6 suites: shop catalog, purchases incl. concurrency exactly-one-wins + SSE-after-commit assertions, rewards reads, dev fixture incl. production gate, economy unit incl. forced mid-tx rollback proof, idempotency unit; +5 static client guards). Live dev smoke 26/26 + browser pass (claims, honest insufficient, purchase, refresh persistence, single canvas). Known limits: process-local hub/rate limiter (carried), 24-h replay window, prod-mode smoke deferred (gate covered by NODE_ENV test).
21. B7 implementation details (confirmed 2026-10-10)
- Queue stack: transactional outbox + DB job queue + in-process worker (B0 decision; Cloud Tasks deferred to production). Migration 20261010132336_b7_outbox_jobs, additive: OutboxEvent/Job tables + OutboxStatus/JobStatus enums, five indexes; eventType/jobType are plain registry-validated strings (unknown → terminal dead, no enum migrations later); `prisma generate` run explicitly after the schema change.
- Outbox: appended inside the SAME transaction as the domain change — me.delete writes marker + revocations + audit + `account.deletion_requested {userId}` atomically (claimed-count guard ⇒ exactly one event ever; rollback ⇒ none). Relay converts events to jobs idempotently (Job.outboxEventId unique: crash between create-then-ack re-runs, dedupes, acknowledges), never deletes events (pending/published/dead with publishedAt/lastErrorClass), transient relay failures use the same bounded backoff (max 5), invalid payload/unknown type → dead with no job.
- Claim/lease/retry: candidate scan (pending ∧ availableAt≤now, running ∧ lease expired, oldest first) + per-row conditional UPDATE with the same predicate — exactly one winner; attempts++ at claim (at-least-once; handlers must be idempotent); 60 s lease, owner-guarded complete/fail ("lost" never overwrites a takeover); backoff 1 s·2^(N−1) with ±25 % jitter, absolute cap 5 min, max 5 attempts; permanent classes (validation/unsupported_type/not_requested/config) dead immediately; clock+random injected for tests. dedupeKey unique ⇒ one row per key ever, dead jobs requeued in place via internal requeueDeadJob() (ops path; no HTTP — §207).
- Worker: root instrumentation.ts register() → dynamic import → startDevWorker(): guards NEXT_RUNTIME=nodejs, NEXT_PHASE≠phase-production-build (build/static render never starts a loop), WORKER_ENABLED=false kill-switch; globalThis singleton survives dev hot reload + idempotent start() (no stacked polling loops); immediate first tick then 2 s poll, batch 5; SIGTERM/SIGINT drain timer + in-flight tick (durability rests on lease expiry, not graceful stop). Explicit JOB_HANDLERS registry — exactly one type `account.deletion`; unknown types dead-letter without code execution.
- Deletion (B7 half): marker-only selection; payload validated before side effects; non-requested → PermanentJobError → dead with zero effect; single-tx full wipe (user, profile, sessions, auth tokens, inventory, DraftCoin ledger, idempotency records) in explicit FK order; mid-tx failure rolls back everything and the marker is never undone; `not_found` = idempotent success; AuditEvents survive — explicit userId→null tombstoning mirrors ON DELETE SET NULL, plus `auth.account_erased` evidence (userId null from the start, requestId=jobId). Erasure frees the email for immediate re-registration (live-verified). No provider code anywhere (source-scan test).
- Observability: structured redacted logs only (worker.started/tick/job.ok/job.failed/job.lease_lost, outbox.published/deferred/dead; whitelisted scalar fields; payloads never logged; errorCategory classes, never raw errors) — no ops/status endpoint (contract §207 + user decision); no public enqueue/trigger route exists.
- Tests: 444/444 across 35 files (+5 suites, +70 tests: queue, outbox, deletion, worker, instrumentation guards; +2 route outbox tests; live suite hardened for concurrent erasure and cleans its job/outbox artifacts). Live smoke 30/30 (202 → uniform 401 → relay → succeeded job attempts=1 → physical erasure → audit tombstones → email freed → controls untouched → zero dead/stuck rows); browser pass single canvas + clean console on / and /preview; DB left at the 2 pre-existing accounts with jobs/outbox at zero. Known limits: in-process single-instance worker (leases make competing instances safe but there is no coordination/presence guarantee), logs-only ops, dev-tuned poll/lease/backoff constants, one unreproduced live-test flake disclosed in B7_REPORT.md §11.

22. B8 implementation details (confirmed 2026-10-10)
- Flow (link-only; no Google sign-in � user decision recorded in B8_REPORT.md): strict Origin ? session ? `oauth` rate class (10/hour/player) ? email-verified gate (403 EMAIL_NOT_VERIFIED) ? config check (503 SERVICE_UNAVAILABLE with missing variable NAMES only) ? OAuthState minted (256-bit random, stored as sha256 hash, bound to userId+sessionId+intent connect|reconnect:<accountId>, 10 min expiry, single-use consumedAt) ? browser redirected to Google (accounts.google.com, scopes openid + email + gmail.modify, access_type=offline, prompt=consent, redirect_uri ONLY from server env) ? GET /api/v1/callbacks/googleOAuth: consume state FIRST (wrong-user/session mismatch rejected WITHOUT burning the row; unknown/expired/replayed uniform 307 ? /?googleOAuth=state) ? error param ? code presence ? config ? server-side exchange (oauth2.googleapis.com/token) ? identity (openidconnect.googleapis.com userinfo; email_verified must be true) ? link policy ? 307 redirect carrying ONLY a safe outcome token (connected|denied|state|session|nocode|provider|unverified|conflict|config|error; never code/state/tokens/email) with zero Set-Cookie (session preserved). Callback linking is SYNCHRONOUS � deviation from contract �205 "enqueues linking work" (justified in B8_REPORT.md �11; B7 registry deliberately holds only account.deletion).
- Linking policy: identity (googleSub) is globally UNIQUE � one Google identity = at most one MailXP user; link targets ONLY the currently authenticated user (no email-match sign-in/merge); existing row for same user+sub ? reconnect (refresh credentials atomically, google.reconnected); sub owned by another user ? safe conflict redirect + google.link_conflict audit, NO transfer; released row (token wiped) may be re-claimed by its owner (google.transferred audit path) � release is the transfer precondition. Provider identity is the only source of truth; browser-supplied email/sub/token fields are ignored (unit-tested).
- Credentials: AES-256-GCM (node:crypto), 32-byte key from GOOGLE_TOKEN_ENCRYPTION_KEY (base64 env), 12-byte random nonce, auth tag + keyVersion stored alongside ciphertext; fail-closed helper lib/server/secretBox.ts (missing/invalid key ? refuse, never plaintext/hard-coded/default); only the refresh token is persisted (access token discarded after exchange); seal/open/rotate-safe design, GCP KMS documented as the production swap. Release wipes cipher/nonce/tag IN PLACE (row kept, status=released); disconnect deletes the row after best-effort remote revoke (oauth2.googleapis.com/revoke; honest `revoked` flag in google.disconnected audit � never claims success unconfirmed; skip never blocks).
- Schema: migration 20261010143554_b8_google_oauth, additive (1 enum GoogleConnectionStatus connected|released; GoogleConnection + OAuthState tables; googleSub unique, stateHash unique, userId/expiresAt indexes; both FKs ON DELETE CASCADE). Account erasure (deletion.ts) now deletes OAuthState + GoogleConnection rows in FK order and calls revokeStoredGoogleCredentials() before the wipe (fail-closed, never blocks erasure). No purge job for expired/consumed states (spec requires none; erasure clears them).
- API: contract �7.1 set � GET /integrations/google (status), POST /start, GET /callbacks/googleOAuth, GET /integrations/google/accounts, GET|DELETE .../accounts/{accountId}, POST .../reconnect, POST .../release; error codes added: EMAIL_NOT_VERIFIED (403), SERVICE_UNAVAILABLE (503); audit types google.{connected,reconnected,transferred,disconnected,released,link_conflict}; no Gmail/Calendar endpoints, no jobs/outbox events, no SSE events (status refetch on mount/notice).
- Frontend: Settings card (Google connection) � states: unverified gate, unconfigured (variable names), connect ? full-page navigation to Google, one-time ?googleOAuth=<outcome> notice read + URL scrub, connected row (email, status, scopes) + Disconnect + Connect another; apiClient gained fetchGoogleStatus/startGoogleConnect/disconnectGoogleAccount; DTOs GoogleAccountDto/GoogleStatusDto/GoogleStartDto in game/backend/contract.ts. Phaser untouched (single canvas preserved); game loop never awaits network.
- Tests: 537/537 across 39 files (+4 suites: secretBox, googleOAuth domain, google routes, callback + deletion B8 block: 93 new tests total). Live smoke 44/44 incl. REAL Google token-endpoint rejection of an invalid code; REAL consent completed with user in the loop (link created, refresh token sealed, UI verified); browser pass / and /preview single canvas + 0 console errors. Known limits: in-process rate limiter, sync callback (documented deviation), consumed/expired state rows linger until erasure, real remote revocation of a VALID token not exercised (would sever the live user link � unit-stubbed), prod-mode smoke not re-run since B5.

23. B8a implementation details — Google sign-in (confirmed 2026-10-10)
- Entrance: AuthPanel’s “Continue with Google” uses the existing OAuth authorization-code integration with `intent=signin`; Google-hosted account selection/authentication means MailXP never receives the Google password. One consent requests `openid email gmail.modify`; only identity and connection are established here—Gmail data access remains B9.
- State: schema migration `20261010163847_b8a_google_signin_state` makes OAuthState.userId/sessionId nullable. Sign-in state rows are random, hash-only, 10-minute, single-use, and have both bindings NULL; link/reconnect rows remain bound to the originating user and session. Callback intent comes from the stored row, never from callback query input.
- Account resolution: an already-connected `googleSub` is authoritative; otherwise the provider-verified email can sign into the existing MailXP account; otherwise a new email-verified account + standard PlayerProfile is created with a bcrypt hash of a discarded random secret. Deletion-pending accounts are refused. Successful sign-in rotates any presented session and creates the GoogleConnection in the same transaction; audit types distinguish `auth.login_google` and `auth.register_google`.
- UI: shared `components/oauthOutcome.ts` safely displays and scrubs callback outcomes for signed-in Settings and signed-out AuthPanel. Settings’ resend-verification helper reuses existing auth endpoints; development-only token redemption is shown only when the existing endpoint returns its devDelivery payload.
- Verification: 570/570 tests across 40 files; tsc/build/prisma validate/migrate status green; live B8a smoke 22/22; real Google sign-in resolved to the existing `manikaabir6@gmail.com` account with session rotation and no duplicate; resend → dev verify → Connect button browser path passed; one Phaser canvas remained mounted. See `docs/B8_REPORT.md` §15.
- Limits: OAuth rate limiter remains process-local; sign-in states are not browser-session-bound (standard state bearer protection, hash-only and consume-once); no Gmail API call or B9 work exists. A second real browser sign-in established an additional Google connection for an existing account; it remains intact pending the user's review. See report §15.
