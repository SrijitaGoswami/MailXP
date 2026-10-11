MailXP — Phase B3 Report
1. Summary and completion status
B3 (Backend Skeleton and Health Endpoint) completed on 2026-10-10. Prisma 7.10 is now wired to native PostgreSQL through @prisma/adapter-pg with a lazy, hot-reload-safe client singleton; server-only environment validation and a JSON-line structured logger with request-ID policy exist; and exactly one route — GET /api/v1/health — was implemented per the binding B1 contract, verified both with mocked tests (38/38 suite) and a live dev-server request against the real mailxp_dev database. Status: COMPLETE and STOPPED per spec §12 — awaiting approval before B4.

2. Baseline versions and command results
Versions: Node v24.19.0 · npm 11.17.0 · prisma 7.10.0 · @prisma/client 7.10.0 (preserved, unchanged).
Baseline before edits (run sequentially): vitest 20/20 passed · `npx tsc --noEmit` 0 errors · `npx next build` 0 errors (routes / /_not-found /preview) · `prisma migrate status` up to date (1 migration) · PostgreSQL service Running · app/ contained no API routes. No baseline failures existed.

3. Driver adapter versions and Prisma initialization design
- Added: @prisma/adapter-pg@7.10.0 (pinned to the client's exact line), pg (runtime), @types/pg (dev, needed for strict TS). No other dependency was touched; no major/beta/RC version was adopted.
- The installed adapter's own .d.ts was read first (spec §4A — no v5/v6 examples copied): `new PrismaPg({ connectionString })` implements SqlMigrationAwareDriverAdapterFactory and is passed to `new PrismaClient({ adapter })`.
- lib/server/prisma.ts exports getDb(): construction is LAZY (first server call), so environment validation happens at request time and never during `next build`; the instance is cached on globalThis (`__mailxpDb`) so dev hot reload reuses ONE client/pool instead of pooling per request or per import; DATABASE_URL is never logged.

4. Environment variable names validated and validation timing
- Validated: DATABASE_URL only (present, non-empty, postgresql://-shaped). No future Google/Gemini/wallet variables are validated. Version is NOT an env var (package.json, user decision).
- Timing: lazily inside getDb() at first server use — NOT at module import and NOT during build. Proven by building with .env temporarily moved aside (build exit 0), then restoring it.
- Errors: SERVER_ENV_MISSING / SERVER_ENV_INVALID prefixes naming the variable and category only — a test feeds a fake secret through an invalid URL and asserts the value never appears in the message. .env.example unchanged (no new variable); the real .env value was never read, printed, or reported.

5. Logger format and request-ID policy
- Format: one JSON object per line, always: {"ts":"<ISO>","level":"info|warn|error","msg":"…", …caller fields}. Levels map to console.log/warn/error (stdout/stderr — Cloud Run friendly).
- Defensive redaction: field KEYS matching /(pass|secret|token|auth|cookie|credential|connection|database|dburl|api[-_]?key|private)/i are dropped before serialization (a test asserts password/token/authorization/cookie/databaseUrl/apiKey fields never appear). Callers pass short primitive fields only; stack traces, SQL, request bodies, email content and raw driver messages are never logged (the health route logs only a coarse category: config/timeout/db).
- Request IDs: inbound X-Request-Id is honored only when it matches /^[A-Za-z0-9_-]{8,64}$/; otherwise a fresh crypto.randomUUID() is generated. Every handled response — 200 and 503 — carries X-Request-Id.

6. Health endpoint success/failure contract and version source
- Route: app/api/v1/health/route.ts, the ONLY API route; `export const dynamic = "force-dynamic"` (never prerendered; the DB is probed at runtime, not build).
- Success: 200 { "status": "ok", "db": "ok", "version": "<package.json version>" } after `SELECT 1` through Prisma succeeds within a 2 s bound (Promise-race timeout — supported cleanly; the underlying pg query is not cancellable, so a timed-out query may finish in the background; documented limitation, and the pool is bounded by pg defaults).
- Failure (probe error or timeout): 503 with the B1 envelope { error: { code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable.", requestId, details: [] } }. Bodies never contain SQL, stack traces, connection strings, database/host names, or driver messages (asserted in tests against a realistic auth-failure error).
- Version source: package.json "version" (user decision) read server-side via fs with an "unknown" fallback; not an environment dump.

7. Unit-test results and live database check
MOCKED (deterministic): 38/38 Vitest tests across 5 files — env (5: valid/missing/invalid/trim/no-secret-leak), logger (5: JSON fields, level routing, redaction, request-ID accept/reject), health route (6: 200 contract + echoed ID, fresh UUID on unsafe ID, 503 envelope with zero internal leakage, config-failure envelope, 2 s timeout into 503 with fake timers, X-Request-Id on all handled paths), server-only scan (2: no lib/server|app/api|@prisma imports in game/, components/ or root pages + scanner sanity check), plus the 20 B2 profile tests.
LIVE (real database): with `npm run dev`, `curl -D http://127.0.0.1:3000/api/v1/health` returned HTTP/1.1 200 OK, header `x-request-id: 0d00bc07-6643-445e-8eb3-bf1860381ce7` (server-generated UUID), body `{"status":"ok","db":"ok","version":"0.1.0"}` — a real pool connection and SELECT 1 against mailxp_dev on PostgreSQL 18.6. The dev server was stopped afterwards. Live DB-DOWN behaviour was not exercised against the real server (would require stopping your PostgreSQL service); it is covered by the mocked timeout/rejection tests — stated honestly here.

8. Test/type-check/build/migration verification
- `npx vitest run` → 38/38 passed (5 files).
- `npx tsc --noEmit` → 0 errors (sequential, before build).
- `npx next build` → 0 errors; route list now shows `ƒ /api/v1/health` (Dynamic) alongside the unchanged static /, /_not-found, /preview.
- `npx next build` WITH .env moved aside → 0 errors (runtime-only variables cannot break the build); .env restored and re-verified present afterwards.
- `npx prisma validate` → valid; `npx prisma migrate status` → up to date; migration 20261010064923_init_b2 untouched; no destructive command was ever run.
- Live dev-server regression: GET / → 200, GET /preview → 200 (game UI unaffected).

9. Exact files created/changed
Created: app/api/v1/health/route.ts · app/api/v1/health/route.test.ts · lib/server/env.ts · lib/server/env.test.ts · lib/server/logger.ts · lib/server/logger.test.ts · lib/server/prisma.ts · lib/server/serverOnly.test.ts · docs/B3_REPORT.md (this file)
Modified: package.json (+@prisma/adapter-pg, +pg; +@types/pg dev) · package-lock.json (npm-managed) · vitest.config.mts ("@" alias + widened test include) · docs/BACKEND_ARCHITECTURE.md (§17 B3 implementation details) · docs/phase_b3.md (execution record appended)
Unchanged by design: tsconfig.json, prisma/**, .env, .env.example, game/**, components/**, app/page.tsx, app/layout.tsx, app/preview/**, all assets.

10. Security review and limitations
- Server-only boundary enforced by a static-scan test; DATABASE_URL never reaches NEXT_PUBLIC_*, client bundles, logs, or responses; no NEXT_PUBLIC_ variable was added at all.
- Public endpoint reveals only status/db/version — no environment or deployment metadata.
- Limitations: (a) a timed-out pg query cannot be cancelled mid-flight (the 2 s bound governs the HTTP response, not the driver); (b) the logger redacts by field key plus caller discipline — it is not a general-purpose deep scrubber; (c) rate limiting does not exist yet (no auth phase; B4 introduces rate-limit classes); (d) health does not verify migration state, only connectivity (per B1 contract).
- Secrets hygiene: .env excluded by .gitignore (with .env.example allowlisted); no secret value was read into this session or written to any file or log.

11. Confirmation: no auth flows, other routes, provider integrations, or frontend/game changes
Confirmed. No registration/login/logout/session/cookie/middleware code exists; no /api/v1/me, game state, preferences, ledger, shop or purchase routes exist; no database writes or seeds occurred (the probe is read-only SELECT 1); no queue/worker/SSE/Google/Gmail/Gemini/Calendar/wallet code exists; no deployment configuration was added; game/, components/, assets, routes / and /preview and the profile persistence behavior are unchanged (existing suite + live 200s prove it). Exactly one API route exists in the tree.

12. Recommendation for B4
B4 (authentication, player profile, account lifecycle) is ready after approval. It will build on this foundation: getDb() for users/sessions tables, loadServerEnv for any new server-only variables (none needed yet), the logger + request-ID policy for auth event auditing, and the existing rate-limit classes from the B1 contract (register 5/h/IP, login 10/15 min per email+IP, forgot/resend 5/h) as the first real consumers of 429 RATE_LIMITED. New dependency expected and to be reported: a bcrypt-class password hashing library (to be chosen and justified at B4 entry). Suggested first B4 task order: users/sessions schema use → register/login/logout → tokens (verify/reset) → me.get/me.delete → rate limiting → auth tests (the spec's automated API test suite).

13. Explicit stop pending user approval
STOPPED per spec §12. No B4 work has begun: no auth code, no session handling, no additional routes, no password hashing, no rate limiting. The health endpoint, server foundation, tests, and this report are presented for review; reply with explicit approval (or amendments) before B4 begins.
