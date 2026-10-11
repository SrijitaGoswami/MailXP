MailXP — Phase B5: Session Gate, Server-Authoritative Game State, and SSE
Prerequisites: B0–B4 complete. Boundary: B5 only; report and stop before B6.
1. Mission
Connect the existing MailXP game to the B4 authentication backend. Add a session-aware login/register gate, server-authoritative profile state, preferences persistence, contract-defined ledger reads, and cookie-authenticated player-scoped SSE. Preserve the existing Next.js + React + Phaser app; do not create a separate backend project.
2. Mandatory discovery
Before editing, read MASTER_REQUIREMENTS.md, BACKEND_PHASE_PLAN.md, BACKEND_ARCHITECTURE.md, BACKEND_API_CONTRACT.md, this phase file, and available B0–B4 reports. Inspect actual auth routes, /api/v1/me, Prisma schema, game/profile.ts, game/profileStorage.ts, game/bridge.ts, scene mounting, /, /preview, tests and scripts. Record baseline results. Treat actual code and contract as authoritative; document discrepancies. If safe behavior cannot be established without guessing, stop and ask.
3. Non-negotiable boundaries
- Work in the existing repository. Do not replace Phaser, change its version, redesign the game, or rewrite the frontend.
- The Phaser canvas/scene must mount once. Auth loading/login/logout/profile refresh must not remount or reset OfficeScene.
- React/Phaser traffic stays through game/bridge.ts; do not add a second event bus.
- No network/database/polling work in OfficeScene.update().
- Preserve /preview, public/assets/mailxp/, sound, accessibility, touch support, SSR/hydration safety and existing local profile API.
- Never trust client user IDs, balance, inventory ownership, outfit, decor, XP, level or reward claims.
- No coin awards, shop purchase mutations, or reward issuance in B5.
- No Gmail, Google OAuth, Gemini, Calendar, wallet/ALGO, quests, notifications, email provider, or deletion worker.
- Reuse B3/B4 server-only helpers, error envelope, request IDs, session validation, origin checks, logging and redaction.
- Never run prisma migrate reset, drop tables, or destructively recreate data.
4. Routes
Implement only these B1-contract routes:
1. GET /api/v1/game/state
2. PATCH /api/v1/game/preferences
3. GET /api/v1/game/ledger
4. GET /api/v1/events (SSE)
Reuse B4 GET /api/v1/me as the session identity source and leave /api/v1/health unchanged. Do not invent extra endpoints.
Before ledger work, inspect contract and schema. If the contract expects a ledger table or behavior that is explicitly deferred to B6, do not invent a schema or fake entries/balance. Implement an empty response only if the contract expressly allows it; otherwise document the dependency and stop for approval.
5. Session-aware game entry UI
- On load, check GET /api/v1/me; never infer authentication from localStorage.
- Signed-out users see accessible login/register UI using the exact B4 request/response contracts. Signed-in users load authoritative game state.
- Preserve “play now, verify later”: unverified email must not block gameplay.
- Logout uses B4 logout and updates UI without a full reload where feasible.
- Handle 401 UNAUTHENTICATED and 401 SESSION_EXPIRED deliberately; no infinite retry loops.
- Keep Phaser mounted once while auth is loading or changing; prefer surrounding UI/overlay state over conditional canvas unmounting.
- No Google sign-in in B5. Error messages must not leak account existence beyond B4’s documented register behavior.
6. Authoritative state and local profile reconciliation
B2/B4 already define PlayerProfile and InventoryItem; B4 creates profiles at registration with defaults matching game/profile.ts. Inspect actual schema/types before implementation.
GET /api/v1/game/state must:
- Derive identity only from the validated session.
- Return the contract-defined profile, DraftCoin balance, inventory, outfit, decor, preferences and version fields.
- Never use client-supplied player/profile IDs to select data.
- Exclude hashes, session/token data, audit metadata and other internal fields.
- Handle missing profile safely; do not create on read unless the contract explicitly requires it.
Current local seam: game/profileStorage.ts, key mailxp.profile.v1. Keep its public API stable. Read legacy data before changing anything; validate it defensively. Never let localStorage overwrite server-authoritative economy/inventory state. Define a deterministic merge only for fields the contract permits importing. Do not invent a profile-import endpoint. Keep a backup until any permitted reconciliation succeeds; do not delete the key first. Prevent repeated migration. If the contract is silent on guest/offline play and a choice could discard existing progress, stop and ask instead of silently removing it. Document field-by-field authority and preservation.
7. Preferences PATCH and concurrency
Accept only the B2/B4 allowlist: masterVolume, uiVolume, gameVolume, muted, motion, touchControls. Validate exact types/bounds from current types/defaults. Reject unknown fields and malformed values with 400 VALIDATION_ERROR. Require session and Origin validation before mutation. Follow the contract’s expectedVersion rule; stale writes return 409 STALE_VERSION with the contract-defined safe details. Use atomic/conditional update or transaction so concurrent writes cannot silently overwrite newer state. Increment and return the canonical server version/profile shape. Never accept balance, inventory, outfit, decor, owner ID or arbitrary profile fields here.
8. Ledger
Implement GET /api/v1/game/ledger only as specified by BACKEND_API_CONTRACT.md: session-scoped query, stable ordering and cursor pagination if specified, caller-owned entries only. No write route, no reward creation, and no client/localStorage-derived ledger entries. If the schema/contract has a phase dependency, report it rather than faking completion.
9. SSE and client reconnection
- Validate the B4 cookie session before opening GET /api/v1/events; scope the stream to that player.
- Follow B1 event contract: profile.updated, economy.updated where applicable, and heartbeat around every 25 seconds. Never include private email content or secrets.
- No durable replay log in B5. On reconnect, refetch authoritative state as the contract specifies.
- Clean timers/listeners on stream cancellation/disconnect. Enforce the B1 max of three concurrent streams per player as safely as possible and document process-local limits; do not claim cross-instance guarantees.
- Emit updates only after database commit. If no B5 mutation emits an event, test auth/heartbeat/cleanup and identify which later phase will emit state-change events.
- Client reconnect uses bounded backoff and cleanup; reconnect triggers authoritative refetch. Add bounded polling fallback only if required by the architecture, outside Phaser’s update loop.
- Reuse an existing event mechanism if present; do not introduce a competing bus.
10. Security and reliability
All game endpoints require a valid session; mutations validate Origin before work. Use B1 rate limits where appropriate and disclose that B4’s in-memory limiter is process-local. SSE cannot subscribe to another player. Use transactions/conditional writes. Keep DB/network work outside per-frame code. Do not log cookies, tokens, raw email or secrets. Preserve the server-only boundary.
11. Tests and sequential checks
Add tests following existing Vitest conventions; distinguish mocks from live database tests honestly. Cover:
- Unauthenticated requests and player A/B isolation.
- State response shape, profile defaults, inventory mapping and secret exclusion.
- Preference allowlist, types/bounds, Origin rejection, successful update, stale version and concurrent writes.
- Ledger pagination/isolation if supported in this phase.
- SSE auth, event shape, heartbeat, isolation, connection cap and cleanup.
- Reconnect/refetch, bounded retries, and no polling in Phaser update.
- Legacy local profile: valid/malformed data, duplicate migration, preservation, and no local economy overwrite.
- B4 register/login/logout request shapes and no Phaser remount across auth changes.
- /, /preview, /api/v1/health and all B2–B4 regressions.
Run sequentially, never concurrently:
1. npx vitest run
2. npx tsc --noEmit
3. npx next build
4. npx prisma validate
5. npx prisma migrate status
Use actual repo scripts if different. If any command fails, diagnose, fix within B5 scope, then rerun the full sequence. Never claim a check passed unless it ran successfully.
12. Out of scope
B6 shop/purchase mutations; reward issuance; Gmail/Google/Gemini/Calendar; Pera Wallet/ALGO/NFTs; production email provider; distributed rate limiting; account-erasure worker; durable SSE replay; Phaser/game redesign.
13. Required docs/B5_REPORT.md
Include:
1. Completion status and blockers.
2. Baseline/final command results and sequential order.
3. Routes and contract compliance.
4. Actual response shapes for state/preferences/ledger/SSE.
5. Auth gate and expired-session behavior.
6. Local profile migration, authority by field, backup and limitations.
7. Concurrency/versioning and tests.
8. SSE lifecycle, reconnection, refetch and connection-limit caveats.
9. Schema/migrations and additive-safety evidence.
10. Exact changed/untouched files.
11. Manual checks of /, /preview, health, login/register/logout and Phaser one-time mount.
12. Known limitations and recommended next phase.
13. Confirmation B6/provider integrations were not started.
14. Stop conditions
Stop and request approval if safe local data migration cannot be determined; ledger contract requires invented behavior or an unapproved phase dependency; a safe additive migration is impossible; core B4 auth behavior is broken and requires expanding scope; SSE isolation/cleanup cannot be made safe; Phaser mount cannot be preserved; or a core acceptance criterion cannot honestly be verified.
15. Final instruction
Implement B5 only. Produce docs/B5_REPORT.md, summarize actual successes/failures, and stop. Do not begin B6 without explicit user approval.
16. Execution record (2026-10-10)
Discovery: contract §1.4/§1.5/§1.7/§3–§5, profile.ts/profileStorage.ts, AppShell/page/GameMenu/Settings, http/session/rateLimit, register route, fakeDb, vitest config; bridge/scene stats confirmed session-local. Baseline recorded: vitest 143/143 (13 files), tsc 0, build 0, prisma valid, migrate up to date, DB zero rows.
Question round (user-approved options): (a) create the real LedgerEntry table now (additive) so ledger does honest empty cursor reads — no fake entries; (b) contract-clean local import — only the 6 preference keys imported one-time, server wins for coins/outfit/decor/inventory, raw local profile preserved under backup key; (c) strict gate — account required, no guest mode; (d) login/register on the existing title overlay, logout + account info in Settings.
Implementation: migration 20261010084635_b5_game_state_ledger (3 defaulted columns, LedgerType, LedgerEntry + FK cascade + pagination index); server helpers preferences/gameState/sseHub; routes game/state, game/preferences, game/ledger, events (SSE); STALE_VERSION + originConflicts in http.ts; client contract/apiClient/authStore/gameSync/useGameSync/AuthPanel + AppShell gate wiring + Settings Account; fakeDb extended for tests; 11 new test files.
Verification (sequential): vitest 297/297 (24 files), tsc 0, build 0, prisma validate + migrate status clean. Live: dev smoke 41/41, prod (`next start`) smoke 41/41, browser manual pass (§11 of report) incl. tag-based canvas no-remount proof and the PATCH→SSE→refetch round trip; DB cleanup to zero rows after every live run.
Live findings fixed inside scope: (1) browsers omit Origin on same-origin EventSource GETs — strict gate 403'd the app's own stream → originConflicts (absent allowed, present must match) on the stream route only, mutations stay strict; (2) signing out from inside Settings left the game menu dialog over the gate → strict-gate effect now closes the menu; (3) a one-time Fast Refresh deps-size warning during edit (2)→(3) deps — dev-HMR artifact only, fresh renders clean.
Interpretations: STALE_VERSION details carry currentVersion; ping as a named event; server closes streams at 30 min (client auto-reconnects); ledger 400s on unknown params; empty patch 400; missing profile no-create-on-read/404; no prefs audits; login/register UI only. End state: report docs/B5_REPORT.md produced; stopped before B6 awaiting approval.
