MailXP — Phase B4: Authentication and Account Lifecycle
Phase: B4
Title: Authentication, sessions, player account lifecycle
Prerequisites: B0–B3 completed; explicit user approval to begin B4
Status: Ready for execution
Hard stop: Complete B4, write docs/B4_REPORT.md, then wait for approval before B5.
1. Objective
Implement secure email/password authentication and the first account-lifecycle endpoints in the existing MailXP Next.js application, using the B1 API contract and the B3 server foundation.
B4 makes it possible for a player to create and manage a MailXP account through API endpoints. It does not yet connect the game profile to the server or add a login gate to the game UI; those belong to B5.
The existing game and website must remain visually and behaviorally unchanged in B4.
2. Read first
From the MailXP project root, read:
- docs/B0_REPORT.md
- docs/B1_REPORT.md
- docs/B2_REPORT.md
- docs/B3_REPORT.md
- docs/MASTER_REQUIREMENTS.md
- docs/BACKEND_PHASE_PLAN.md
- docs/BACKEND_ARCHITECTURE.md
- docs/BACKEND_API_CONTRACT.md
- docs/phase_b4.md
- package.json, package-lock.json, tsconfig.json, .gitignore
- prisma/schema.prisma, prisma.config.ts, current migration files
- .env.example
- lib/server/env.ts, lib/server/logger.ts, lib/server/prisma.ts
- app/api/v1/health/route.ts and its tests
- current Vitest setup and all existing tests
- game/profile.ts, game/profileStorage.ts, game/profile.test.ts
- app/page.tsx, app/layout.tsx, app/preview/**, and relevant frontend components.
If a required report or source file is missing, stop and report it. Do not infer implementation details from previous phase summaries.
3. Confirmed decisions to preserve
Architecture
- Implement B4 in the existing Next.js project, not a separate backend app.
- Preserve B3's lazy, hot-reload-safe Prisma 7.10 client using @prisma/adapter-pg and pg.
- Reuse lib/server/env.ts, lib/server/logger.ts, request-ID behavior, and the B3 health endpoint.
- Preserve the B2 schema and migration history; no destructive reset or database replacement.
- API prefix is /api/v1.
- The B1 error envelope is binding:
  { "error": { "code": "...", "message": "...", "requestId": "...", "details": [] } }
  Include details only according to the B1 contract, and validation details may contain field names/messages only—not secrets.
- Identity and ownership must be derived from the server-side session, never from a caller-supplied player ID.
- Cross-player resource access must not disclose existence; return 404 where the B1 contract specifies it.
Authentication policy
- Email/password accounts.
- Password hashing uses a vetted bcrypt-class library. Inspect the current Node 24 / Windows toolchain and choose a maintained, compatible implementation (for example, bcrypt or bcryptjs only after checking maintenance, runtime compatibility, and available types). Document the choice and reason. Do not invent a custom password hash.
- Session cookie name: mailxp.session.
- Cookie: httpOnly, SameSite=Lax, path=/, Secure in production, with 30-day sliding expiry.
- Rotate the session on login. Store only a hash of the raw session token in the database.
- Password reset revokes all active sessions for the user.
- Verification/reset tokens are single-use, hashed at rest, with 24-hour email-verification expiry and 1-hour password-reset expiry.
- Password minimum length is 10 characters, apply a maintained common-password blocklist if one is already available or introduce a small well-justified source; do not force periodic password rotation.
- Login failure uses uniform 401 INVALID_CREDENTIALS.
- Forgot-password and resend-verification always return 202 regardless of whether the email exists.
- Registration uses 409 EMAIL_EXISTS as the documented B1 trade-off.
- Play-now-verify-later: email verification does not block game access. Verification will be required later for Google/Calendar/wallet integrations; do not add those integrations now.
- All cookie-authenticated mutations enforce an Origin check. Use the B1 CSRF contract; do not add a double-submit token unless a concrete security review shows the Origin check is insufficient.
- Rate-limit classes from B1 are required:
  - register: 5 per hour per IP;
  - login: 10 per 15 minutes per email+IP;
  - forgot/resend verification: 5 per hour;
  - general mutations: 60 per minute.
    Use a design suitable for the current single-process/local environment and document the limitation of in-memory limits for multi-instance production. Do not claim in-memory limits are globally distributed.
- DELETE /api/v1/me requires password re-authentication, responds 202, and starts a safe account-deletion lifecycle. It must not delete or mutate Gmail messages.
4. Exact B4 routes
Implement only the following routes specified by B1:
1. POST /api/v1/auth/register
2. POST /api/v1/auth/login
3. POST /api/v1/auth/logout
4. POST /api/v1/auth/verify-email
5. POST /api/v1/auth/resend-verification
6. POST /api/v1/auth/password/forgot
7. POST /api/v1/auth/password/reset
8. GET /api/v1/me
9. DELETE /api/v1/me
Before implementation, inspect every corresponding route entry in docs/BACKEND_API_CONTRACT.md and follow its exact request/response fields, statuses, rate classes, CSRF requirements, and idempotency rules. The B1 contract wins over illustrative examples in this phase file. Do not add unlisted routes.
5. Schema and migration requirements
Inspect the existing B2 schema first. It already contains User and Session models, including password hash, verification and deletion lifecycle fields, hashed session token, expiry, revocation, and indexes.
- Reuse and extend the existing models only where B1/B4 needs a field that is genuinely missing.
- Do not create duplicate User or Session models.
- Add verification-token and password-reset-token storage models (or a single purpose-scoped token model) only if needed, with hashed token, purpose, user relation, expiry, consumed timestamp, and appropriate indexes/uniqueness.
- Store only token hashes, never raw tokens.
- Store token hashes with a cryptographically secure digest of a high-entropy random token. Tokens must be generated with a secure server-side random source.
- Any schema change requires a new additive Prisma migration. Never edit an already-applied migration and never use migrate reset, drop/recreate the database, or delete local data.
- Use transaction boundaries where required for session rotation, token consumption, password reset plus session revocation, and account lifecycle changes.
- Do not add B5 profile-sync logic or change the B2 profile persistence adapter.
- Document account deletion semantics precisely. If deletion is asynchronous, set a lifecycle marker and ensure the operation is safe to retry; do not imply all account data is physically erased instantly. Avoid deleting or modifying third-party Gmail content.
6. Endpoint behavior and security
Registration
- Validate email and password server-side.
- Normalize email consistently (trim and case normalization as specified in the API contract).
- Hash the password with the selected password-hashing library and appropriate work factor.
- Create the user and any required initial profile in the manner specified by the contract. If the contract leaves profile creation ambiguous, do not silently implement game-state behavior; document the decision and ask before expanding B4 scope.
- Create verification token state and invoke the project's documented email-delivery mechanism if one exists.
- Do not send real email through an unconfigured provider or leak verification tokens in production responses/logs.
- Preserve the documented 409 EMAIL_EXISTS behavior.
Login and sessions
- Use a uniform 401 INVALID_CREDENTIALS response for unknown email and wrong password.
- Do not reveal whether an account is verified through login errors.
- Generate a high-entropy opaque session token; store only its hash in Session.tokenHash.
- Set the mailxp.session cookie with the confirmed attributes and 30-day expiry.
- Rotate/revoke the prior session as required by the B1 contract.
- Implement sliding expiry carefully: update lastSeenAt/expiry with bounded frequency so every request does not cause needless database writes.
- Never accept a userId/player ID in a request as identity.
Logout
- Validate Origin for the mutation.
- Revoke the current session in the database and clear the cookie using matching cookie attributes.
- Be safe if the session is already invalid or absent, following the B1 response contract.
Email verification and resend
- Verify only a valid, unexpired, unused token.
- Store token hashes, consume tokens atomically, and prevent replay.
- Resend always returns the B1-mandated 202 response to avoid enumeration and obeys rate limits.
- Do not block the game because an email is unverified.
- If no email provider is configured, implement only the safe development-mode mechanism explicitly permitted by B0/B1. Never expose development tokens in production or ordinary logs. If the intended development delivery method is not documented, stop and ask rather than inventing a production email system.
Password reset
- Forgot-password always returns 202 with the same public response for existing and nonexistent emails.
- Reset token expires after one hour, is single-use, and is stored hashed.
- Reset must validate the password policy and consume the token atomically.
- On success, update the password hash and revoke all existing sessions in the same transaction.
- Never return the reset token in production API responses or logs.
- Do not force password rotation on a schedule.
GET /api/v1/me
- Authenticate only from the session cookie and server-side session record.
- Return only the minimal fields specified in B1; never return password hashes, session IDs/token hashes, raw tokens, verification/reset tokens, internal risk metadata, or database details.
- Expired/revoked/unknown session behavior must match B1.
DELETE /api/v1/me
- Require a valid session and password re-authentication according to B1.
- Enforce Origin/CSRF protection and mutation rate limiting.
- Return 202 as specified.
- Safely mark deletion as requested or enqueue the contract-defined internal lifecycle operation. Do not invent a public worker endpoint.
- Do not mutate Gmail messages or other external provider data.
- Repeated requests must not cause duplicate destructive work.
7. Email delivery and development mode
B4 must not add a real email provider unless one is already explicitly configured and approved in the existing project docs.
Inspect B0/B1 documentation for the development-mode email verification/reset flow. Follow it exactly. If the contract leaves this unresolved:
1. implement token generation and persistence safely;
2. do not expose tokens through production routes or logs;
3. report the development flow as blocked;
4. ask the user to approve a local-only delivery method before claiming verification/reset is end-to-end functional.
Do not add a fake production email sender.
8. Rate limiting
Implement the B1 rate classes with tests. Use normalized email plus IP for login keying, and IP for registration/forgot/resend as defined by the contract. Avoid logging raw email addresses or IP addresses unnecessarily.
If the initial implementation is process-local:
- make the limitation explicit in code/docs/report;
- keep the rate-limiter interface replaceable by a shared store in a later deployment phase;
- do not claim the limits are reliable across multiple Cloud Run instances.
  If a persistent/distributed rate-limit store is required by B1 and no approved store exists, stop and ask instead of silently weakening the requirement.
9. Testing requirements
Add automated tests using the existing Vitest setup. Mock email delivery and other external boundaries; do not make tests depend on a real email provider.
Minimum coverage:
- registration validation, success, duplicate email 409, password hash stored rather than plaintext;
- login success, wrong password and unknown email both return identical public 401 envelope;
- session token is opaque/high entropy; only its hash is persisted;
- cookie flags, expiry, secure-in-production behavior and rotation;
- logout revokes the session and clears cookie;
- invalid, expired, consumed, and replayed verification tokens are rejected safely;
- resend-verification always returns 202 for known/unknown emails;
- forgot-password always returns 202 for known/unknown emails;
- password-reset token expiry and single use;
- successful password reset revokes all active sessions transactionally;
- password policy and common-password handling;
- Origin rejection on every cookie-authenticated mutation;
- rate-limit behavior for all four classes;
- /api/v1/me derives identity from session and excludes secrets;
- DELETE /api/v1/me requires re-auth, returns 202, is safe to retry, and never touches Gmail;
- generic/sanitized error envelope and request-ID propagation;
- no secrets/tokens/passwords appear in logs or responses;
- existing B3 health route tests and all B2 profile tests still pass;
- server-only boundary remains enforced.
Use unit tests and DB integration tests where practical. Clearly distinguish mocks from live database tests. Do not claim an end-to-end email flow works unless the delivery path is actually exercised.
10. Regression checks
Before changes, run the current B3 suite, TypeScript check, production build, Prisma validation and migration status sequentially; record the baseline.
After changes:
1. run npx vitest run;
2. run npx tsc --noEmit;
3. run npx next build only after type-check completes (do not run concurrently);
4. run npx prisma validate;
5. run npx prisma migrate status;
6. run live HTTP smoke tests for the B3 health route and B4 auth routes if the local environment supports them;
7. verify / and /preview still return 200 and the game/profile behavior remains unchanged.
Never use destructive migration commands. Do not print or copy .env contents into the report.
11. Out of scope — do not implement
- B5 server-authoritative game profile sync or login gate.
- Any changes to game/profile.ts, game/profileStorage.ts, game/bridge.ts, Phaser scenes, assets, game mechanics, or visible UI.
- Google OAuth, Gmail, Gemini, Calendar, Pera Wallet or ALGO.
- Shop/ledger/reward APIs, queues, outbox, SSE, notifications or quests.
- Additional routes not listed in Section 4.
- Production email provider setup unless already explicitly approved.
- Production Cloud Run deployment.
- Destructive database reset or rewrite of B2/B3 foundations.
12. Required files and change control
Expected changes may include:
- app/api/v1/auth/register/route.ts
- app/api/v1/auth/login/route.ts
- app/api/v1/auth/logout/route.ts
- app/api/v1/auth/verify-email/route.ts
- app/api/v1/auth/resend-verification/route.ts
- app/api/v1/auth/password/forgot/route.ts
- app/api/v1/auth/password/reset/route.ts
- app/api/v1/me/route.ts (GET and DELETE as contract allows)
- server-only auth/session/token/rate-limit/email-delivery modules;
- additive Prisma schema/migration only if required;
- focused tests;
- compatible password-hashing dependency and lockfile changes;
- docs/BACKEND_ARCHITECTURE.md only for confirmed decisions;
- append execution record to docs/phase_b4.md without deleting this specification;
- docs/B4_REPORT.md.
Do not rewrite unrelated docs or refactor B3 merely for style. Report every changed file and why.
13. Acceptance criteria
B4 is complete only when all applicable criteria are honestly verified.
Auth/session
- [ ] All nine routes match B1 request, response, status and error contracts.
- [ ] Passwords are hashed using the chosen maintained library; no plaintext password is persisted.
- [ ] Session token is high entropy; only token hash is stored.
- [ ] Cookie attributes match the B1 contract, including production Secure behavior.
- [ ] Login rotates the session and logout revokes it.
- [ ] Password reset consumes a single-use token and revokes all sessions.
- [ ] Verification/reset tokens are hashed, expiring and single-use.
- [ ] Account enumeration behavior matches B1.
- [ ] Play-now-verify-later is preserved.
- [ ] Account deletion is re-authenticated, asynchronous 202, retry-safe and does not mutate Gmail.
Security
- [ ] Origin checks protect every cookie-authenticated mutation.
- [ ] Rate limits match the B1 classes, with deployment limitations documented.
- [ ] Identity is derived only from the server-side session.
- [ ] No secrets or sensitive token/password values appear in logs or responses.
- [ ] Error envelope is consistent and sanitized.
- [ ] Server-only modules remain out of client/game bundles.
Regression and evidence
- [ ] All B2/B3 tests continue to pass.
- [ ] New B4 tests pass.
- [ ] TypeScript check and production build pass sequentially.
- [ ] Prisma schema validation and migration status pass.
- [ ] Existing migration history is preserved; no destructive database commands were used.
- [ ] /, /preview, the Phaser canvas and local profile persistence remain unchanged.
- [ ] Any untested email delivery, production multi-instance rate limiting, or deletion worker limitation is explicitly recorded.
If a security-critical test fails, stop and report the failure rather than marking B4 complete.
14. Required docs/B4_REPORT.md
Include:
1. Summary and completion status.
2. Baseline and post-change commands/results.
3. Exact routes implemented and contract compliance.
4. Password hashing library/version and justification.
5. Session-cookie and token storage/expiry behavior.
6. Rate limiter design and its single/multi-instance limitations.
7. Email verification/reset delivery mode and what was actually tested.
8. Account deletion lifecycle and re-authentication behavior.
9. Schema/migration changes, if any.
10. Automated test and live integration results.
11. Exact files changed.
12. Security review, limitations, unresolved decisions and blocked work.
13. Confirmation that B5, Gmail/Gemini, game UI and Phaser behavior were not implemented or changed.
14. Recommendation for B5.
15. Explicit stop pending user approval.
15. Stop conditions and approval gate
Stop and ask the user if:
- B1's route details conflict with this spec;
- email development delivery is unresolved and implementation would require exposing tokens;
- a password-hashing library or runtime compatibility issue requires a major toolchain change;
- a required distributed rate-limit store is unavailable;
- schema changes would require destructive migration;
- account deletion semantics cannot be implemented safely within B1;
- secrets are exposed or frontend/game architecture changes would be needed.
When B4 is complete, do not begin B5. Present docs/B4_REPORT.md, summarize real test results, and wait for explicit approval.
B4 completion means authentication and account lifecycle APIs are implemented and verified. It does not mean the game is connected to server-authoritative profile data; that is B5.

## 16. Execution record (2026-10-10)

Completed under this spec. The spec above is preserved unchanged; this section records what actually happened.

- User approval received to start B4; pre-build question round answered (bcryptjs 3.0.3 · dev-only `devDelivery` response field · PlayerProfile row at register · AuditEvent table now · live smoke with targeted test-row cleanup).
- Baseline re-verified before changes: vitest 38/38 (5 files), tsc 0, next build 0, prisma validate valid, migrate status up to date.
- Dependency: `bcryptjs@3.0.3` installed (no install scripts; bundled TypeScript types).
- Schema: additive migration `20261010074147_b4_auth_tokens_audit` (TokenPurpose enum, AuthToken, AuditEvent, User relations) — SQL reviewed before applying; B2 migration untouched; `prisma migrate` only (`migrate dev`/`status`/`validate`; no destructive commands ever used).
- New server modules under `lib/server/`: `http.ts`, `validate.ts`, `commonPasswords.ts`, `password.ts`, `rateLimit.ts`, `session.ts`, `tokens.ts`, `audit.ts`, `emailDelivery.ts` (+ test-only `fakeDb.ts`); `logger.ts` gained an exported `redactFields()` used by audit meta.
- Nine routes implemented (all `force-dynamic`): `auth/register`, `auth/login`, `auth/logout`, `auth/verify-email`, `auth/resend-verification`, `auth/password/forgot`, `auth/password/reset`, `me` GET+DELETE. Health route and all other routes unchanged.
- Contract conformance checked line-by-line against `BACKEND_API_CONTRACT.md` §1.4/§1.8/§4 before final verification; interpretations recorded in `docs/B4_REPORT.md` §3 (dev delivery field, forgot/resend per-route counters, uniform Origin gate, host-equality Origin check, login-disabled-for-deletion 401, structural-vs-credential 400s, me.delete session revocation).
- Final sequential verification: vitest **143/143 (13 files)** → tsc **0** → next build **0** (nine auth routes + health + me dynamic; `/`, `/_not-found`, `/preview` static unchanged) → prisma validate valid → migrate status up to date.
- Live checks: dev-server smoke **24/24 PASS** (first attempt failed only because PowerShell mangled inline JSON — the app correctly answered 400 VALIDATION_ERROR to the malformed bodies; re-run with file-based bodies passed); production-mode `next start` check (no `devDelivery`, `Secure` cookie, forgot body exactly `{}`); frontend regression `/` 200, `/preview` 200, health 200 on the final build.
- Smoke rows cleaned up with a targeted script (reserved `@example.test` domain only): 2 users, 12 audit rows, 4 sessions, 4 tokens, 2 profiles removed; 0 remain. No destructive DB commands.
- Report written: `docs/B4_REPORT.md` (all 15 sections per §14); confirmed decisions appended to `BACKEND_ARCHITECTURE.md` §18.
- No stop condition (§15) triggered. **B5 not started — halted pending explicit user approval.**