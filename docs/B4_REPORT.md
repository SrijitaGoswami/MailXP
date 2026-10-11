# MailXP — Phase B4 Report: Authentication and Account Lifecycle

Date: 2026-10-10
Phase: B4 (prerequisites B0–B3 complete; user approval received; user answered the pre-build question round)
Spec: docs/phase_b4.md · Binding contract: docs/BACKEND_API_CONTRACT.md
Status: **Complete, all applicable acceptance criteria honestly verified. Stopping before B5 pending explicit user approval.**

---

## 1. Summary and completion status

B4 implements the nine contract routes (7 auth + `GET /me` + `DELETE /me`) inside the existing Next.js app on the B3 server foundation: email/password registration, login with session rotation, logout with server-side revocation, email verification (token-borne, atomic single-use), resend-verification, forgot/reset password (single-use 1-hour token, revokes all sessions), `GET /me` (identity from the server-side session only), and `DELETE /me` (password re-auth, 202, idempotent lifecycle marker). Supporting server modules: HTTP envelope/origin/route wrapper, validation + static common-password blocklist, bcryptjs hashing, in-memory rate limiter (replaceable store interface), session/cookie handling, hashed auth tokens, AuditEvent writer, and dev-only delivery surfacing.

The user approved five decisions up front: bcryptjs 3.0.3 · dev-only `devDelivery` response field · PlayerProfile row created at register · AuditEvent table now · live smoke with targeted test-row cleanup.

**No production-code change was made after the live smoke/prod checks**; only two test files were extended afterwards, and the full sequence (vitest → tsc → build → Prisma) was re-run green afterwards.

## 2. Baseline and post-change commands/results (actually run, sequential)

| Step | Baseline (before changes) | Post-change (final) |
|---|---|---|
| `npx vitest run` | 38/38 passed, 5 files, exit 0 | **143/143 passed, 13 files, exit 0** |
| `npx tsc --noEmit` | exit 0 | **exit 0** |
| `npx next build` | exit 0 | **exit 0** (routes below) |
| `npx prisma validate` | schema valid | **schema valid** |
| `npx prisma migrate status` | up to date | **up to date** (2 migrations) |

Order enforced as specified: vitest → tsc → build → Prisma (never concurrent; `next build` only after tsc passed). Final build route table: `ƒ /api/v1/auth/login`, `…/logout`, `…/password/forgot`, `…/password/reset`, `…/register`, `…/resend-verification`, `…/verify-email`, `ƒ /api/v1/health`, `ƒ /api/v1/me`; `○ /`, `○ /_not-found`, `○ /preview` unchanged (static, identical to B3).

Live checks (see §10 for the full evidence set): dev-server smoke 24/24 assertions PASS · production-mode (`next start`) posture PASS · frontend regression `/` → 200, `/preview` → 200, `/api/v1/health` → 200 on the final build.

## 3. Exact routes implemented and contract compliance

All nine §4 routes, and only those (no unlisted routes; health from B3 untouched):

| Route | Implemented behavior vs contract |
|---|---|
| `POST /auth/register` | Origin check (public route per contract) · rate 5/h/IP · 400 validation (email trimmed/lowercased/≤254; password 10–128, blocklist) · 409 EMAIL_EXISTS (P2002 race-safe, accepted enumeration trade-off) · 201 exactly `{ player: { id, email, emailVerified: false, createdAt } }` + `Set-Cookie mailxp.session` (auto-login) · side effects in ONE transaction: user + profile + verification token + session + audit `auth.register` |
| `POST /auth/login` | Origin check · rate 10/15 min per normalized-email+IP · uniform 401 INVALID_CREDENTIALS (byte-identical envelope, verified) for unknown email / wrong password / syntactically invalid email / deletion-pending account; unknown emails pay identical bcrypt cost (`burnPasswordCheck`) · 200 `{ player }` + fresh cookie, presented session revoked in the same transaction (rotation) · audits `auth.login` / `auth.login_failed` without cause |
| `POST /auth/logout` | Origin check · no cookie → 401 UNAUTHENTICATED; cookie present but dead → 204 (idempotent-tolerant) · 204 + cookie cleared with matching attributes; live session revoked + audit `auth.logout` written exactly once |
| `POST /auth/verify-email` | Origin + general rate · 400 missing token · atomic guarded claim (single winner) · 200 exactly `{ player: { emailVerified: true } }` · 404 for unknown/used/expired/replayed (identical envelope — no reason leakage) · 409 CONFLICT already verified · success invalidates all other outstanding verification tokens + audit `auth.email_verified` |
| `POST /auth/resend-verification` | Origin + rate 5/h per email+IP · optional session supplies identity (body ignored when authenticated; contract §2) · **always 202** for known/unknown/verified (no enumeration) · new token supersedes prior outstanding ones · audit only when a token was actually issued · dev-only `devDelivery` |
| `POST /auth/password/forgot` | Origin + rate 5/h per email+IP · **always 202** for any provided email string (no enumeration); 1-hour hashed reset token + audit `auth.reset_requested` when the account exists · dev-only `devDelivery` |
| `POST /auth/password/reset` | Origin + general rate · 400 weak/invalid password (policy) · 404 unknown/used/expired token (identical) · ONE transaction: atomic token consumption → password hash update → revoke ALL sessions → audit `auth.password_reset` · 200 `{}` |
| `GET /me` | Session-only identity (cookie → SHA-256 → server row; caller-supplied ids ignored — tested) · 200 exactly `{ player: { id, email, emailVerified, createdAt } }` · 401 UNAUTHENTICATED (no cookie) vs 401 SESSION_EXPIRED (dead cookie) per §1.4 |
| `DELETE /me` | Origin + session + per-player general rate · password re-auth → 401 INVALID_CREDENTIALS (no mutation on failure) · 400 missing password field · 202 `{}` with guarded `deletionRequestedAt` marker (`updateMany … WHERE deletionRequestedAt IS NULL`), ALL sessions revoked (incl. caller's), cookie cleared, audit `auth.deletion_requested` exactly once · retry after success → 401 SESSION_EXPIRED, zero duplicate work |

Contract details also honored: envelope `{ error: { code, message, requestId, details? } }` with validation details carrying field names/messages only; `X-Request-Id` on every response; 429 carries `Retry-After`; play-now-verify-later preserved (no route requires verification; no `EMAIL_NOT_VERIFIED` 403 exists in B4); identity always from the server-side session.

**Documented interpretations (contract-over-spec resolutions and readings):**
1. **Dev delivery**: contract §OPEN allowed "dev-mode link logged/surfaced" — user approved the response-field form (§7 below); production shape is exactly the contract's.
2. **Forgot 400 for missing/non-string email**: the global §1.4 rule (schema violation → 400 VALIDATION_ERROR) applies; the endpoint's "429 only" line governs enumeration-relevant outcomes, and any provided string still returns 202.
3. **Forgot/resend rate counters are per route** (each 5/h per email+IP), not one shared counter — both readings of the §1.8 grouped row enforce "5/h per email+IP"; worst case is bounded at 10 credential-email requests/hour per email+IP.
4. **Uniform Origin gate**: contract mandates it for cookie-authenticated mutations and explicitly for register; B4 applies it to all nine mutations as hardening (modern browsers always send Origin on non-GET; proven by live curl → 403). No double-submit token added (contract §1.2: only if origin checks prove insufficient — they did not).
5. **Origin equality = host equality** (protocol-agnostic): security-equivalent — an attacker origin can never share our host — and survives load-balancer protocol termination (http behind https). Unit-tested including the https-vs-http same-host case.
6. **Login disabled for deletion-pending accounts** surfaces as the same uniform 401 INVALID_CREDENTIALS (deletion state not disclosed).
7. **Structural vs credential failures on login**: missing/non-string fields → 400 (schema rule); everything credential-shaped → uniform 401.
8. **me.delete session revocation**: contract doesn't state it; revoking all sessions (matching password-reset semantics) is the safer reading. Consequence: an immediate retry ends in 401 SESSION_EXPIRED — still safe (no duplicate destructive work), and the marker guard makes even concurrent double-submits write exactly one audit row (tested).

## 4. Password hashing library/version and justification

**bcryptjs 3.0.3** (`"bcryptjs": "^3.0.3"`), work factor **cost 10**. User decision after the question round; facts behind it:
- The real bcrypt algorithm in pure JavaScript — vetted, no custom hash invented (spec §3).
- Ships its **own TypeScript types** (native `bcrypt@6` has no bundled types → would need `@types/bcrypt`).
- **No install script at all** — immune to this machine's npm allow-scripts gate (bcrypt 6's `install: node-gyp-build` would be gated; `@node-rs/bcrypt` rejected as the least ubiquitous option).
- Actively maintained (3.0.3, Apr 2026), Node 24/Windows-compatible, zero native toolchain risk.
- Documented limitation: bcrypt reads at most 72 bytes, so passwords beyond that add no entropy (the 128-char policy limit still applies). Raising cost later is one line — old hashes keep verifying at their embedded cost.
- Timing parity: `burnPasswordCheck` performs a real compare against a memoized random-target hash so unknown-email logins cost the same as wrong-password logins.

## 5. Session-cookie and token storage/expiry behavior

**Session cookie `mailxp.session`**: httpOnly · SameSite=Lax · Path=/ · Max-Age 2592000 (30 days) · **Secure only in production** (verified live: dev cookie has no `Secure`, `next start` cookie does). Raw token = `crypto.randomBytes(32)` base64url (256-bit opaque, 43 chars, never repeats — tested over 200 generations); **only its SHA-256 hash is persisted** (`Session.tokenHash`, unique). Sliding expiry: `lastSeenAt`/`expiresAt` writes are throttled to at most **one per session per hour** (`SESSION_TOUCH_INTERVAL_MS`), so routine traffic never writes per request. Rotation: login revokes the presented session and issues a fresh one in the same transaction; logout revokes + clears the cookie; password reset and deletion revoke ALL sessions transactionally.

**Auth tokens** (single purpose-scoped `AuthToken` model): 256-bit random, SHA-256 at rest (fast digest is correct for high-entropy input), purpose enum EMAIL_VERIFICATION (24 h) / PASSWORD_RESET (1 h), unique `tokenHash`, atomic consumption via guarded `UPDATE … SET consumedAt WHERE consumedAt IS NULL` — one winner under replay/concurrency, everyone else gets the same 404. Issuing a new token supersedes (consumes) prior outstanding tokens of that purpose. Raw tokens exist only in the dispatch path: never in DB rows, never in logs, never in production responses.

## 6. Rate limiter design and its single/multi-instance limitations

Process-local in-memory `Map` behind a replaceable **`RateLimitStore` interface** (a shared store can be swapped in later without touching route code). Fixed-window counters with injected clock (deterministic tests), opportunistic pruning above 10k keys. Classes implemented exactly as contract §1.8 (**sign-off note**: §1.8 was "RECOMMENDED until the B3/B4 security review signs off" — these values are the user-confirmed B1 values and are hereby signed off as implemented):

| Class | Limit | Key |
|---|---|---|
| register | 5 / hour | IP |
| login | 10 / 15 min | normalized email + IP |
| credentialEmail (forgot, resend — separate counters) | 5 / hour each | normalized email + IP |
| general (verify, reset, logout, me.delete …) | 60 / min | player id when authenticated, else IP |

Client IP = first `X-Forwarded-For` entry, else a shared `unknown` bucket. **Limitation (in code, here, and docs): these limits are per process, NOT distributed** — N Cloud Run instances would each count independently; they must not be claimed reliable across instances. Rate keys live only in memory and are never logged (no raw email/IP in logs). B4 did not require a distributed store (the contract permits this design for the current single-process/local environment), so no stop condition triggered.

## 7. Email verification/reset delivery mode and what was actually tested

**No email is sent — by design.** No provider is configured/approved in the project; inventing a production sender is forbidden by spec §7. User-approved mechanism: **development-mode response surfacing** — outside production only (`NODE_ENV !== 'production'`), register (201), resend-verification (202) and forgot (202) include a `devDelivery: { purpose, token, expiresAt }` field carrying the raw token so flows can be exercised locally (POST the token to verify-email / password/reset).

Actually tested:
- **Unit**: gate returns payload in development/test, `null` in production (injected env, both branches).
- **Live dev server**: register → `devDelivery` present; token consumed by `verify-email` → 200 → replay → 404; forgot → token → `password/reset` → 200 → old password 401 / new password 200. ✅ end-to-end *API* flow.
- **Live production build**: register body contains **no** `devDelivery` key; forgot body is exactly `{}` — tokens generated and stored but never surfaced. ✅ suppression proven live.

**Blocked and reported honestly (not faked):** *production* verification/reset delivery — tokens are minted and stored correctly, but with no approved provider there is no path for a real user to receive them in production. This awaits an approved delivery provider at a later phase. No token is ever written to logs (unit test captures console output across register/forgot/failed-login/failed-verify and asserts no password, token, or hash appears).

## 8. Account deletion lifecycle and re-authentication behavior

`DELETE /me`: Origin check → session → per-player rate → **password re-authentication** → 401 INVALID_CREDENTIALS with **no mutation** on wrong password → single transaction: guarded marker `deletionRequestedAt = now()` (`WHERE deletionRequestedAt IS NULL` — first writer wins) + revoke ALL sessions + audit `auth.deletion_requested` → 202 `{}` + cookie cleared. **Asynchronous by contract**: B4 sets the lifecycle marker and disables login immediately (uniform 401); physical erasure and integration revocation belong to the B7 lifecycle worker — B4 does not imply instant erasure, and the marker makes the operation idempotent and worker-friendly. No public worker endpoint was invented. Retry-safety tested three ways: sequential retry after success (401, no duplicate audit), pre-existing marker + surviving session (202, zero duplicate audit), and concurrent semantics asserted via the guarded-update invariant. **No Gmail/provider code exists in B4** — deletion cannot touch external mail (structural fact, not merely untested).

## 9. Schema/migration changes

Additive only; B2 migration untouched; no `migrate reset`/drop/recreate ever used.
- New migration **`20261010074147_b4_auth_tokens_audit`** (created + applied; SQL reviewed before applying): `TokenPurpose` enum; `AuthToken` (unique `tokenHash`, index `[userId, purpose]`, index `[expiresAt]`, FK cascade); `AuditEvent` (`userId` nullable with FK **SetNull** so rows survive as non-personal tombstones after eventual deletion, index `[userId, createdAt]`, index `[eventType, createdAt]`); `User` gains `tokens[]` / `auditEvents[]` relations. Existing B2 models unchanged — no duplicate User/Session, no B5 profile logic, no profileStorage adapter change.
- Decision (user-approved): **`AuditEvent` table** — contract side effects (`audit auth.*` on every route), plan B4 scope ("audit logging"), and MASTER_REQUIREMENTS §19 need durable records. Rows carry only event type, acting user, `requestId`, and a minimal meta bucket passed through the logger's exact secret-key redaction — never email addresses, content, passwords, tokens, or IPs.
- Decision (user-approved): register creates the **PlayerProfile row in the same transaction** with defaults byte-identical to `game/profile.ts` `DEFAULTS.prefs` (`masterVolume 0.8, uiVolume 0.9, gameVolume 0.8, muted false, motion "full", touchControls "auto"`; `draftCoin 0`, `equippedOutfit "worker"`, empty decor, `version 1` from schema defaults) so B5 finds every user already profiled. Nothing reads it yet — no visible game behavior changed.

## 10. Automated test and live integration results

**143/143 tests, 13 files (105 new tests over the 38-test baseline), all green.** Clear mock/live distinction in file headers:

*Unit (no I/O):* `validate.test` (policy, blocklist, no composition rules) · `password.test` (bcrypt format/cost/salts, malformed-hash safety, dev gate both branches) · `rateLimit.test` (all four classes, window reset, injected clock, IP keying) · `session.test` (256-bit entropy, stable hash ≠ token, cookie attributes prod/dev, cookie parsing) · `http.test` (Origin matrix incl. `null`/garbage/host-with-other-scheme, envelope shape, body parsing, `handle()` 500 sanitization + category-only logging, diagnostics classification).

*Mocked storage (in-memory fake DB, real bcrypt/token crypto) — `auth/routes.test` (39 tests) + `me/me.test`:* registration validation/success/409/hash-not-plaintext/profile prefs/cookie flags/session hash-only; uniform byte-identical 401s; rotation; structural 400s; register/login/credentialEmail/general rate classes with `Retry-After`; logout 401/204/idempotent; verify valid/replay/unknown/expired/409/invalidate-others; resend/forgot always-202 both cases; reset single-use/expiry/policy-not-consuming/revokes-all; **Origin → 403 on every one of the 7 auth mutations** (+ `me` DELETE) before any work; `/me` secret-exclusion (no password/`$2b`/tokenHash/session strings in payload) and session-scoped identity; DELETE re-auth/202/single-audit/retry/guard path/per-player rate; production posture via `NODE_ENV` stub (no `devDelivery`, Secure cookie, exact contract body); no secrets in captured console output; request-ID propagation.

*LIVE database (`mailxp_dev`, clearly labelled `integration.test.ts`, self-skips honestly if unreachable — it ran, zero skips):* real SQL/unique constraints/transactions — hashed rows written, real P2002 → 409, login rotation → `/me` → logout → SESSION_EXPIRED, verification end-to-end incl. replay 404, forgot→reset (password changed at the real hash, all sessions revoked, single-use), uniform 401s, delete lifecycle (marker, revocation, single audit, login blocked), Origin rejection leaves rows untouched. Cleans up its own tagged rows in `afterAll`.

*Live HTTP smoke (dev server, approved):* **24/24 assertions PASS** — health 200, register 201 + cookie + normalized email + devDelivery, verify 200, replay 404, `/me` 200 with `emailVerified: true`, login 200 + rotation, logout 204, resend 202, forgot 202 + token, reset 200, old password 401, new password 200, delete 202, login-after-delete 401, missing-Origin 403 `CSRF_ORIGIN_REJECTED`, `/` 200, `/preview` 200. Honest note: the first attempt failed entirely with 400s — PowerShell mangled inline JSON quotes, so every request *correctly* received 400 VALIDATION_ERROR (contract behavior for malformed bodies); re-run with file-based bodies passed. The two final regression lines were re-verified separately on the final production build (`/` 200, `/preview` 200, health 200) because the smoke's output tail was truncated.

*Live production-mode check (`next start`, NODE_ENV=production):* register 201 with exact contract body (no `devDelivery`) and `Secure; HttpOnly; SameSite=lax; Max-Age=2592000` cookie; forgot 202 body exactly `{}`; health 200.

*Existing suites:* all B2 profile tests and B3 health/env/logger/serverOnly tests pass unchanged (`serverOnly.test` boundary still enforced).

*Cleanup:* smoke rows removed with a targeted script (users on the reserved `@example.test` test domain only): 2 users, 12 audit rows, 4 sessions, 4 tokens, 2 profiles; 0 remain. No destructive DB commands at any point.

## 11. Exact files changed

**New — server modules (server-only):** `lib/server/http.ts` (envelope/origin/body parsing/`handle()` wrapper/`isUniqueViolation`/`errorCategory`) · `lib/server/validate.ts` · `lib/server/commonPasswords.ts` · `lib/server/password.ts` · `lib/server/rateLimit.ts` · `lib/server/session.ts` · `lib/server/tokens.ts` · `lib/server/audit.ts` · `lib/server/emailDelivery.ts`.

**New — routes:** `app/api/v1/auth/{register,login,logout,verify-email,resend-verification}/route.ts` · `app/api/v1/auth/password/{forgot,reset}/route.ts` · `app/api/v1/me/route.ts` (GET+DELETE).

**New — tests:** `lib/server/{validate,password,rateLimit,session,http}.test.ts` · `app/api/v1/auth/routes.test.ts` · `app/api/v1/me/me.test.ts` · `app/api/v1/auth/integration.test.ts` (live DB).

**New — test-only helper:** `lib/server/fakeDb.ts` (in-memory Prisma stand-in; imported only by tests, never by production code).

**Modified:** `prisma/schema.prisma` (§9) · `prisma/migrations/20261010074147_b4_auth_tokens_audit/` (new, additive) · `package.json` + `package-lock.json` (bcryptjs) · `lib/server/logger.ts` (exports `redactFields()` so AuditEvent meta uses the exact log redaction policy; emit behavior unchanged) · `vitest.config.mts` (`process.loadEnvFile()` so the live suite can reach `DATABASE_URL` — self-skips if absent; `testTimeout 15 s` for bcrypt-cost flows) · `docs/B4_REPORT.md` (new) · `docs/phase_b4.md` (§16 execution record appended, spec preserved) · `docs/BACKEND_ARCHITECTURE.md` (§18 appended).

**Untouched:** `game/**` (profile, profileStorage, bridge, scenes, assets), `app/page.tsx`, `app/layout.tsx`, `app/preview/**`, `app/api/v1/health/route.ts` + its tests, `lib/server/env.ts`, `lib/server/prisma.ts`, B2 migration `20261010064923_init_b2`, `.env`, public assets.

## 12. Security review, limitations, unresolved decisions, blocked work

**Verified:** uniform 401s (byte-identical, timing-parity bcrypt) · Origin gate on every mutation before any work · hashed-at-rest session and auth tokens (raw never persisted/logged/surfaced in prod) · atomic single-use token consumption · transactions around register/rotation/reset+revoke/delete marker · `Redaction` shared between logs and audit meta · no secrets in any tested response or console output · envelope/request-ID consistency · server-only boundary enforced · enumeration behavior exactly as B1 accepted (409 on register; 202 on forgot/resend).

**Limitations (explicit, per spec §9/§13):**
1. **Rate limits are process-local** — not reliable across multiple Cloud Run instances; store interface is the documented replacement seam.
2. **Production email delivery is blocked** — no approved provider; dev-mode surfacing only (§7).
3. **Account erasure is marker-based** — physical deletion/integration revocation awaits the B7 worker; B4 guarantees: login disabled immediately, sessions revoked, idempotent retry.
4. **DB-down live path not exercised for auth routes** — would require stopping the user's PostgreSQL (as in B3); failure classification is unit-tested (`category: db` → sanitized 500) but not live-triggered.
5. **bcrypt 72-byte truncation** (§4); **first-XFF IP keying** is spoofable only if an instance is hit directly behind no LB — revisit at deployment.
6. `devDelivery` exists only in non-production, proven by unit + live prod check — but no production deployment exists yet to re-verify against.

**Unresolved decisions carried forward (none blocking):** shared-vs-per-route counter reading for forgot/resend (per-route chosen, §3.3) · double-submit CSRF fallback (deferred; origin checks sufficient so far — contract defines the trigger) · stats/prefs server shape (B5) · SSE replay (B5/B12) · email provider choice + verification UX (frontend chat, later phase).

**No stop condition triggered:** no contract/spec route conflict (contract wins per spec §4; readings documented), delivery method was user-approved before build, the hashing choice required no toolchain change, no distributed store was mandated for B4, migration is additive, deletion semantics are safe within B1, and no secrets or frontend changes were needed.

## 13. Confirmation: B5, Gmail/Gemini, game UI and Phaser were NOT implemented or changed

- **B5 not started**: no server-authoritative profile sync, no login gate, no game-state routes (`/game/*` do not exist), no SSE, no profileStorage change — B2's adapter seam and its public API are untouched.
- **Gmail/Gemini/Calendar/wallet/quests/notifications**: not implemented; no provider code added anywhere in B4. Account deletion cannot mutate Gmail because no such code path exists.
- **Game UI / Phaser**: `game/**`, `app/page.tsx`, `app/layout.tsx`, `app/preview/**` and all assets unchanged; `/` and `/preview` return 200 and remain static; the Phaser canvas mount behavior, `game/bridge.ts` channel and local profile persistence are byte-identical.
- **Play-now-verify-later preserved**: no route requires email verification; no verification gate added to any flow.

## 14. Recommendation for B5

B5 can build the login gate and profile sync directly on B4: sessions already work end-to-end (`register → login → /me → logout`, 30-day sliding, rotation on login), `/me` is the gate's identity source, and **every registered user already has a PlayerProfile row with frontend-identical defaults** — B5 needs no backfill for new users (existing dev-only test users are cleaned up; add a one-time backfill only if real pre-B5 users appear). Suggested B5 scope order: (1) login/register/reset UI components by the frontend chat against the nine routes; (2) session-based gate wiring with `SESSION_EXPIRED` → silent re-login (the distinct 401 code was built exactly for this); (3) server-authoritative profile columns migration (stats remain ephemeral until then) + `/game/state` + `/game/preferences` with `expectedVersion`/409 STALE_VERSION; (4) `profile.updated` SSE with refetch-on-reconnect. Watch-outs for B5: keep all mutations Origin-carrying (same-origin browser calls are fine by default), do not log emails, and remember the rate limiter is per-process when load-testing locally.

## 15. Explicit stop — pending user approval

B4 is complete and reported. **I am not starting B5.** Presenting this report and awaiting explicit approval before any B5 work, per phase_b4.md §15.
