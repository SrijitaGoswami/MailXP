MailXP Backend Phase B8 — Google OAuth and Account Linking
Phase: B8
Status: Implementation specification
Prerequisite: B7 report reviewed; B0–B7 are the approved baseline.
Execution rule: Implement B8 only. Test, write docs/B8_REPORT.md, then STOP for explicit approval before B9.
1. Goal
Add secure Google OAuth authorization and Google-account linking to the existing MailXP Next.js application, including durable storage for Google identity and encrypted OAuth credentials needed by later Gmail/Calendar phases.
B8 is OAuth and connection management only. It does not sync Gmail messages, analyze mail with Gemini, create drafts, send mail, read Calendar data, or add wallet/payment behavior.
2. Required first step: inspect current project state
Before editing:
1. Read docs/MASTER_REQUIREMENTS.md, docs/BACKEND_PHASE_PLAN.md, docs/BACKEND_ARCHITECTURE.md, docs/BACKEND_API_CONTRACT.md, docs/phase_b0.md through docs/phase_b7.md, and docs/B7_REPORT.md.
2. Inspect the current Prisma schema/migrations, auth/session/token helpers, audit helpers, API error envelope, environment validation, logger, tests, and package versions.
3. Verify the current project/worktree state; do not assume this spec matches code perfectly.
4. Record baseline results before editing.
5. If a required policy is genuinely unspecified (especially OAuth linking policy, Gmail scopes, or credential encryption), STOP and ask instead of inventing policy.
Never read, print, paste, or log .env secret values. Inspect variable names/presence only.
3. Scope
In scope
- Google OAuth authorization-code flow with server-side code exchange.
- Cryptographically random, short-lived, single-use OAuth state.
- Secure linking to an already-authenticated MailXP user.
- Verified Google identity/email checks and conflict handling.
- Additive database storage for Google identity/connection and encrypted token material, consistent with existing design.
- Server-only OAuth/configuration helpers.
- Connection-status and disconnect endpoints if defined in the API contract or required for a complete B8 flow.
- Safe audit events, tests, environment-variable documentation, and local setup instructions.
- Minimal UI affordance only if needed to exercise the flow.
Out of scope
- Gmail message listing/history sync, push/watch, attachments, labels, search, or mailbox import (B9).
- Gemini classification, summarization, task extraction, or drafting (B10).
- Gmail send/archive/label/mark-read/create-draft actions (B11).
- Calendar read/write (B12).
- Pera Wallet, ALGO, NFTs, real money, production deployment, Cloud Tasks/Pub/Sub adoption.
- Replacing custom email/password auth or creating a separate backend.
4. OAuth flow requirements
Follow the existing API contract and security conventions:
1. Only a signed-in, email-verified MailXP user can explicitly start “Connect Google”.
2. Generate a cryptographically random OAuth state, store only a hash where practical, bind it to the user/session context, and give it a short expiry (10 minutes unless existing docs specify otherwise).
3. Use a server-configured client ID and redirect URI. Never accept arbitrary redirect URIs from the browser.
4. Use authorization-code flow and exchange the code server-side. Validate and consume state exactly once before exchanging the code.
5. Validate Google identity from a trusted provider response. Never trust browser-supplied email, subject ID, verification status, tokens, or scopes.
6. Require Google to report the identity email as verified.
7. Link only to the currently authenticated MailXP user. Do not silently sign into a different MailXP account or merge accounts merely because emails match.
8. If the Google identity is already linked to another MailXP user, return a safe conflict and do not transfer it.
9. Persist only minimum identity/profile data needed for connection management.
10. Never expose access tokens, refresh tokens, authorization codes, state values, client secrets, raw provider payloads, or stack traces in URLs, browser JSON, logs, audit details, or errors.
11. If OAuth fails or is cancelled, preserve the existing MailXP session and game state.
12. Handle provider denial, missing code, expired/replayed/wrong-user state, invalid token response, and duplicate callbacks safely.
If master requirements/API docs explicitly define a different linking policy, follow those source documents and explain it in the report. Do not silently reconcile conflicts.
5. Scopes and consent
- Request least-privilege scopes explicitly approved in the master requirements.
- Identity scopes may be used to establish Google identity.
- For mailbox connection, request only the Gmail scope explicitly approved for the planned product workflow.
- Do not add Calendar scopes in B8.
- Do not request broad scopes “for future convenience”.
- Store actual granted scopes/status and do not assume every requested scope was granted.
- If the approved Gmail scope cannot be determined from the project docs, STOP and ask before implementing. Do not guess.
6. Credential storage
OAuth credentials must not be stored in plaintext.
1. Inspect the project's existing secret-management and environment-validation conventions.
2. Use authenticated encryption (for example AES-256-GCM) with a key from environment configuration, or the already-approved secret-management mechanism.
3. Store ciphertext, nonce/IV, authentication tag, and key-version metadata as needed. Never store the encryption key in the database.
4. Keep encryption/decryption server-only.
5. Fail closed if encryption configuration is missing/invalid. Never fall back to plaintext, a hard-coded key, a development default, or reversible obfuscation.
6. Tests may inject a test key, but no key may be committed or use a real secret.
7. If existing docs define another approved key-management design, use it. If unresolved, STOP and ask.
Persist refresh tokens only when provided and needed. Store access tokens only if required. Reconnecting must update credentials atomically. Disconnect should delete local credentials and revoke them remotely where supported, but never claim remote revocation succeeded unless confirmed by the provider. Do not implement Gmail API sync in B8.
7. Database and migration safety
- Add only schema required for OAuth state, Google identity/connection, and encrypted credentials.
- Migration must be additive; review generated SQL before applying it.
- Never alter/delete B0–B7 migrations or existing user/game/economy data.
- Add uniqueness constraints for provider subject identity and prevent one Google identity being linked to multiple MailXP users.
- Enforce ownership with foreign keys and indexes.
- Run npx prisma generate explicitly after each Prisma schema change.
- Account erasure must not leave Google credentials or OAuth-state rows associated with an erased user. Update B7 deletion processing with FK-safe cleanup and tests.
- Do not invent provider revocation behavior without a confirmed provider contract.
8. API contract
Inspect docs/BACKEND_API_CONTRACT.md first. Use its existing route names/versioning/error conventions. A complete flow normally needs:
- Start Google connection: authenticated mutation returning/redirecting to Google authorization URL.
- OAuth callback: provider-facing callback with state validation.
- Read connection status: authenticated, player-scoped endpoint.
- Disconnect Google: authenticated, player-scoped mutation with existing origin/CSRF protections.
Use existing callback-route conventions if defined. API errors must follow { error: { code, message, requestId, details? } }. Do not expose provider tokens, raw provider responses, SQL, secrets, or stack traces. Do not add public job-enqueue/worker-trigger endpoints.
9. Environment configuration
Add names/descriptions to .env.example only. Expected names may include:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REDIRECT_URI
- GOOGLE_TOKEN_ENCRYPTION_KEY (or the exact approved key-management configuration)
Follow existing lazy environment validation so unrelated build/static rendering does not fail just because optional provider secrets are absent. If a user tries to connect while configuration is missing, fail safely with a clear non-secret diagnostic.
Never print environment values. Do not create/edit the user's .env file.
10. Frontend and Phaser constraints
- Keep the existing Next.js app and custom email/password sessions.
- Do not gate ordinary gameplay on Google connection or email verification; preserve “play now, verify later”.
- Google connection is an optional explicit action for a signed-in, email-verified user.
- Preserve /, /preview, and all existing routes.
- Do not cause Phaser to mount more than once or reset because of OAuth UI/state changes.
- Keep network work outside OfficeScene.update().
- Continue React/Phaser communication only through game/bridge.ts.
- Do not touch public/assets/mailxp/ without a concrete approved requirement.
11. Security and privacy tests
At minimum test:
- Missing, malformed, expired, replayed, or wrong-user state is rejected.
- Provider denial and missing code fail safely.
- Google identity comes from trusted verification, not browser input.
- Unverified Google email is rejected.
- An identity already linked elsewhere is not transferred.
- Browser-supplied provider ID/email/token cannot establish a link.
- Callback cannot mutate a connection without valid state and correct ownership.
- Tokens/client secrets/state/code never appear in logs, responses, audit metadata, or app-generated redirect query parameters.
- Encryption round-trip works; wrong key/tampered ciphertext fails closed.
- Missing encryption key never enables plaintext storage.
- Disconnect cannot affect another user's connection.
- Account deletion removes local OAuth state/credential records.
- No Gmail or Calendar data APIs are called in B8.
- No send/draft/archive/label actions are possible.
- Production build does not start the dev worker or require provider secrets for unrelated rendering.
12. Tests and acceptance criteria
Add tests for state creation/expiry/single-use/binding, authorization URL/scopes, callback success and failure, identity conflicts, encryption and redaction, disconnect ownership, deletion cleanup, and regressions.
Run commands sequentially on the final unchanged state:
1. npx vitest run
2. npx tsc --noEmit
3. npm run build
4. npx prisma validate
5. npx prisma migrate status
6. Live PostgreSQL flow smoke using test credentials/mocks; never commit real credentials.
7. Browser smoke of / and /preview if available; each must mount exactly one canvas and have no console errors.
If a command fails, fix it and rerun the full sequence. Report intermediate failures honestly. Do not claim real Google consent/callback testing unless actually run with configured test credentials.
13. Required report
Create docs/B8_REPORT.md with:
- Complete/blocked status and rationale.
- Baseline/final results for every command.
- Migration name and reviewed SQL summary.
- Exact changed/created/untouched files.
- Implemented OAuth flow and account-link policy.
- Exact requested scopes and why each is needed.
- Credential encryption design and environment variable names (never values).
- Tests for replay, expiry, identity conflict, unverified email, encryption, redaction, deletion cleanup, and out-of-scope integrations.
- Whether real Google testing occurred or mocks were used.
- Anomalies, intermediate failures, limitations, and residual risks.
- Confirmation B0–B7 data/migrations and Phaser lifecycle remain intact.
- Next-phase recommendation (B9 only if B8 is complete).
14. Stop conditions
STOP before coding and ask the user if:
- The approved Gmail scope cannot be determined from master requirements.
- Account-linking/duplicate-identity policy is ambiguous or conflicting.
- Encryption/key management is unspecified and cannot be grounded in existing docs.
- Required Google OAuth configuration/consent settings cannot be determined.
- Actual project state materially differs from B0–B7 docs or a migration risks existing data.
- Tests show an unresolved regression in auth, deletion, economy, SSE, or game lifecycle.
Otherwise implement B8 only, complete tests, write docs/B8_REPORT.md, and STOP. Do not begin B9 without explicit user approval.
## 15. Execution record (2026-10-10)

- Discovery: read MASTER_REQUIREMENTS, BACKEND_PHASE_PLAN, BACKEND_ARCHITECTURE (�12 key handling), BACKEND_API_CONTRACT (�7.1 route list, �8 callbacks boundary), B0-B7 reports (B7 handoff: additive migration + explicit prisma generate; sync flows preferred; .env never printed), Next.js route-handler docs (`params` is a Promise), existing test harness/fakeDb/rate classes/deletion pipeline.
- Question round (user-approved, five answers): Gmail scope = `gmail.modify` (+ `openid email`); token encryption = AES-256-GCM via 32-byte base64 `GOOGLE_TOKEN_ENCRYPTION_KEY` (fail closed, keyVersion stored, GCP KMS documented as production swap); policy = link-only for B8 (no Google sign-in; master-doc conflict recorded as user decision); UI = Settings card; start immediately with credentials to be added before final live smoke.
- Implementation: schema (GoogleConnection, OAuthState, GoogleConnectionStatus) + migration `20261010143554_b8_google_oauth` (create-only, SQL reviewed, additive) + explicit `npx prisma generate` + `lib/server/{secretBox,googleOAuth,googleConnect}.ts` + 7 routes (status/start/accounts/get/disconnect/reconnect/release + `callbacks/googleOAuth`) + `http.ts` codes (EMAIL_NOT_VERIFIED, SERVICE_UNAVAILABLE) + `audit.ts` google.* event types + `rateLimit.ts` `oauth` class 10/hour/player + `deletion.ts` FK-safe cleanup with best-effort revoke + fakeDb stores/handlers + `.env.example` names only + frontend (`game/backend/contract.ts` DTOs, `apiClient.ts` 3 functions, SettingsScreen Google card with one-time `?googleOAuth=` notice + URL scrub).
- Baseline before edits: vitest 444/444 (35 files), tsc 0, build 0, validate valid, migrate status up to date (5 migrations).
- Test iteration fixes: `exchangeCode` discarded the access token (fixed); fakeDb property key `oAuthState` mismatch; deletion source-scan invariant re-scoped for B8 (pipeline forbids provider code; deletion.ts may import only `@/lib/server/googleOAuth`); test seeds needed `lastSeenAt` (fakeDb has no column defaults); route suite rewritten to avoid real network (`fetch` replaced by direct `Request`s). Four new suites written: secretBox (12), googleOAuth (30+3), google routes (22+1), callback (20+1); deletion +4. Final: 537/537 = 444 baseline + 93 new.
- Final sequential run: vitest **537/537 (39 files)** + tsc 0 + build 0 (all 7 new routes in manifest) + prisma validate valid + migrate status up to date (6 migrations).
- Live smoke `b8_smoke.mjs` (real PostgreSQL + running dev server): **44/44** � status/config flags, real consent URL (scopes/offline/consent/redirect_uri), state stored hash-only and bound, REAL Google token endpoint rejects an invalid code -> `provider` redirect (no secrets in Location, no Set-Cookie), consume-once + replay rejected, 401/403 CSRF/403 unverified/429 rate caps, ownership 404s, release wipes sealed columns, reconnect intent binding, disconnect fail-closed (revoked=false), wrong-user/no-session/nocode callback outcomes, full cleanup (2 pre-existing accounts only; connections/states/jobs/outbox all 0). Script-level fixes during iteration disclosed in B8_REPORT.md �11.
- Browser pass: `/` and `/preview` each exactly one canvas, 0 console errors (after closing 7 stale tabs from earlier phases whose SSE streams tripped the documented 3-stream/player cap - not a B8 defect).
- Real Google consent (user-approved + user-completed in the visible browser): verified email via the app's own dev resend/verify flow (user approval; pre-existing row change disclosed) -> Settings "Connect Google" -> real accounts.google.com consent -> callback exchanged the code against the REAL token endpoint -> link created (googleSub unique, scopes as granted, refresh token sealed AES-256-GCM keyVersion 1) -> `?googleOAuth=connected` -> card shows "manikaabir6@gmail.com (connected)" + notice, URL scrubbed. Connection intentionally left in place (user decision).
- Report: docs/B8_REPORT.md (14 required sections). Stopped before B9, awaiting approval.
