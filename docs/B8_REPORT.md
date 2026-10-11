# B8 Report — Google OAuth and Account Linking

Phase: B8 (spec `docs/phase_b8.md`) · Date: 2026-10-10 · Status: **COMPLETE — stopping for explicit approval before B9.**

## 1. Completion status, blockers, deferred items

Complete: Google OAuth authorization-code linking is implemented, tested, and documented — server-side code exchange, hash-only single-use state, verified-identity conflict handling, AES-256-GCM credential storage, status/start/accounts/get/disconnect/reconnect/release routes, the `callbacks/googleOAuth` provider callback, a Settings card UI, FK-safe deletion cleanup, and audits for every connection lifecycle event. **No blockers; no stop condition (phase §14) triggered** — the five upfront question-round decisions (Gmail scope, encryption, link-only policy, UI placement, start timing) resolved all policy ambiguity before implementation.

**Real Google consent was exercised end-to-end** (user-approved and user-completed in the visible browser; details §11/§14) — this is not a mock-only claim.

Deferred (per spec/decisions, not gaps): Gmail sync/labels/push (B9), Gemini analysis (B10), send/draft actions (B11), Calendar (B12), GCP KMS (production swap for the env-key design), expired/consumed OAuth-state purge (spec requires none; erasure clears them). Google sign-in was added later in the approved B8a addendum (§15), superseding the original link-only B8 decision for the sign-in entrance.

## 2. Baseline and final sequential command results

Baseline (before any B8 edit): `vitest run` 444/444 (35 files) · `tsc --noEmit` 0 · `build` 0 · `prisma validate` valid · `migrate status` up to date (5 migrations).

Final (2026-10-10, run sequentially in phase §12 order on the unchanged final state, rerun in full after the last test additions):

| # | Command | Result |
|---|---|---|
| 1 | `npx vitest run` | **537/537 passed, 39 files** |
| 2 | `npx tsc --noEmit` | **exit 0** |
| 3 | `npm run build` | **exit 0** (all 7 new routes in the manifest) |
| 4 | `npx prisma validate` | **valid** |
| 5 | `npx prisma migrate status` | **up to date** (6 migrations) |
| 6 | live smoke (`b8_smoke.mjs`) | **44/44 passed** (real PostgreSQL + running dev server + real Google token endpoint) |
| 7 | browser pass | `/` and `/preview`: **exactly one canvas, 0 console errors** |

Post-run DB state: the 2 pre-existing accounts only (§12), `googleConnections`: 1 (the real link, §11), `oauthStates`: 1 (the consumed real state, §11), `jobs`: 0, `outbox`: 0 — all smoke-created rows removed by the script. Intermediate command failures occurred during iteration (all disclosed in §11); after fixes the full sequence was rerun to completion.

## 3. Google connection schema and migration

Migration **`20261010143554_b8_google_oauth`** — created with `--create-only`, SQL reviewed before applying, purely additive: one `CREATE TYPE` (`GoogleConnectionStatus`: connected|released), two `CREATE TABLE`, five indexes (two of them UNIQUE), two foreign keys. No `ALTER`/`DROP`/`DELETE` on any existing object; all B0–B7 tables byte-identical. `npx prisma generate` was run explicitly after the schema change (B6 stale-client lesson) before any code touched the models.

- **GoogleConnection**: `id`, `userId` (FK → User, ON DELETE CASCADE), `googleSub`, `email`, `status` (default connected), `scopes` (as actually granted), `refreshTokenCipher?`, `refreshTokenNonce?`, `refreshTokenTag?`, `refreshTokenKeyVersion` (default 1), `connectedAt`, `updatedAt`; **UNIQUE `googleSub`** — one Google identity can never be linked to two MailXP users (spec §7 requirement); index on `userId`.
- **OAuthState**: `id`, `stateHash` (**UNIQUE** — only the sha256 of the raw state ever touches the DB), `userId` (FK, CASCADE), `sessionId`, `intent` (`connect` | `reconnect:<accountId>`), `consumedAt?`, `expiresAt`, `createdAt`; indexes on `userId` and `expiresAt`.

Account erasure (B7 pipeline) was extended: `deletion.ts` deletes `OAuthState` then `GoogleConnection` rows for the user in explicit FK order inside the same transaction, and calls best-effort `revokeStoredGoogleCredentials()` **before** erasure (never blocking it). Both FKs cascade as defense-in-depth, but erasure never relies on cascade (B7 convention preserved).

## 4. Implemented OAuth flow and account-link policy

**Flow** (link-only; strict Origin → session → `oauth` rate → verified-email gate → config check happen in that order on start/reconnect):

1. `POST /api/v1/integrations/google/start` mints a 256-bit random state, stores only its sha256, binds it to `userId + sessionId + intent`, 10-minute expiry, and returns `{ authUrl }` — Google authorization URL built **server-side** from env config (client id, redirect URI, scopes, `access_type=offline`, `prompt=consent`); the browser can never supply a redirect URI.
2. Google redirects to `GET /api/v1/callbacks/googleOAuth`. The callback **consumes state first, before any code exchange**: wrong user or wrong session → `session`/`state` redirect **without burning the victim's state**; unknown/expired/replayed → uniform `state` (no oracle distinguishing them). Provider `error=access_denied` → `denied`; missing code → `nocode`; config gone → `config` — each consumes the state, never touches Google or the DB link.
3. Valid state + code → server-side exchange at `oauth2.googleapis.com/token` → identity from `openidconnect.googleapis.com/v1/userinfo`; **`email_verified` must be true** or → `unverified` with nothing stored. Identity comes only from this trusted response — browser-supplied `email`/`sub`/token fields are ignored (unit-tested).
4. Link policy: the target is **only the currently authenticated MailXP user** (no sign-in/merge on email match). Same user + same sub again → reconnect (credentials refreshed atomically, `google.reconnected`). Sub already owned by another user → safe `conflict` redirect + `google.link_conflict` audit, **no transfer ever**. A `released` row (token wiped) may be re-claimed by its owner → `google.transferred`.
5. Success → row persisted (refresh token sealed), `google.connected` audit (accountId only), `307 → /?googleOAuth=connected`. Every outcome redirect carries **only** a safe token (connected|denied|state|session|nocode|provider|unverified|conflict|config|error) — never code/state/tokens/email — and sets **no cookie** (the MailXP session survives all failures; live-verified).

**Disconnect** = best-effort remote revoke (`oauth2.googleapis.com/revoke`, only if ciphertext is openable) → always delete the local row → `google.disconnected` audit with an honest `revoked: true|false` flag (provider-confirmed only; skip is silent and never blocks). **Release** = status `released` + sealed token columns wiped **in place** (row kept as the transfer precondition) + `google.released`. Cross-account GET/DELETE/release/reconnect are all **404, never 403** (existence not disclosed).

## 5. Requested scopes and why each is needed

Exactly three (as approved in the question round; actual granted scopes are stored from the token response, not assumed):

- **`openid`** — OIDC authentication to obtain the immutable provider subject (`sub`), the durable link key.
- **`email`** — the Google account's identity address + verified flag for display and for the verified-email policy (§4.6).
- **`gmail.modify`** — the approved least-privilege mailbox scope for the planned workflow (B9 quest mail reading, later labels/drafts/management without deleting mail).

No Calendar scopes (explicitly out of B8). No broad scope "for future convenience" — unit test asserts the exact set and that nothing contains `calendar`. Live consent granted all three (recorded `scopes` column shows the granted strings).

## 6. Credential encryption design and environment variable names

- **AES-256-GCM** via `node:crypto` in `lib/server/secretBox.ts` (server-only): 12-byte random nonce per seal, ciphertext + nonce + auth tag + **keyVersion** stored, `crypto.timingSafeEqual`-style authenticated open; wrong key/tampered ciphertext throws (fail closed, tested).
- Key: **`GOOGLE_TOKEN_ENCRYPTION_KEY`** — base64 32-byte key from env. Companion names: **`GOOGLE_CLIENT_ID`**, **`GOOGLE_CLIENT_SECRET`**, **`GOOGLE_REDIRECT_URI`** (all four added to `.env.example` as names/descriptions only; the user's `.env` was never opened for values — presence checked as SET/MISSING booleans only).
- Fail-closed guarantees: missing/invalid key → no seal, no open, never plaintext, never a hard-coded/dev default key, never reversible obfuscation (tests delete the env var and assert refusal). Tests inject an in-memory test key; no key is committed anywhere.
- Only **refresh tokens** are persisted (the access token is used and discarded after exchange; consent without a refresh token stores `null`, never a fabricated one). Production swap to **GCP KMS** is documented as the drop-in replacement (keyVersion column already supports rotation).

## 7. API surface, rate classes, and audit events

Seven routes per contract §7.1 (amended in-place with final schemas): `google.status` GET, `google.connectStart` POST, `google.connectCallback` GET `/api/v1/callbacks/googleOAuth` (§8 path convention), `google.accountsList` GET, `google.accountGet` GET, `google.accountDisconnect` DELETE, `google.accountReconnect` POST, `google.accountRelease` POST. Error codes added to the shared envelope: `EMAIL_NOT_VERIFIED` (403), `SERVICE_UNAVAILABLE` (503, missing variable **names** only). New dedicated rate class **`oauth` = 10/hour/player** on start/reconnect; `general` is keyed per player on these routes.

Audit events added (`GOOGLE_AUDIT_EVENTS`): `google.connected`, `google.reconnected`, `google.transferred`, `google.disconnected`, `google.released`, `google.link_conflict` — metadata carries ids/flags only (accountId, honest `revoked` boolean), never tokens, state, codes, or raw provider payloads. **No** job types, outbox events, SSE events, or public enqueue/trigger endpoints were added (registry deliberately holds only `account.deletion`).

## 8. Frontend and Phaser preservation

- **UI affordance** (approved): Settings gained a "Google connection" card — states: unverified-email gate, unconfigured (variable names), consent button (full-page navigation to Google, never an iframe/popup), one-time `?googleOAuth=<outcome>` notice + URL scrub, connected row (email/status/scopes) + Disconnect + "Connect another Google account". `apiClient` gained `fetchGoogleStatus` / `startGoogleConnect` / `disconnectGoogleAccount`; DTOs in `game/backend/contract.ts`.
- **Preserved**: Phaser canvas mounts exactly once and never remounts through the OAuth round-trip (live-verified before/during/after); `game/bridge.ts` untouched — React↔Phaser still flows only through it; `OfficeScene.update()` and the game loop never await network (the card is a React-side fetch, same pattern as B5–B7 panels); `/`, `/preview`, and all routes intact; `public/assets/mailxp/` untouched; sound/touch/a11y patterns unchanged; ordinary gameplay is never gated on Google connection or email verification ("play now, verify later" intact — the gate blocks only the Connect button).

## 9. Security / redaction review

- State: 256-bit random, sha256-only storage, unique-hashed, 10-min expiry, single-use (`consumedAt`), bound to user **and** session; validated **before** any exchange; wrong-user attempts cannot burn the victim's state (test proves it stays usable).
- Redirects/logs/audits/JSON carry no provider material: Location headers asserted token-free (live + unit), `oauth.callback` log lines pass only `outcome` + requestId through the redacting logger, DTOs asserted to contain only `{id, email, scopes, status, connectedAt}`.
- Browser cannot inject identity: start-body `googleSub/email/refreshToken` and callback-query `email/sub` are ignored (tests); exchange and userinfo run only server-side with env-held client secret.
- Origin/CSRF enforced before every mutation; ownership answered with 404; `oauth`/`general` rate classes capped live (429 + `Retry-After` observed); session cookie never set/cleared by the callback (live-verified); unverified Google email rejected before any write; crypto fails closed; erasure leaves zero credential/state rows (tested).
- Out-of-scope impossibility (source scans, comments stripped): no `gmail/v1`, `users.messages/threads/labels/drafts`, `messages/send`, `drafts.*`, `calendar/v3` anywhere in B8 modules; the only outbound hosts are `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com` (+ the scope strings on `www.googleapis.com`); route handlers never call `fetch` directly — all network flows through the audited lib. No send/draft/archive/label code exists. `.env` values were never read, printed, or logged.

## 10. Exact changed / untouched files

**Created**: `prisma/migrations/20261010143554_b8_google_oauth/migration.sql` · `lib/server/secretBox.ts` · `lib/server/googleOAuth.ts` · `lib/server/googleConnect.ts` · `app/api/v1/integrations/google/route.ts` · `.../google/start/route.ts` · `.../google/accounts/route.ts` · `.../google/accounts/[accountId]/route.ts` · `.../accounts/[accountId]/reconnect/route.ts` · `.../accounts/[accountId]/release/route.ts` · `app/api/v1/callbacks/googleOAuth/route.ts` · tests: `lib/server/secretBox.test.ts`, `lib/server/googleOAuth.test.ts`, `app/api/v1/integrations/google/google.test.ts`, `app/api/v1/callbacks/googleOAuth/callback.test.ts` · `docs/B8_REPORT.md`.

**Modified**: `prisma/schema.prisma` (+2 models, +1 enum, +2 User relations) · `lib/server/http.ts` (+2 error codes) · `lib/server/audit.ts` (+6 google event types) · `lib/server/rateLimit.ts` (+`oauth` class) · `lib/server/deletion.ts` (FK-safe google cleanup + pre-erasure revoke helper) · `lib/server/fakeDb.ts` (stores/handlers for the two new models) · `lib/server/deletion.test.ts` (+4: invariant re-scope + B8 cleanup) · `.env.example` (4 GOOGLE_* names) · `game/backend/contract.ts` (+3 DTOs) · `components/apiClient.ts` (+3 functions) · `components/screens/SettingsScreen.tsx` (Google card) · `docs/phase_b8.md` (execution record), `docs/BACKEND_ARCHITECTURE.md` (§22), `docs/BACKEND_PHASE_PLAN.md` (B8 EXECUTED), `docs/BACKEND_API_CONTRACT.md` (§7.1 amendment).

**Untouched**: `game/bridge.ts`, all Phaser scenes/gameplay (`game/**` except `backend/contract.ts`), `public/assets/mailxp/**`, `app/page.tsx`, `app/layout.tsx`, `next.config.ts`, `instrumentation.ts`, `vitest.config.mts`, all B0–B7 migrations, and every server module not listed above (`session`, `password`, `economy`, `http` envelope mechanics, `logger`, `catalog`, `sseHub`, `prisma`, `jobQueue`, `outbox`, `worker`, auth/shop/rewards routes). The user's `.env` was never created/edited/read for values. No pre-existing database row was deleted.

## 11. Mock vs live Google/PostgreSQL test results

**Unit/integration (mocked storage via fakeDb + injected fetch, real crypto): +93 tests — 537/537 total.**
- `secretBox.test.ts` (12): seal/open round-trip, unique nonce per seal, wrong key fails closed, tampered ciphertext/tag fails closed, missing/invalid env refuses (no plaintext fallback ever), keyVersion stored, no key material in output.
- `googleOAuth.test.ts` (33): config status with names-only diagnostics; state create/consume expiry, single-use, user+session binding, hash-only storage; auth URL (exact scopes, offline+consent, server-held redirect URI); exchange (access token used, refresh persisted, granted scopes recorded); identity verified-email enforcement (`GoogleUnverifiedEmailError`); linking policy create/reconnect/conflict/**released-transfer** (outcome `transferred`) ; token open/seal; DTO redaction (`{id,email,scopes,status,connectedAt}` only); revoke semantics (attempt/confirmed/unreachable honest flags, skip without key) + **the three §11 out-of-scope source scans** (no Gmail/Calendar endpoints, outbound-host allow-list, routes never fetch).
- `google.test.ts` (23): status auth/CSRF/scoping/no-token-fields; start 401/403 CSRF/403 `EMAIL_NOT_VERIFIED`/503 names-only/400 malformed/**browser-supplied identity fields cannot link**/state minted hash-only+bound/`oauth` 10-per-hour cap; accounts list scoping; GET/DELETE/release/reconnect ownership → 404 not 403, foreign release/delete leave state unchanged, origin rejected before mutations; disconnect 204 + audit honest `revoked`; remote revoke attempted when configured; release wipes sealed columns in place + idempotent replay.
- `callback.test.ts` (21): no/missing/unknown/**wrong-user (not consumed — victim can still use it)**/wrong-session/expired/**replay-after-success** state outcomes; `denied` (no exchange, no link), `nocode`, `config` (no Google call), `provider` (no row), **`unverified` (nothing stored)**, **`conflict` (no transfer, other user's row intact + audit)**, reconnect target gone → pre-exchange refusal; success (row + sealed refresh token + audit + clean Location + no Set-Cookie), refresh-token-absent consent stores null, reconnect intent updates in place, hash-only end-to-end, **browser-supplied `email`/`sub` query params ignored**, every failure Location carries only the safe token.
- `deletion.test.ts` (+4): google rows and OAuth states of the erased user deleted while another account's rows survive; unreadable/unconfigured credentials skipped with **zero network calls** and erasure still completing; erasure through the same job payload path; source-scan invariants (pipeline forbids provider code; `deletion.ts` may import only `@/lib/server/googleOAuth`).

**Live PostgreSQL + real Google (smoke 44/44, real dev server):** status/config flags matched env · real consent URL (scopes/offline/consent/redirect_uri == env) · state row hash-only, bound, 10-min expiry · **real Google token endpoint rejected an invalid code → `provider` redirect** (no code/state in Location, no Set-Cookie, session survived) · consume-once + replay → `state` · 401/403 CSRF/403 unverified/429 (`oauth` capped exactly at 10) · owner GET vs foreign 404 · release flipped status and wiped sealed columns · reconnect minted `intent=reconnect:<id>` bound to the owner · foreign DELETE 404 with row intact · owner DELETE 204 + honest `revoked:false` (garbage ciphertext skipped, no network) · wrong-user/no-session/nocode callback outcomes with state untouched/ consumed as designed · **full cleanup**: 2 pre-existing accounts remain, 0 connections, 0 states, 0 jobs, 0 outbox.

**Real Google consent (yes — this really happened):** with your approval the app's own dev verify flow set `emailVerifiedAt` on `manikaabir6@gmail.com`; the Settings **Connect Google** button routed through `/start` to the real `accounts.google.com` consent (`openid email gmail.modify`); you signed in and clicked Allow; the callback exchanged the code against the **real** token endpoint; the link landed in `mailxp_dev` (`googleSub` unique, granted scopes stored, **refresh token sealed** — 140-char b64 ciphertext, keyVersion 1); redirect `?googleOAuth=connected`; card shows "manikaabir6@gmail.com (connected)" + notice, URL scrubbed; state `consumedAt` stamped; `google.connected` audit written. The link was intentionally **kept** (your decision).

**Disclosed anomalies (honesty over polish):**
1. **Contract §205 deviation**: the callback links *synchronously* instead of "enqueues linking work". Justified: B7's handoff blessed sync flows (B6 pattern), no job/outbox type was invented (registry stays `account.deletion`-only), and linking is two DB writes + redirect — durability adds nothing. Recorded as an amendment in contract §7.1 rather than silently reconciled.
2. **Pre-existing row change (user-approved)**: both pre-existing accounts had `emailVerifiedAt = null` (created in B2, verification never completed). With your explicit approval I ran the app's own resend+verify flow on `manikaabir6@gmail.com` (its own endpoints, dev token delivery) to unlock real consent. `wasd.keys.test@example.com` remains untouched. No other pre-existing row changed.
3. **Live smoke script iterations (script bugs, not app bugs)** — 4 intermediate failures before the 44/44: a duplicate identifier in cleanup; Prisma 7 needing the `@prisma/adapter-pg` driver in the script; auth routes rejecting a *missing* Origin header (script now sends it); a callback fetch missing the session cookie (produced a correct `session` redirect — the app behaved right); `seal()` returning wrong field names. Every intermediate run's cleanup still ran, leaving zero rows.
4. **Browser console 429 during the pass**: `/api/v1/events` hit the documented 3-streams-per-player SSE cap because **7 stale tabs from earlier phases** still held streams for the same player. Closed them → `/` and `/preview` both 0 errors. Not B8-related (cap is B5 behavior working as designed).
5. Test-harness fixes: fakeDb has no column defaults, so B8 session seeds needed explicit `lastSeenAt` (one interim route-suite run failed 17 tests on exactly this — harness bug, not app); `exchangeCode` initially discarded the access token (caught by unit tests pre-baseline).
6. The single consumed real `OAuthState` row and the live `GoogleConnection` row remain in `mailxp_dev` by design (§1); expired/consumed states are rejected on use and cleared at account erasure — there is no purge job (spec requires none).
7. **Real remote revocation of a *valid* token was not exercised** — it would sever your live link. Revoke is unit-stubbed end-to-end and the fail-closed skip path is live-tested; disconnect on your real account whenever you want and the real revoke path will run then.

## 12. B0–B7 regression results and manual checks

537/537 across 39 files = the **444-test B0–B7 baseline with zero failures** (B2 auth/uniform-401, B4 deletion/marker, B5 SSE/CSRF, B6 economy/idempotency/concurrency, B7 outbox/worker/instrumentation guards, static mount/no-network/server-only scans) + 93 new B8 tests. All five sequential commands green on the final state; migration history intact (`migrate status`: 6/6 up to date, B0–B7 migrations byte-identical). DB: pre-existing accounts preserved (only the approved verification timestamp + the new link on `manikaabir6`); jobs/outbox at zero. Phaser lifecycle intact: single canvas on `/` and `/preview`, 0 console errors, game loop network-free, `bridge.ts` untouched — live-verified before, during, and after the OAuth round-trip (screenshots: Settings card states).

## 13. Limitations, residual risks, and B9 handoff notes

- **In-process rate limiter + process-local state** (carried): `oauth` 10/hour/player resets on server restart; fine for dev, revisit at production.
- **Sync callback** (§11.1 deviation): acceptable at current scale; if B9 ever adds heavy linking work, move it behind the outbox then.
- **State rows linger** after consume/expiry until erasure — harmless (unique hash, rejected on use) but a future purge sweep is cheap hygiene.
- **KMS**: env-key AES-GCM is the approved dev design; rotate via `GOOGLE_TOKEN_ENCRYPTION_KEY` + `keyVersion` (GCP KMS = production swap).
- **One Gmail mailbox = one active player** is enforced by unique `googleSub`; "release then re-link elsewhere" is the sanctioned transfer path.
- **For B9**: mailbox sync must read only the stored, granted scopes (never re-request broadly); push validation lives under `/api/v1/callbacks/gmailPush` per contract §8 (validate-then-enqueue — the sync-callback deviation does NOT extend there); register any new job/event types in `JOB_HANDLERS`/`OUTBOX_PLANNERS`; per-mailbox failure isolation starts from the `status` field (`connected|released`); use `openStoredRefreshToken` (fail-closed) for API auth, never log tokens; revoked connections (`revoked:false` audits) must degrade to "not connected", not retry storms; `.env` values stay unread/untabulated.
- Inherited known limitations stand: prod-mode smoke not re-run since B5; one disclosed unreproduced B7 live-test flake; single-process worker.

## 14. Provider integration confirmation

**Google OAuth is live and real** (consent + code exchange + sealed refresh token + link, this phase, with you in the loop). **Gmail data APIs, Gemini, Calendar, send/draft/label/delete actions were NOT started** — source scans enforce their absence from every B8 module (§9); no `googleapis` client library was added; outbound hosts are OAuth/identity endpoints only. No provider token, code, state, or `.env` value was ever printed, logged, or returned to the browser. DraftCoin remains simulated; no real money; `public/assets/mailxp/` untouched; the game is unchanged.

**Recommendation: B8 is complete — approve B9 (Gmail connection/sync) to proceed.**

## 15. B8a addendum — Google sign-in and verification convenience

**Status: COMPLETE — B9 remains on hold pending the user's explicit approval.** Specification: `docs/phase_b8a.md` (approved 2026-10-10 after a question round). The user chose: standard Google-hosted sign-in, one consent for identity + `gmail.modify`, and email match signs into the existing password account. MailXP never sees the Google password. The B8 Settings card also gained a resend-verification action and a development-only one-click token redemption.

### Scope delivered

- `POST /api/v1/integrations/google/start` accepts `intent:"signin"` while signed out. It retains strict Origin validation, uses the `oauth` rate class keyed by IP, and stores a 10-minute, hash-only state with NULL user/session bindings. Link/reconnect retains B8 session binding and verified-email requirements.
- Callback branches using the stored state intent (not browser input). Sign-in exchanges the code server-side, requires Google's verified identity, then resolves the account by stable Google subject first, normalized email second, and creates a verified account only when neither matches. A new account receives a standard profile and bcrypt hash of a discarded random secret; existing account/password behavior remains unchanged. The callback rotates any presented session, stores the Google connection in the same transaction, writes `auth.login_google`/`auth.register_google` plus the Google lifecycle audit, and sets the new cookie only on successful sign-in redirect.
- Safe redirects add `signin` and `account`. AuthPanel now displays the Google button and signed-out outcome notices; the shared outcome helper scrubs `?googleOAuth=`. Settings adds “Resend verification email” and a dev-only “Verify now” action.

### Verification actually run

| Check | Result |
|---|---|
| `npx vitest run --reporter=dot` | **570/570 passed, 40 files** |
| `npx tsc --noEmit` | **exit 0** |
| `npm run build` | **exit 0** |
| `npx prisma validate` | **valid** |
| `npx prisma migrate status` | **up to date, 7 migrations** |
| Live B8a smoke | **22/22 passed** — real PostgreSQL/dev server; invalid-code rejection reached Google's real token endpoint; smoke-created OAuthState rows cleaned |
| Real Google sign-in E2E | **10/10 post-flow DB assertions passed** — existing `manikaabir6@gmail.com` account selected, no duplicate, `auth.login_google` + `google.reconnected`, existing connection remains sealed, prior signed-in account session revoked, fresh session issued |
| Browser/UI | Auth gate shows “Continue with Google”; cancellation notice appears and URL is scrubbed; verification resend → dev token → Verify now → verified status and Connect Google button; 1 Phaser canvas |

### Addendum schema and files

Migration **`20261010163847_b8a_google_signin_state`** makes `OAuthState.userId` and `sessionId` nullable; existing link/reconnect rows remain bound, new sign-in rows are unbound. No other schema/data changes were made by this migration. Added audit events `auth.login_google` and `auth.register_google`.

Added `docs/phase_b8a.md`, `components/oauthOutcome.ts` and its tests. Updated `googleOAuth.ts`, `googleConnect.ts`, the Google start/callback routes, `audit.ts`, `AuthPanel.tsx`, `SettingsScreen.tsx`, `apiClient.ts`, and tests for the OAuth domain/start/callback/client flows. The original B8 implementation and B8 report remain intact apart from this addendum.

### Disclosures and remaining constraints

1. The first real Google sign-in E2E resolved to the existing linked `manikaabir6@gmail.com` account; `auth.login_google` + `google.reconnected` were verified, the previous signed-in player session was revoked, and no duplicate MailXP account was created. The existing connection remains intact.
2. During later browser probing, a stale browser ref triggered a second real Google sign-in round-trip. Google returned the already-authenticated `srijitagoswami273@gmail.com` identity; the flow signed into that existing MailXP account and created a second connected GoogleConnection (`google.connected`). This real provider/account side effect was **not deleted or revoked**; it remains in the database for the user to review. Final DB count is 2 Google connections. This is disclosed rather than silently undone.
3. A temporary account `b8a.resend.test@example.com` was created solely for the resend/verify UI test. The app deletion endpoint returned 401 after the dev server became unresponsive, so the exact test account was physically erased afterward using the same FK-safe deletion order as `deletion.ts`; its audit rows were tombstoned. Verification: account absent, profile=true before deletion, zero Google connections removed, final user count returned to 3. No other account was touched.
4. The browser emitted one expected `GET /api/v1/me` 401 after sign-out; it was the normal signed-out auth probe, not an application exception. The later verification UI flow worked and reported no additional console errors. The dev server stopped responding before the API deletion could complete, so cleanup used a direct targeted database transaction.
5. The live smoke's first run used an incorrect double `/v1` path and its next readiness loop repeated that path; after correction, the smoke passed 22/22. These were harness errors, not app failures. Three OAuthState rows currently remain: the previous consumed B8 link state, the consumed B8a sign-in state, and one unconsumed link state from browser testing which will expire normally. They were left in place rather than deleting a state without certainty about ownership.
6. As in B8, a valid-token remote revoke was not exercised; production-mode smoke remains inherited-deferred, rate limits are process-local, and OAuth state rows have no expiry purge job.

**B8a stop point:** B8 + B8a are complete. A final review added a guard preventing sign-in to any connected-sub account marked for deletion; its regression test passed. Final sequence after that fix: **570/570 tests**, tsc 0, build 0, Prisma valid, migrations up to date. No Gmail fetch/sync endpoint or B9 work was started. Await explicit approval before B9.
