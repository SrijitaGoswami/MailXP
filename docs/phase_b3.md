MailXP — Phase B3: Backend Skeleton and Health Endpoint
Phase: B3
Prerequisites: B0, B1, and B2 completed; user explicitly approved B3.
Scope: Backend foundation inside the existing Next.js application only. Stop before B4.
1. Objective
Wire the existing Prisma 7.10.0 setup to native PostgreSQL using the PostgreSQL driver adapter, add server-only environment validation and structured request-correlated logging, and implement only GET /api/v1/health. Preserve the existing frontend and Phaser game.
B3 does not implement authentication, profile APIs, economy APIs, queues, SSE, Google, Gmail, Gemini, Calendar, wallet support, or production deployment.
2. Read first
From the MailXP project root, read:
- docs/B0_REPORT.md, docs/B1_REPORT.md, docs/B2_REPORT.md
- docs/MASTER_REQUIREMENTS.md
- docs/BACKEND_PHASE_PLAN.md
- docs/BACKEND_ARCHITECTURE.md
- docs/BACKEND_API_CONTRACT.md
- docs/phase_b3.md
- package.json, package-lock.json, tsconfig.json, .gitignore
- prisma/schema.prisma, prisma.config.ts, and the existing migration SQL
- .env.example
- game/profile.ts, game/profileStorage.ts, game/profile.test.ts
- current app routes and existing test/build configuration.
If required files are missing, stop and report that. Do not reconstruct missing reports by guessing.
3. Decisions to preserve from B0–B2
- Backend lives inside this existing Next.js project; do not create a separate backend application.
- Prisma and @prisma/client are pinned to stable 7.10.0 per B2, unless inspection reveals an actual conflict requiring approval.
- Database is native PostgreSQL on Windows; no Docker and no SQLite substitution.
- Existing mailxp_dev database and B2 migration must not be reset or destroyed.
- UUIDv7 and the B2 schema remain unchanged.
- API prefix is /api/v1.
- The health endpoint is GET /api/v1/health.
- No authentication exists yet. Health is public but must reveal minimal information.
- Preserve game/bridge.ts, game/profile.ts, game/profileStorage.ts, the one-time Phaser canvas mount, /, and /preview.
- No network or database work inside OfficeScene.update().
4. Allowed work
A. Prisma 7 PostgreSQL adapter
Inspect current installed versions and add compatible stable dependencies:
- @prisma/adapter-pg
- pg
- required type packages only if actually necessary.
Use the correct API for Prisma 7.10.0; do not copy Prisma 5/6 examples that do not match the installed API. Add a server-only Prisma client module that:
- constructs Prisma Client with the PostgreSQL adapter;
- reuses a single client during Next.js development hot reload;
- avoids creating a connection pool per request/import;
- cannot be imported into browser/game bundles;
- never logs the database URL or credentials.
Do not upgrade Prisma to a major, beta, or release-candidate version. Do not update unrelated dependencies.
B. Environment validation
Add a minimal server-only environment validation module for variables B3 actually requires, including DATABASE_URL and a safe application version/build identifier if needed.
- Validate at runtime/server use in a way that does not break a frontend build merely because runtime secrets are absent during next build.
- Errors must name the missing/invalid variable and problem category, never its value.
- Do not create fallback credentials or a fallback database.
- Do not validate future Google/Gemini/wallet secrets.
- .env.example must contain placeholders only; keep real .env ignored and never print or include its values in reports.
- Document when validation runs.
C. Structured logging and request IDs
Create a small server-only logger or reuse an existing appropriate utility. It must:
- support info, warn, and error;
- emit structured JSON or an equivalent machine-readable format;
- attach a request ID to health request logs;
- accept an incoming request ID only if it matches a documented safe format and length limit; otherwise generate a new unpredictable ID with a supported server-side primitive;
- return the ID in X-Request-Id;
- never log secrets, connection strings, request bodies, email content, tokens, SQL, or raw provider payloads.
Avoid unnecessary personal data and query-string logging. Do not add a second game/frontend event bus.
D. Health endpoint
Implement only app/api/v1/health/route.ts for GET /api/v1/health.
Before coding, read the complete health route entry in docs/BACKEND_API_CONTRACT.md. The B1 contract wins if it differs from examples in this spec.
Expected success shape:
{
  "status": "ok",
  "db": "ok",
  "version": "..."
}
Requirements:
- Return 200 only if required configuration is valid and a lightweight database connectivity check succeeds.
- Use a minimal safe query such as SELECT 1 or an equivalent Prisma-supported check.
- Use a bounded timeout if the current stack supports it cleanly; otherwise document the limitation and implement the safest available approach.
- On configuration/database failure, return the status and minimal safe body required by B1.
- Never return stack traces, SQL, connection strings, database names, host details, raw driver errors, or secrets.
- Log sanitized error category plus request ID server-side.
- Set X-Request-Id on all handled success and failure responses.
- Use a safe, documented version source; do not expose environment dumps or sensitive deployment metadata.
- Do not add a diagnostics endpoint or any other API route.
5. Security and frontend boundaries
- Keep Prisma, pg, environment validation, and logger modules server-only.
- Never expose DATABASE_URL via NEXT_PUBLIC_*.
- Do not import server modules into client components, React UI, game/, or Phaser scenes.
- Do not implement auth, cookies, middleware, or player-specific APIs.
- Do not change gameplay, assets, UI, local profile behavior, route structure, or canvas lifecycle.
- Do not log stack traces or raw database errors in public responses.
6. Baseline before edits
1. Record Node.js/npm and installed Prisma versions.
2. Run the existing tests, TypeScript check, and production build sequentially; do not run tsc concurrently with next build.
3. Record baseline failures before editing.
4. Verify the B2 migration exists and inspect prisma migrate status.
5. Never use prisma migrate reset, drop tables, or another destructive database command.
6. If PostgreSQL is unavailable, report that honestly. Do not substitute a different database.
7. Tests and verification
Use the existing Vitest setup where practical. Add focused tests for:
- valid environment configuration;
- missing/invalid required variables with sanitized errors;
- assurance that secret values never appear in validation errors;
- structured log level and request ID fields without secret fields;
- valid and invalid incoming request-ID handling;
- health success response when DB check succeeds;
- safe failure response when DB check fails;
- X-Request-Id on handled success and failure;
- no stack trace, SQL, connection string, host details, or raw driver message in responses;
- server-only modules not imported into client/game bundles.
Use mocks for deterministic route tests as appropriate, and also perform a live connectivity check against the existing mailxp_dev database if available. Clearly distinguish mocked tests from live DB verification. Do not claim checks passed unless run. Do not add a large test framework just for this phase.
8. Required file changes
Expected new files, using names consistent with the existing project:
- app/api/v1/health/route.ts
- server-only Prisma client module (for example lib/server/prisma.ts)
- server-only environment validation module
- structured logger/request-ID utility
- focused tests.
Modify only when necessary:
- package.json and package-lock.json for compatible adapter dependencies;
- .env.example only for a genuinely new required variable;
- docs/BACKEND_ARCHITECTURE.md to record confirmed implementation details;
- docs/phase_b3.md by appending an execution record without deleting this spec;
- docs/B3_REPORT.md as the final report.
Do not change the B1 API contract unless a real contradiction is discovered. If so, stop and ask rather than silently changing a binding contract.
9. Explicitly out of scope
Do not implement:
- register/login/logout, password hashing, verification or reset;
- session cookies or auth middleware;
- /api/v1/me, game state, preferences, ledger, shop, or purchase routes;
- database writes or seed data;
- queues, outbox processing, workers, retries or SSE;
- Google OAuth, Gmail sync/callbacks, Gemini, Calendar or wallet;
- server-authoritative profile sync or login gate;
- Cloud Run deployment;
- frontend/game visual or behavioral changes.
10. Acceptance criteria
B3 is complete only if results are recorded honestly.
Runtime/config
- [ ] Stable Prisma 7.10.0 and @prisma/client versions are preserved.
- [ ] Compatible @prisma/adapter-pg and pg dependencies are pinned.
- [ ] Prisma Client uses the correct Prisma 7 PostgreSQL adapter API.
- [ ] Client/pool is reused during local development.
- [ ] Environment validation is server-only, sanitized, and does not break static frontend build due to runtime-only variables.
- [ ] .env.example has placeholders only; real .env values are not printed or committed.
Endpoint
- [ ] Only GET /api/v1/health is added.
- [ ] Success response matches the B1 contract and checks DB connectivity.
- [ ] Failure status/body follow B1 and expose no internal diagnostics.
- [ ] X-Request-Id is set on handled success and failure.
- [ ] Version source is safe and documented.
- [ ] Query timeout behavior is bounded or the limitation is documented.
Logging/security
- [ ] Structured logs include level and request ID.
- [ ] No secrets, SQL, stack traces, or email content are logged.
- [ ] Server modules are not imported into client/game code.
- [ ] No auth, provider, economy, profile, or other API routes exist from B3.
Regression
- [ ] Existing Vitest suite passes.
- [ ] TypeScript check passes.
- [ ] Production build passes, run sequentially after type-check.
- [ ] Prisma schema validation and migration status pass.
- [ ] Live DB connectivity result is recorded if PostgreSQL is available.
- [ ] /, /preview, game bridge and profile persistence behavior remain unchanged.
- [ ] Changed-file review confirms all changes are within scope.
If a criterion fails, document the failure and do not mark B3 complete.
11. docs/B3_REPORT.md required contents
Include:
1. Summary and completion status.
2. Baseline versions and command results.
3. Driver adapter versions and Prisma initialization design.
4. Environment variable names validated and validation timing (never values).
5. Logger format and request-ID policy.
6. Health endpoint success/failure contract and version source.
7. Unit-test results and live database check.
8. Test/type-check/build/migration verification.
9. Exact files created/changed.
10. Security review and limitations.
11. Confirmation no auth flows, other routes, provider integrations, or frontend/game changes were made.
12. Recommendation for B4.
13. Explicit stop pending user approval.
12. Stop conditions
Stop and ask the user before proceeding if:
- B1 health route contract conflicts with this spec;
- Prisma/adapter compatibility would require a major version change;
- migration is missing, drifted, or destructive repair appears necessary;
- secrets appear in tracked files or logs;
- implementation requires frontend/Phaser architecture changes;
- a broad-impact dependency or unresolved security decision is needed.
After B3, do not start B4. Present docs/B3_REPORT.md, summarize actual test results, and wait for explicit approval.

13. B3 execution record (2026-10-10)
Status: EXECUTED — stopped per section 12, awaiting approval to proceed to B4.

Preflight: read all listed docs (B0/B1/B2 reports, master requirements, phase plan, architecture, B1 contract, this spec); package.json/lockfile/tsconfig/.gitignore, prisma/schema.prisma, prisma.config.ts, migration SQL, .env.example, game/profile* trio, app routes and test/build configuration inspected. Baseline recorded SEQUENTIALLY (per §6): node v24.19.0, npm 11.17.0, prisma/@prisma/client 7.10.0; vitest 20/20; tsc 0; next build 0; migrate status up to date; PostgreSQL Running; app/ had no API routes.

User decisions at B3 (before build mode): version field sourced from package.json; database probe timeout 2 s; logger always JSON lines; live dev-server verification approved and performed.

Work performed: installed @prisma/adapter-pg@7.10.0 + pg (runtime) and @types/pg (dev); read the INSTALLED adapter .d.ts and used its actual Prisma 7 API (no v5/v6 examples copied). Created lib/server/env.ts (lazy, sanitized validation of DATABASE_URL only), lib/server/logger.ts (JSON-line logger with defensive secret-key drop + resolveRequestId policy), lib/server/prisma.ts (lazy getDb singleton, globalThis hot-reuse, pool never per-request), app/api/v1/health/route.ts (force-dynamic, SELECT 1 with 2 s bound, B1 envelope on failure, X-Request-Id everywhere, package.json version), and four test files (env, logger, health route mocked, server-only static scan). vitest.config.mts gained the "@" alias (mirroring tsconfig) and widened includes.

Deviation notes: (1) Next's ProcessEnv type augmentation requires NODE_ENV, so loadServerEnv's source parameter is typed Record<string,string|undefined> (process.env still the default) — no behaviour change. (2) The offline migrate-diff quirk from B2 did not matter here; no schema changes were made. (3) Two test-code bugs were found and fixed during the phase (a console-spy recursion in the logger test, and a redaction-regex gap for camelCase databaseUrl) — product code was not at fault; the regex was broadened as the product fix.

Verification performed: npx vitest run = 38/38 (5 files: 20 B2 + 18 B3); npx tsc --noEmit = 0; npx next build = 0 WITH .env and again with .env temporarily moved aside (proving runtime-only secrets cannot break the build; .env restored and re-verified present); prisma validate = valid; prisma migrate status = up to date; LIVE check with npm run dev: GET /api/v1/health returned HTTP 200, body {"status":"ok","db":"ok","version":"0.1.0"}, X-Request-Id header present (fresh UUID), and / + /preview both still 200; server stopped afterwards. Destructive commands (migrate reset/drop) were never used.

Out of scope honored: no auth, sessions, cookies, middleware, me/game/shop routes, DB writes or seeds, queues/worker/SSE, Google/Gmail/Gemini/Calendar/wallet, deployment, or any frontend/game change. Only one route exists: GET /api/v1/health.

Files: exact list in docs/B3_REPORT.md §9.
B3 completion means a verified backend foundation and health endpoint only. It does not mean authentication or the rest of the backend is implemented.