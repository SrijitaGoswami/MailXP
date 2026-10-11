MailXP — Phase B2 Report
1. Summary and completion status
B2 (Data Model and Persistence Adapter) completed on 2026-10-10. The first database schema (User, Session, PlayerProfile, InventoryItem) was authored in Prisma, validated, and applied to a real local PostgreSQL 18.6 database as migration 20261010064923_init_b2; the Prisma client was generated. The localStorage seam in game/profile.ts now routes through a synchronous ProfileStorage adapter (game/profileStorage.ts) with the public API unchanged — zero consumer changes, zero behavior change, proven by 20 passing round-trip tests plus green type-check and build. Status: COMPLETE and STOPPED per spec §10 — awaiting approval before B3.

2. Baseline and post-change commands/results
Baseline (before any change):
- `npx tsc --noEmit` → 0 errors
- `npx next build` → 0 errors (compiled, 4/4 static pages, routes / /_not-found /preview)
Post-change (after all work):
- `npx vitest run` → 20/20 tests passed (1 file)
- `npx tsc --noEmit` → 0 errors
- `npx next build` → 0 errors (identical route output)
- `npx prisma validate` → "The schema is valid"
- `npx prisma migrate dev --name init_b2` → database mailxp_dev created, migration created and applied, "database is now in sync"
- `npx prisma migrate status` → "Database schema is up to date!"
- `npx prisma generate` → Prisma Client v7.10.0 generated to node_modules/@prisma/client
- Live DB check (psql, password sourced from .env at runtime, never printed): PostgreSQL 18.6, database mailxp_dev, tables User/Session/PlayerProfile/InventoryItem + _prisma_migrations
Note: one mid-phase `tsc` run reported `.next/types/validator.ts` errors because tsc and `next build` were executed concurrently (tsc read files the build was rewriting); a sequential re-run was clean. No code cause; no baseline failure was masked.

3. Confirmed schema and field mapping (prisma/schema.prisma)
- User — id (UUIDv7 pk), email (unique), passwordHash, emailVerifiedAt?, deletionRequestedAt?, createdAt, updatedAt. One row per MailXP account (B4 fills it).
- Session — id (UUIDv7 pk), tokenHash (unique; raw token never stored), userId FK→User CASCADE, createdAt, lastSeenAt, expiresAt, revokedAt?; indexes on userId and expiresAt.
- PlayerProfile — id (UUIDv7 pk), userId (unique FK→User CASCADE), draftCoin Int default 0, equippedOutfit Text default "worker", placedDecor JSONB default '[]', prefs JSONB (required), version Int default 1 (optimistic concurrency per B1 contract), timestamps.
- InventoryItem — (profileId, itemId) composite PK, ownedSince, profileId FK→PlayerProfile CASCADE, index on itemId. The composite PK is the database-level "already owned" guarantee B6 purchases will lean on.
JSON-vs-relational rationale (also in-schema): placedDecor is JSONB because the app reads/writes the whole array atomically with order semantics and never queries per row; prefs is JSONB with a strict six-key application whitelist (masterVolume, uiVolume, gameVolume, muted, motion, touchControls — enumerated from actual code, nothing invented); ownedItems is a real table for the uniqueness constraint. No secrets, raw tokens, email bodies or provider payloads are stored anywhere in profile data.

4. Prisma, ID strategy and PostgreSQL setup decisions
- ORM: Prisma. npm's `latest` served prisma@8.0.0-rc.22 (a release candidate with a platform-centric workflow) alongside a mismatched @prisma/client@7.10.0 — both pinned to the stable prisma@7.10.0 + @prisma/client@7.10.0 pair, matching this spec's expected layout. The v8 `init` artifacts (scaffold config, agent-skill directories, postinstall hook) were reverted.
- Prisma 7 specifics discovered and handled: the schema datasource no longer accepts `url = env(...)` — the migrate connection URL lives in prisma.config.ts (written with Node's native process.loadEnvFile() and a conditional datasource so schema-only commands still work before .env exists); `migrate diff --to-schema-datamodel` was renamed `--to-schema`; the client is generated explicitly and lands in node_modules/@prisma/client.
- IDs: UUIDv7 via `@default(uuid(7))` (resolves B1's recommendation; supported on the confirmed toolchain). Defaults are client-generated (no DB-side DEFAULT) — all writes go through the Prisma client by design.
- PostgreSQL: native Windows install (EDB package, PostgreSQL 18, service postgresql-x64-18; user rejects Docker). Database mailxp_dev on localhost:5432 — Prisma created it during migrate dev. DATABASE_URL comes from .env, which the USER created from .env.example; its value was never read into, printed in, or stored by this session (only a boolean key-presence check was run).
- Known toolchain quirk: the offline `migrate diff --script` preview returned an empty diff under prisma 7.10/Node 24/Windows PowerShell; the migration SQL was instead reviewed directly from the generated migration.sql (all 76 lines match the designed schema).

5. Persistent vs ephemeral game-state table (unchanged from the player's perspective)
| Field | Where lives after B2 | Change? |
| draftCoin | localStorage profile (server: later B5/B6) | none |
| ownedItems | localStorage profile | none |
| equippedOutfit | localStorage profile | none |
| placedDecor | localStorage profile | none |
| prefs (6 keys) | localStorage profile | none |
| xp / level / mailCount | ephemeral bridge snapshot only | none — user decided at B2 they stay ephemeral; B5 makes them server-authoritative |
| quest progress | ephemeral bridge snapshot only | none — persists from B12 |
| Session/auth | not runtime yet (schema only) | n/a |

6. Adapter design and localStorage compatibility
- game/profileStorage.ts exports `ProfileStorage { kind: "local"; read(): unknown|null; write(profile): void }`, a ready-made `localStorageProfileStorage` (same key `mailxp.profile.v1`, same try/catch fallbacks, same SSR guard), `getProfileStorage()`, and `setProfileStorage()` (returns an idempotent restore; reserved for B5 integration and tests — application code never calls it in B2).
- game/profile.ts now reads via `getProfileStorage().read()` and persists via `.write()`; read()/persist() are the only touched internals. Public API (getProfile, getDefaultProfile, subscribeProfile, patchProfile, addDraftCoin, spendDraftCoin, ownsItem, purchaseItem, resetProfile and all types) is unchanged; no consumer file was modified.
- The seam is deliberately synchronous (getProfile runs during React render and Phaser reads) — a future server flow must prime a cache, not make reads await.
- Compatibility proven by tests: pre-B2 payloads load field-exact; corrupt JSON, non-object JSON, partial garbage and blocked storage all behave exactly as the old code did (per-field sanitisation, silent-failure fallbacks).

7. Migration name and application
- 20261010064923_init_b2 — CREATED AND APPLIED to mailxp_dev on PostgreSQL 18.6 (spec §6 fully satisfied; no database substitution, no SQLite). `prisma migrate status` confirms up to date; `_prisma_migrations` tracking table present. No destructive reset command was used at any point; the database was empty and newly created.

8. Tests performed and not performed
Performed: 20 Vitest tests in game/profile.test.ts (npm test / npx vitest run) — defaults; no-write-on-read; frozen server snapshot; full-field round-trip with simulated reload; prefs merge semantics; legacy v1 payload; corrupt/non-object JSON; per-field sanitization of a partially-broken profile (each field case); balance flooring; economy helpers (add clamp, spend guard, purchase ok/owned/insufficient, implicit worker ownership, reset); subscriber notify/unsubscribe idempotence; SSR no-window path; setItem-throws path; adapter default identity; injected-adapter read/write routing with restore (B5 swap preview). Two early failures were TEST-code bugs (module-registry mismatch across vi.resetModules; a test adapter returning a JSON string instead of the parsed value the contract requires) — fixed in tests; product code never needed a fix for them.
Not performed: no E2E/browser test (no behavior to observe — nothing visible changed); no DB-integration tests (Prisma client queries belong to B3/B4 once server code exists); no lint (no lint script exists in this project); no performance testing.

9. Exact files changed
Created: prisma/schema.prisma · prisma/migrations/migration_lock.toml · prisma/migrations/20261010064923_init_b2/migration.sql · prisma.config.ts · .env.example · game/profileStorage.ts · game/profile.test.ts · vitest.config.mts · docs/B2_REPORT.md (this file)
Modified: game/profile.ts (adapter routing + header note; public API identical) · package.json (deps: prisma, @prisma/client, vitest; script: "test"; the transient v8 postinstall hook removed) · package-lock.json (npm-managed) · .gitignore (allowlist .env.example while .env* stays ignored) · docs/BACKEND_ARCHITECTURE.md (B2 decisions recorded: Prisma 7.10, stats ephemeral, UUIDv7, adapter seam) · docs/phase_b2.md (execution record appended)
User-created: .env (by the user, from .env.example — value never accessed by the agent)
Database-side: database mailxp_dev; tables User, Session, PlayerProfile, InventoryItem, _prisma_migrations
Diff review: every changed file was re-read after editing; profile.ts diff is limited to the two storage functions, one import and the header comment.

10. Risks, unresolved decisions and anything blocked
- Prisma 7 runtime wiring (B3): PrismaClient now requires a driver adapter (@prisma/adapter-pg + pg) or accelerateUrl — new runtime dependencies to install and report in B3; nothing in B2 imports the client yet.
- Offline `migrate diff --script` empty-output quirk (see §4): future phases should review SQL from the generated migration files rather than the offline preview.
- npm allow-scripts warnings: several dependency postinstall scripts (esbuild, @prisma/engines, workerd, better-sqlite3 from transitive dev deps) are pending approval; Prisma CLI and Vitest both work, so none blocks B2 — owner may run `npm approve-scripts` if desired.
- frontend_file_structure.md now predates the profileStorage adapter seam; per the ownership matrix it gets refreshed at the B5 wiring phase (not edited here — out of B2's allowed file list).
- Stats persistence shape and the B6 idempotency/ledger tables remain as planned future work (B5/B6), not losses.
Nothing is blocked.

11. Confirmation: no API routes, auth flows or provider integrations
Confirmed — none were implemented. No file exists under app/api; no session cookie, password hashing, registration, login, verification, or reset flow was written; no queue/worker/SSE/OAuth/Gmail/Gemini/Calendar/wallet code exists; no deployment or configuration for any provider was added. The Prisma schema is inert data modeling until B3/B4 write server code against it. The main website is visually and behaviorally unchanged.

12. Recommendation for B3
B3 (backend skeleton + health endpoint) is ready to start after approval. It should: install and wire the Prisma 7 driver-adapter pair (@prisma/adapter-pg + pg — reported as dependency changes), add app/api/v1/health/route.ts per the B1 contract (GET → { status, db, version }), introduce env validation with clear startup errors, structured logging with request correlation, and a minimal server-only lib location — while re-running the B2 test suite and tsc/build to prove zero frontend regression. Consider also adding the B2 round-trip suite to a habit-level `npm test` gate before any B3+ change.

13. Explicit stop awaiting user approval
STOPPED per spec §10. No B3 work has begun: no API routes exist, no auth code exists, no server lib exists. The schema, applied migration, adapter refactor, tests, and this report are presented for review; reply with explicit approval (or amendments) before B3 begins.
