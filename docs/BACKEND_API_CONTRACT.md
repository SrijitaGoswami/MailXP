MailXP — Backend API Contract
Status: B1-FINALIZED for the first release (B3–B6) on 2026-10-10. Items marked OPEN carry a recommendation and a named deciding phase; everything else is binding for implementation. Deferred families (B8–B14) are inventoried here with phase markers and must be finalized in their own phase before that phase implements them.
Purpose: The single source of truth for routes, schemas, auth, errors, pagination, idempotency, concurrency, SSE, and boundaries. Implementation (B3+) must follow this document; deviations require a contract amendment recorded in a phase report.
First-release definition (user-confirmed at B1): health (B3), authentication/account (B4), profile/game state, preferences, economy ledger, shop, SSE (B5–B6). Everything Gmail/Gemini/Calendar/wallet/notifications/quests is DEFERRED.

0. How to read this document
- CONFIRMED = binding. OPEN — <phase> = decision deferred to the named phase, recommendation recorded. RECOMMENDED = proposed default awaiting security review at the named phase.
- Every route has a stable identifier (e.g. `auth.login`) used in code, tests, logs, and docs; identifiers never change even if a path is ever amended.
- "Player" = authenticated MailXP account. "Account/mailbox" = a linked Google account. All IDs are opaque, globally unique, URL-safe strings (UUIDv7 recommended — confirm at B2).

1. Contract-wide rules — CONFIRMED
1.1 Transport and versioning
- HTTPS only outside local development; JSON request/response bodies (multipart or stream only where a later phase defines it).
- All first-release paths are prefixed /api/v1 (user-confirmed at B1). Breaking changes require a new version prefix; additive changes are allowed within v1.
- Timestamps are ISO 8601 UTC strings. Never expose provider secrets, stack traces, SQL, or raw provider payloads.
- Same-origin browser client only: the frontend at the same origin calls these routes with the session cookie; CORS is not configured for third-party origins.
1.2 Authentication and session transport — CONFIRMED (B0) + finalized (B1)
- Cookie `mailxp.session`: httpOnly, Secure in production, SameSite=Lax, path=/.
- Session lifetime: 30 days, sliding renewal on activity, absolute server-side revocation; a fresh session id is issued (old revoked) on login and on password reset (reset revokes ALL of the player's sessions).
- CSRF strategy: SameSite=Lax plus mandatory Origin-header equality check on every cookie-authenticated mutation (403 CSRF_ORIGIN_REJECTED on mismatch). A double-submit token is added only if B4 proves origin checks insufficient on some supported browser.
- Unauthenticated or expired session on a protected route → 401 with distinct codes UNAUTHENTICATED vs SESSION_EXPIRED (UI uses the latter to prompt silent re-login).
- Player identity is taken ONLY from the server-side session. A player id in any body/query/path is never authoritative; if a path contains a player-scoped id, ownership is resolved against the session.
- Email verification is required before Google connection (B8+), Calendar, and wallet features — NOT before gameplay (user-confirmed at B1: play now, verify later).
1.3 Authorization and ownership — CONFIRMED
- Every read and mutation resolves ownership server-side, scoped to the authenticated player and their linked mailboxes.
- Information-disclosure policy: accessing a resource owned by another player returns 404 NOT_FOUND (existence is not disclosed). 403 is reserved for conditions the player may know about (e.g. EMAIL_NOT_VERIFIED, mailbox paused, CSRF origin mismatch).
- One mailbox's auth failure must never block other linked mailboxes or the player's non-mailbox features.
- Google refresh tokens and provider credentials are never returned by any route.
1.4 Error envelope — CONFIRMED
All non-2xx responses use exactly:
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Safe user-facing summary",
    "requestId": "correlation-id",
    "details": []            // optional; validation field errors only — never secrets, tokens, hashes, provider payloads, or SQL
  }
}
Status mapping — one convention (400 covers ALL validation; 422 is not used):
| Status | Code | When |
| 400 | VALIDATION_ERROR | Malformed JSON, schema violation, invalid cursor, bad query params |
| 401 | UNAUTHENTICATED | No session on a protected route |
| 401 | SESSION_EXPIRED | Session existed but expired/revoked |
| 401 | INVALID_CREDENTIALS | Wrong email/password (never says which) |
| 403 | CSRF_ORIGIN_REJECTED | Mutation Origin check failed |
| 403 | EMAIL_NOT_VERIFIED | Verified email required for this operation |
| 404 | NOT_FOUND | Missing OR another player's resource (indistinguishable) |
| 409 | CONFLICT | Duplicate state transition / already-taken action |
| 409 | STALE_VERSION | Optimistic-concurrency precondition failed |
| 409 | IDEMPOTENCY_MISMATCH | Same key, different request fingerprint |
| 409 | IDEMPOTENCY_IN_PROGRESS | Same key, first request still executing |
| 409 | EMAIL_EXISTS | Register target already registered |
| 422 | — | NOT USED (validation is 400) |
| 429 | RATE_LIMITED | Rate/quota exceeded; include Retry-After header |
| 500 | INTERNAL_ERROR | Unexpected failure; requestId correlates to server logs |
| 502 | UPSTREAM_PROVIDER_ERROR | Google/Gemini call failed or returned invalid data |
| 503 | SERVICE_UNAVAILABLE | Dependency down or maintenance; safe to retry later |
1.5 Pagination, filtering, sorting — CONFIRMED
- List endpoints accept `?limit=` (default 25, max 100) and `?cursor=` (opaque string).
- Response: { "items": [...], "nextCursor": "opaque | null" }. null = end of list.
- Ordering: createdAt DESC with id DESC tie-break (stable, documented per endpoint).
- Invalid/malformed cursor → 400 VALIDATION_ERROR. A cursor over mutated data may skip or re-surface edge items; clients dedupe by id (eventual consistency is acceptable for feeds).
- Filters are per-endpoint whitelist; unsupported combinations → 400.
1.6 Idempotency — CONFIRMED
- Mechanism: request header `Idempotency-Key` (UUID), scoped per player + endpoint; server stores key, endpoint, request fingerprint (hash of path+body), status, and response summary for 24 hours.
- Same key + same fingerprint → replay stored result (same status/body). Same key + different fingerprint → 409 IDEMPOTENCY_MISMATCH. Concurrent duplicate while first runs → 409 IDEMPOTENCY_IN_PROGRESS.
- REQUIRED on: `shop.purchase` (B6), `wallet.purchaseIntent` (B14), `gmail.actionExecute` (B11). NOT required on auth routes (registration duplicates resolve to 409 EMAIL_EXISTS; login is naturally retryable).
- An idempotency key never replaces authentication, ownership, or validation checks.
- Internal reward issuance uses DB uniqueness (player, actionType, sourceMessageId, rewardType) — not client keys — so replayed provider events cannot double-credit.
1.7 Concurrency — CONFIRMED
- Mutable player resources (game state snapshot, ledger-derived balance, drafts, approvals) carry an integer `version` (or `balanceVersion` where scoped). Mutations that depend on current state send `expectedVersion`; mismatch → 409 STALE_VERSION with current resource version.
- Approvals (B11) additionally bind a payload fingerprint; edit/regenerate changes the fingerprint and invalidates the prior approval.
1.8 Rate limits — RECOMMENDED (security review at B3/B4)
| Route class | Limit |
| auth.register | 5 / hour per IP |
| auth.login | 10 / 15 min per email+IP composite |
| auth.password.forgot, auth.resendVerification | 5 / hour per email+IP |
| general mutations | 60 / min per player |
| SSE connections | 3 concurrent per player |
Limits are enforced server-side; exceeding → 429 RATE_LIMITED + Retry-After. Values are recommendations until the B3/B4 security review signs off.
1.9 Privacy and data minimization — CONFIRMED
- Responses contain only fields the caller needs. Never returned: password hashes, session ids, reset/verification tokens, OAuth tokens, raw provider payloads, internal risk/security metadata, other players' data.
- List responses never include full email bodies (a detail endpoint governs permitted content in B9+).
- Account deletion or mailbox disconnect must never modify or delete original Gmail messages.
- Audit records (auth events, purchases, deletions, connection changes) contain no email content.

2. Authentication and account — Phase B4 (FIRST RELEASE)
Password policy — CONFIRMED (user at B1): minimum 10 characters, maximum 128, blocklist of common/breached passwords (static list, shipped server-side); no composition rules; no forced periodic rotation. Email: trimmed, lowercased, max 254.
Session record: server-side row (id hashed at rest, playerId, createdAt, lastSeenAt, expiresAt) — 30-day sliding expiry; revocable individually or all-at-once.

#### `auth.register` — POST /api/v1/auth/register
- Auth: none. Verification: n/a. CSRF: Origin check (public route).
- Request: { "email": string, "password": string }
- Success: 201 { "player": { "id", "email", "emailVerified": false, "createdAt" } } + Set-Cookie `mailxp.session` (auto-login); verification email dispatched (B4 delivery mechanism: dev-mode link logged/surfaced, documented in B4 report).
- Errors: 400 VALIDATION_ERROR · 409 EMAIL_EXISTS (explicit so the user can switch to login; enumeration trade-off accepted and documented) · 429 RATE_LIMITED.
- Idempotency: n/a. Side effects: player + session + audit `auth.register`. Rate: §1.8.

#### `auth.login` — POST /api/v1/auth/login
- Auth: none.
- Request: { "email": string, "password": string }
- Success: 200 { "player": { "id", "email", "emailVerified", "createdAt" } } + new session cookie (old session for that login revoked/rotated).
- Errors: 401 INVALID_CREDENTIALS (uniform for unknown email and wrong password) · 429 RATE_LIMITED.
- Side effects: session create, audit `auth.login` (+ `auth.login_failed` without distinguishing cause).

#### `auth.logout` — POST /api/v1/auth/logout
- Auth: session. Success: 204, server revokes the presented session; cookie cleared. Errors: 401 UNAUTHENTICATED (idempotent-tolerant: logout of an already-dead session still returns 204).
- Side effects: audit `auth.logout`.

#### `auth.verifyEmail` — POST /api/v1/auth/verify-email
- Auth: none (token-borne). Request: { "token": string }
- Token lifecycle — CONFIRMED (user at B1): single-use, 24-hour expiry, stored hashed.
- Success: 200 { "player": { "emailVerified": true } } (also marks email verified if the player is logged in; otherwise prompts login). Errors: 400 VALIDATION_ERROR (missing token) · 404 NOT_FOUND (unknown/used token) · 409 CONFLICT (already verified).
- Side effects: player.emailVerified=true, verification tokens invalidated, audit `auth.email_verified`.

#### `auth.resendVerification` — POST /api/v1/auth/resend-verification
- Auth: optional session; body { "email": string } when unauthenticated.
- Success: 202 ACCEPTED {} — always, whether or not the account exists (no enumeration). Rate-limited; a new token supersedes prior outstanding ones.
- Side effects: email dispatch (when applicable), audit `auth.verification_resent`.

#### `auth.passwordForgot` — POST /api/v1/auth/password/forgot
- Auth: none. Request: { "email": string }. Success: 202 ACCEPTED {} — always (no enumeration).
- Errors: 429 RATE_LIMITED only. Side effects: reset token issue (single-use, 1-hour expiry — CONFIRMED user at B1, hashed at rest) + audit `auth.reset_requested`.

#### `auth.passwordReset` — POST /api/v1/auth/password/reset
- Auth: token-borne. Request: { "token": string, "password": string }
- Success: 200 {}; resets password (policy §2), consumes token, revokes ALL sessions for the player; audit `auth.password_reset`.
- Errors: 400 VALIDATION_ERROR (weak/invalid) · 404 NOT_FOUND (unknown/used/expired token).

#### `me.get` — GET /api/v1/me
- Auth: session. Success: 200 { "player": { "id", "email", "emailVerified", "createdAt" } }. Errors: 401.

#### `me.delete` — DELETE /api/v1/me
- Auth: session. Request: { "password": string } (re-authenticate for a destructive action).
- Success: 202 ACCEPTED {} — deletion is async-controlled: login disabled immediately, integrations revoked, personal data deleted per retention policy, only legally/financially required records retained; Gmail messages are never touched.
- Errors: 401 INVALID_CREDENTIALS · 429. Side effects: audit `auth.deletion_requested` (retained as a non-personal tombstone).

3. Profile, game state, and preferences — Phase B5 (FIRST RELEASE)
Server is authoritative for draftCoin, xp, level, stats, inventory, outfit, decorations, preferences, and reward history. The client never submits a balance, reward amount, level, price, or ownership claim. localStorage remains a responsiveness cache only; server responses win on conflict (rollback path: rejection returns current authoritative state so the client can resync).
Field note: the shape of persisted stats (xp/level/mailCount — currently ephemeral in the frontend) is a B2 data-model decision; the fields below assume they become part of the authoritative snapshot.

#### `game.state` — GET /api/v1/game/state
- Auth: session. Success: 200 {
    "playerId", "draftCoin": int ≥0, "xp": int, "level": int,
    "stats": { "mailCount": int },            // B2 confirms final stat set
    "ownedItems": [ { "itemId", "ownedSince" } ],
    "equippedOutfit": string|null,
    "placedDecor": [ { "itemId", "x": int, "y": int } ],
    "preferences": { "soundEnabled": bool, ... },   // whitelist, B2 confirms set
    "rewardHistory" is NOT inlined — use ledger;
    "version": int
  }
- Errors: 401. Emitted also as SSE `profile.updated` (§5) after any server-side change.

#### `game.preferencesUpdate` — PATCH /api/v1/game/preferences
- Auth: session. Request: { "preferences": { whitelisted keys only }, "expectedVersion": int }
- Success: 200 { "preferences": {...}, "version": int }. Errors: 400 (unknown key rejected) · 409 STALE_VERSION · 401.
- Side effects: audit only on security-relevant prefs; not per-tick spam.

#### `game.ledger` — GET /api/v1/game/ledger?limit=&cursor=
- Auth: session. Cursor list (§1.5), newest first. Item: { "id", "type": "quest_reward"|"purchase"|"adjustment", "amount": int (signed), "reason": string, "sourceRef": string|null, "createdAt" }.
- No internal risk/security metadata. Errors: 400 · 401.

4. Economy and shop — Phase B6 (FIRST RELEASE)
All reward amounts, prices, and the daily cap are server-side configuration (values set at B6, not client-trusted). Rewards are issued ONLY by internal verification of provider-verified actions (B11 evidence; until then development-only fixtures per B6 scope). Receiving/opening mail never earns. Daily cap: UTC reset at 00:00; actions may succeed past the cap but earn no further DraftCoin that day. Balance and ledger rows mutate in one transaction; balance can never go negative.

#### `shop.catalog` — GET /api/v1/shop
- Auth: session. Success: 200 { "items": [ { "itemId", "name", "price", "kind": "outfit"|"decor", "available": bool } ], "catalogVersion": string }. Prices are server truth.

#### `shop.purchase` — POST /api/v1/shop/purchases
- Auth: session. Headers: `Idempotency-Key` (required, §1.6). Request: { "itemId": string, "expectedVersion": int }
- Success: 201 { "transactionId", "itemId", "balance", "version" } — deduction + inventory grant atomic in one transaction.
- Errors: 404 NOT_FOUND (unknown item, or another player's catalog scoping) · 409 CONFLICT (already owned, where applicable) · 409 STALE_VERSION · 409 IDEMPOTENCY_MISMATCH / IDEMPOTENCY_IN_PROGRESS · 429 · 400.
- Rejection MUST include current authoritative state (balance/version) so the optimistic client UI can roll back — frontend contract note for B5 wiring.
- Side effects: ledger row (type purchase), inventory grant, SSE `economy.updated` + `profile.updated`, audit `economy.purchase`.

5. Realtime (SSE) — Phase B5 (FIRST RELEASE) — CONFIRMED mechanism (B0), shapes finalized here
#### `events.stream` — GET /api/v1/events
- Transport: text/event-stream, cookie-authenticated (401 if absent/expired), player-scoped server-side from the session — a client-supplied id never selects the scope. Origin-checked like mutations. Same-origin only.
- First-release event names (payloads are minimal pointers; clients refetch via REST — no email bodies, tokens, or full objects in events):
  - `profile.updated` → data: { "version": int }
  - `economy.updated` → data: { "balance": int, "reason": "quest_reward"|"purchase"|"adjustment", "version": int }
  - `ping` → heartbeat comment/interval ~25 s (keeps proxies alive; server closes idle streams at a documented interval)
  - `retry: 5000` directive on connect.
- Reconnect/self-heal: the stream carries no replay log in the first release; on every (re)connect the client refetches GET game/state (and ledger if open) so missed updates self-heal. Last-Event-ID replay is deferred (finalize at B12 if needed).
- Fallback — RECOMMENDED: after 3 consecutive stream failures, the client polls game/state every 30 s until a stream succeeds; poll cadence reviewed at B5.
- Invariants: SSE introduces NO second event bus — events are consumed in the React layer and flow to the game only through game/bridge.ts / profile subscribers; the Phaser canvas never remounts because of transport state.

6. Health — Phase B3 (FIRST RELEASE)
#### `health.check` — GET /api/v1/health
- Auth: none. Success: 200 { "status": "ok", "db": "ok", "version": "<app version>" }. No environment/dependency detail beyond db reachability. Errors: 503 SERVICE_UNAVAILABLE when the DB probe fails.

7. Deferred route families (INVENTORIED — finalize at the named phase before implementing)
These paths are provisional under /api/v1 and inherit every contract-wide rule above; their full schemas are finalized in their phase's contract amendment. None is part of the first release.

7.1 Google connection — B8: `google.status` GET /api/v1/integrations/google · `google.connectStart` POST .../google/start · `google.connectCallback` GET .../google/callback (provider callback — §8) · `google.accountsList` GET .../google/accounts · `google.accountGet` GET .../accounts/{accountId} · `google.accountReconnect` POST .../accounts/{accountId}/reconnect · `google.accountDisconnect` DELETE .../accounts/{accountId} · `google.accountRelease` POST .../accounts/{accountId}/release. Rules inherited now: verified email required; email verification precedes connection; tokens encrypted server-side, never returned; one Gmail mailbox = one active player; disconnect pauses only that mailbox and never deletes Gmail messages.
  B8 amendment (EXECUTED 2026-10-10, report docs/B8_REPORT.md) — final schemas:
  - Callback canonical path is §8's `GET /api/v1/callbacks/googleOAuth` (the `.../google/callback` shorthand above is superseded); redirect-outcomes only: 307 → `/?googleOAuth=` + one of connected|denied|state|session|nocode|provider|unverified|conflict|config|error — never code/state/tokens/email, never Set-Cookie.
  - `google.status` 200 `{ configured: boolean, missing: string[] /* variable NAMES only */, emailVerified: boolean, accounts: GoogleAccountDto[] }` with `GoogleAccountDto = { id, email, scopes: string[], status: "connected"|"released", connectedAt }` (no token material ever). `google.connectStart` 200 `{ authUrl }`; body may carry `{ accountId }` for reconnect (ignored identity fields cannot link).
  - Errors: 401 UNAUTHENTICATED/SESSION_EXPIRED (no session), 403 CSRF_ORIGIN_REJECTED (origin enforced before every mutation), 403 EMAIL_NOT_VERIFIED, 400 VALIDATION_ERROR (malformed body), 404 NOT_FOUND (foreign/absent account — never 403, existence not disclosed), 429 RATE_LIMITED (new dedicated rate class `oauth` = 10/hour/player on start+reconnect; `general` also keyed per player on these routes), 503 SERVICE_UNAVAILABLE (config missing; `details.missing` = variable names). Disconnect success = 204; release/reconnect = 200 with the account DTO.
   - Deviation (documented): the callback performs linking SYNCHRONOUSLY (validate state → exchange → link → redirect) instead of §205's "enqueues linking work" — no job/outbox type was added (justification in report §11); §8's enqueue pattern still applies to `callbacks.gmailPush` (B9). `google.connectCallback` never mutates without a valid, session-bound, unconsumed state.
   - B8a amendment (EXECUTED 2026-10-10, `docs/B8_REPORT.md` §15; spec `docs/phase_b8a.md`): `POST /api/v1/integrations/google/start` accepts `{ intent?: "link" | "signin", accountId?: string }`; absent intent remains B8 link behavior. `signin` is public (no session/verified-email gate), strict-Origin checked, and `oauth` rate-limited 10/hour per client IP. It mints a 10-minute hash-only `OAuthState` with nullable `userId`/`sessionId` both NULL; link/reconnect states remain user+session-bound. Callback branches only on the stored intent, consumes state before exchange, requires provider-verified email, and on success locate-or-creates by connected `googleSub` first then verified email. Email match signs into the existing MailXP account; otherwise create a verified account with the standard profile and an unknowable random password hash. Successful callback rotates any presented session, establishes the Google connection, audits `auth.login_google` or `auth.register_google` plus the connection lifecycle event, sets a fresh session cookie, and redirects with safe token `signin`. A deletion-pending match redirects with `account`; all other callback tokens remain in the closed safe set. The same consent requests `openid email gmail.modify`; it does not fetch Gmail (B9).
   - B8a UI: AuthPanel offers “Continue with Google”; the shared outcome reader handles signed-in and signed-out notices and scrubs the query parameter. Settings offers resend verification, plus dev-only token redemption. Existing email/password registration and login remain available. The existing `/auth/resend-verification` and `/auth/verify-email` endpoint contracts are unchanged.
7.2 Gmail data/sync — B9: messages list/detail, priority, sync-status, manual sync trigger, settings. Historical import limited to 7/30/90 days or all; reads never mutate Gmail; attachment content not persisted by default.
7.3 Gemini analysis — B10: ai.settings get/patch, ai.pause/resume, analysis request/get, ai.jobs, ai.usage. Rules inherited now: global pause blocks background and player-triggered analysis; in-flight workflows finish; new jobs oldest-first; one usage unit = one unique email's complete analysis+draft workflow, counted only on success (retry adds none); daily per-player limit, 00:00 UTC reset; structured model output schema-validated; email content is untrusted input.
7.4 Recommendations/approvals/actions — B11: recommendations list/get, draft regenerate/patch, approve, action execute/status. Rules inherited now: individual approval only (no batches); approval binds exact action + payload + source-message version fingerprint; edit/regenerate invalidates approval; draft creation and sending are separate approvals; execution revalidates owner/auth/version/approval/payload immediately before running; uncertain provider results are reconciled, never blindly retried; provider success is verified BEFORE any reward; `Idempotency-Key` required on execute.
7.5 Rewards (player reads only) — B6 surface, B11 evidence: `rewards.rules` GET, `rewards.history` GET (this is game.ledger — merged, no duplicate route), `rewards.status` GET (today's cap progress). Issuance has NO player-facing route — internal verification only.
7.6 Notifications/quests — B12: notifications list/read/dismiss/clear-read; quests list/get/patch. Rules inherited now: clear-read never deletes underlying data; checking a quest box alone never issues a reward.
7.7 Calendar — B12: events list/create/patch/delete; mutations individually player-approved; read and write scopes separated where feasible.
7.8 Wallet/ALGO — B14: wallet connect/disconnect, purchase intent/status. Rules inherited now: connection ≠ payment proof; explicit user-approved transaction; server verifies network/destination/amount/confirmation/eligibility/replay before crediting; `Idempotency-Key` required; DraftCoin and ALGO benefits strictly separate; no NFTs; exact network/transaction policy OPEN at B14.

8. Provider callbacks and internal operations — CONFIRMED boundary
- Provider callbacks live under /api/v1/callbacks/** and are NOT player sessions routes: `callbacks.googleOAuth` (GET, B8) — validates state/nonce and the initiating session binding, enqueues linking work, never returns tokens to the browser beyond the redirect; `callbacks.gmailPush` (POST, B9) — validates Google's push authenticity mechanism, treats the push as a hint to reconcile (not trusted state), deduplicates, enqueues durable work, responds fast (2xx) without inline processing.
- Callbacks never perform long-running Gemini/Gmail work inline — they validate, enqueue to the outbox/queue (B7), and return.
- Internal operations (job dispatch, reward issuance, wallet verification) are service-internal modules — NOT public routes. No endpoint exists that mints rewards or dispatches arbitrary jobs for a client.
- Any future payment/provider callback is added under /api/v1/callbacks/** with the same validate-then-enqueue pattern.

9. Open decisions (with owner)
- Prisma/ORM + migration tooling confirm — B2 (recommended: Prisma).
- Persisted stats shape (xp/level/mailCount/quest) and preference whitelist — B2, user sign-off before B5.
- ID type (UUIDv7 recommended) — B2.
- Rate-limit values (§1.8) security review; email-delivery mechanism (dev-mode surfacing) — B3/B4.
- Double-submit CSRF fallback if origin checks prove insufficient — B4.
- SSE Last-Event-ID replay and poll-fallback cadence — B5/B12.
- Deferred families (§7) schemas — finalized at B8–B14 entry, each before its implementation.
- API contract test tooling (new dependency) — B3, reported.

10. Two-chat ownership (unchanged from B0)
- This document is shared truth: the backend chat implements routes per this contract; the frontend chat consumes responses per this contract.
- Backend chat owns: game/backend/** (or lib/server/**), app/api/**, prisma/**, game/profile.ts adapter refactor (B2), shared contract types (single file, e.g. game/backend/contract.ts — frontend imports types read-only).
- Frontend chat owns: components/**, game/bridge.ts (extensions only, contract-governed), game/scenes/**, game/*.ts gameplay. No second event system; canvas never unmounts; the game loop never awaits network.
