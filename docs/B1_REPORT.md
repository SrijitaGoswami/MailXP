MailXP — Phase B1 Report
1. Summary and status
B1 (API contract and integration boundary finalization) was executed on 2026-10-10 as a documentation-only phase. docs/BACKEND_API_CONTRACT.md was rewritten from a draft outline into a binding contract for the first release (B3–B6): 16 first-release routes fully specified, 8 deferred families inventoried with phase markers and inherited safety rules, and all contract-wide conventions (versioning, error envelope, pagination, idempotency, concurrency, CSRF, rate limits, SSE, callbacks, privacy) finalized. Six product decisions were collected from the user. No application code, types, schemas, dependencies, or configuration were created. Status: COMPLETE and STOPPED per spec §10 — awaiting approval before B2.

2. Project root and date
C:\Users\manik\Desktop\MailXP — 2026-10-10. Not a git repository; change control is by tool-call record (every write targeted docs/*.md).

3. B0 decisions used
All seven B0 decisions were preserved unchanged: backend inside this repo (one Cloud Run deployable); custom sessions (httpOnly SameSite=Lax cookie, users/sessions tables, bcrypt; Google OAuth at B8); native Windows PostgreSQL with Prisma recommended for confirmation at B2; login gate before Play (wired at B5, canvas mounts once behind it); cookie-authenticated player-scoped SSE with refetch-on-reconnect and polling fallback; transactional DB outbox + DB queue + in-process worker (Cloud Tasks deferred to production); Google Cloud project and Gemini API key available with secrets server-side. No B0 decision was amended.

4. Route inventory by phase
First release — fully specified in the contract (method, auth, ownership, request, response, errors, idempotency, side effects, rate class):
| ID | Route | Phase |
| health.check | GET /api/v1/health | B3 |
| auth.register | POST /api/v1/auth/register | B4 |
| auth.login | POST /api/v1/auth/login | B4 |
| auth.logout | POST /api/v1/auth/logout | B4 |
| auth.verifyEmail | POST /api/v1/auth/verify-email | B4 |
| auth.resendVerification | POST /api/v1/auth/resend-verification | B4 |
| auth.passwordForgot | POST /api/v1/auth/password/forgot | B4 |
| auth.passwordReset | POST /api/v1/auth/password/reset | B4 |
| me.get | GET /api/v1/me | B4 |
| me.delete | DELETE /api/v1/me | B4 |
| game.state | GET /api/v1/game/state | B5 |
| game.preferencesUpdate | PATCH /api/v1/game/preferences | B5 |
| game.ledger | GET /api/v1/game/ledger | B5/B6 |
| shop.catalog | GET /api/v1/shop | B6 |
| shop.purchase | POST /api/v1/shop/purchases | B6 |
| events.stream (SSE) | GET /api/v1/events | B5 |
Deferred — inventoried with inherited rules, to be finalized at their phase: Google connection (B8, 8 routes), Gmail data/sync (B9), Gemini analysis (B10), recommendations/approvals/actions (B11), rewards reads (merged into game.ledger + rewards.status), notifications/quests (B12), Calendar (B12), wallet/ALGO (B14). Internal operations (job dispatch, reward issuance, wallet verification) have NO player-facing routes by design. Player-facing inventory therefore contains no route that mints rewards or triggers arbitrary Gmail mutation.

5. Authentication/session and authorization contract
- Cookie `mailxp.session`: httpOnly, Secure (prod), SameSite=Lax, path=/; 30-day sliding expiry; rotated on login; password reset revokes all sessions (user decisions 1–2: 30 days; password ≥10 chars, blocklist, no rotation/forced rotation).
- Verification/reset tokens: single-use, hashed at rest, 24 h / 1 h expiry (user decision 3).
- Play-now-verify-later: verification gates only Google/Calendar/wallet (user decision 4).
- Identity only from the server-side session; path/body player ids are never authoritative; cross-player access → 404 (no existence disclosure); 403 reserved for knowable conditions (EMAIL_NOT_VERIFIED, CSRF, paused mailbox).
- CSRF: SameSite=Lax + mandatory Origin check on every mutation (403 CSRF_ORIGIN_REJECTED); double-submit token only if B4 proves it necessary.
- Account enumeration: uniform 401 INVALID_CREDENTIALS on login; always-202 on forgot/resend; explicit 409 EMAIL_EXISTS on register (documented trade-off so users can switch to login).
- Rate classes defined (register 5/h/IP; login 10/15 min per email+IP; forgot/resend 5/h; mutations 60/min; 3 concurrent SSE/player) — RECOMMENDED pending B3/B4 security review.
- me.delete requires password re-auth, is async (202), and never touches Gmail messages.

6. Error envelope and HTTP status mapping
Single envelope { error: { code, message, requestId, details? } } confirmed; details are validation-field errors only. One convention finalized: ALL validation is 400; 422 is explicitly unused. The mapping table defines 15 stable codes across 400/401/403/404/409/429/500/502/503, including both idempotency conflicts and STALE_VERSION. Stack traces, tokens, hashes, provider payloads, and SQL are forbidden in every response; 500 exposes only the requestId for server-log correlation.

7. Pagination/filtering/sorting
Cursor pagination finalized for all list endpoints: `limit` default 25 / max 100, opaque `cursor`, response { items, nextCursor }, stable sort createdAt DESC + id DESC tie-break, invalid cursor → 400, filter whitelists per endpoint with 400 on unsupported combinations, documented edge-skips under mutation with id-based client dedupe.

8. Idempotency and concurrency rules
`Idempotency-Key` header (UUID, per player+endpoint, 24 h retention, request fingerprint stored): same key+same request replays the stored result; different fingerprint → 409 IDEMPOTENCY_MISMATCH; concurrent duplicate → 409 IDEMPOTENCY_IN_PROGRESS. Required on shop.purchase (B6), gmail.actionExecute (B11), wallet.purchaseIntent (B14); explicitly not required on auth routes. Reward issuance uses DB uniqueness (player, actionType, sourceMessageId, rewardType) so replayed provider events cannot double-credit. Optimistic concurrency: `expectedVersion` on state-dependent mutations → 409 STALE_VERSION; approvals (B11) additionally bind a payload fingerprint that edit/regenerate invalidates.

9. SSE event contract and fallback
GET /api/v1/events — cookie-authenticated, Origin-checked, player-scoped from the session only. First release emits `profile.updated` {version}, `economy.updated` {balance, reason, version}, and a ~25 s `ping`; `retry: 5000` on connect. Payloads are minimal pointers — clients refetch REST state; no email bodies/tokens in events. No replay log in the first release: every (re)connect refetches game/state so missed updates self-heal (Last-Event-ID replay deferred to B12 review). RECOMMENDED fallback: 3 consecutive stream failures → poll game/state every 30 s. Invariant recorded: SSE adds no second event bus — React consumes, game/bridge.ts delivers, canvas never remounts.

10. Provider callback/internal-operation boundaries
Callbacks live under /api/v1/callbacks/**, separate from player-session routes: googleOAuth (B8; validates state/nonce + initiating-session binding) and gmailPush (B9; validates authenticity, treats pushes as reconcile hints, deduplicates). All callbacks validate then enqueue to the durable queue and respond fast — no long-running Gmail/Gemini work inline. Internal operations (dispatch, reward minting, wallet verification) are service-internal modules with no public routes.

11. Privacy and response minimization
Responses return only caller-needed fields; never password hashes, session ids, tokens, OAuth credentials, provider payloads, risk/security metadata, or other players' data. List responses exclude email bodies (a governed detail endpoint comes in B9). Deletion/disconnect flows never modify Gmail messages. Audit rows carry no email content.

12. Open decisions and affected phases
- Prisma/ORM confirm, stats shape + preference whitelist (user sign-off), ID type (UUIDv7 recommended) — B2.
- Rate-limit value security review, email-delivery dev-mode mechanism — B3/B4.
- Double-submit CSRF fallback if needed — B4.
- Poll-fallback cadence review, SSE replay — B5/B12.
- Deferred family schemas (§4) — finalized at B8–B14 entry, each before its implementation.
- API contract test tooling (dependency) — B3.
- Reward values/daily cap values — B6 (per MASTER_REQUIREMENTS).

13. Files created/updated
- docs/BACKEND_API_CONTRACT.md — rewritten as the B1-finalized contract (binding for B3–B6; deferred families inventoried).
- docs/phase_b1.md — execution record appended (spec text preserved).
- docs/B1_REPORT.md — created (this report).
No other file was written.

14. Verification performed and not performed
Performed (per spec §7), by re-reading the finalized contract end-to-end after writing:
- Every first-release route entry carries phase, auth, ownership, request/response, error codes, side effects, and idempotency/concurrency/rate class as applicable ✓
- Route identifiers and /api/v1 paths consistent across sections (incl. ledger merge of rewards.history into game.ledger, noted in §7.5) ✓
- Provider callbacks and internal operations described separately from public client endpoints; no unrestricted reward/dispatch route exists ✓
- Every cookie-authenticated mutation documents CSRF handling (Origin check §1.2, referenced per-route) ✓
- SSE events player-scoped with minimal payloads; no second bus; canvas invariant stated ✓
- Gmail approval rules explicit and inherited into the B11 family (individual only, exact recipient/subject/body, separate draft vs send, edit invalidates, stale version requires refresh) ✓
- Rewards require server-verified evidence; client claims forbidden; UTC daily cap reflected ✓
- AI pause, per-player limits, oldest-first queueing, 00:00 UTC reset reflected in the B10 family ✓
- Wallet/ALGO marked deferred to B14 with idempotency and strict DraftCoin separation ✓
- Contract cross-checked against MASTER_REQUIREMENTS (3.1 verification scope, 8.x economy authority) and BACKEND_ARCHITECTURE (§12 boundaries, SSE, queue) — consistent ✓
- All three changed Markdown files re-read; UTF-8 clean.
Not performed (B1 is documentation-only): no build, no type-check, no tests, no dev server — no code changed, so none is claimed. No dependency installation; no schema/migration files; no secrets; no provider API calls.

15. Confirmation that no code/dependencies/runtime data were changed
Confirmed. Zero writes outside the three docs listed in §13. app/ still contains only layout/globals/page/preview (re-checked before work; unchanged). package.json, node_modules, game/, components/, public/ untouched; no .env created; no runtime data touched. Verification rests on the complete tool-call record for the phase.

16. Recommendation for B2
B2 is READY to start after approval. Scope reminder (per phase plan): data-model design + game/profile.ts adapter refactor with ZERO behavior change, plus the B2-entry confirmations now owned by the contract: Prisma, stats/prefs shape (user sign-off), UUIDv7. Prerequisite for the user: PostgreSQL installed natively on Windows. B2 remains frontend-safe: the adapter refactor touches only the persistence seam, verified by tsc/build/profile round-trip checks — no server code yet.

17. Explicit stop awaiting user approval
STOPPED per spec §10. No B2 work has begun, no code exists, no dependencies were installed. Presenting docs/BACKEND_API_CONTRACT.md and this report for review; reply with explicit approval (or amendments) before B2 begins.
