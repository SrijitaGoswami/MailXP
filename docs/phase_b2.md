MailXP — Phase B2: Data Model and Persistence Adapter
Phase: B2
Type: Database foundation + safe persistence-seam refactor
Status: Ready for execution only after explicit user approval
Prerequisites: B0 and B1 complete; B1 contract reviewed; native PostgreSQL installed on Windows
Critical rule: Do not start B3 or implement API routes during B2.
1. Objective
Prepare MailXP's data model and persistence boundary so later backend phases can become server-authoritative without breaking the existing Phaser game or changing current player-visible behavior.
B2 is not the backend launch phase. It should establish:
- a reviewed database model for player/profile/economy data;
- Prisma and PostgreSQL foundations;
- migrations for the approved schema;
- a persistence adapter around the existing game/profile.ts seam;
- tests proving that the current local-first behavior remains unchanged.
2. Read these files first
From the MailXP project root, read:
- docs/B0_REPORT.md
- docs/B1_REPORT.md
- docs/MASTER_REQUIREMENTS.md
- docs/BACKEND_PHASE_PLAN.md
- docs/BACKEND_ARCHITECTURE.md
- docs/BACKEND_API_CONTRACT.md
- docs/phase_b2.md
- game/profile.ts
- current game/profile consumers and relevant package/build configuration.
If a required document is missing, stop and report it; do not recreate it from guesses.
3. Scope allowed in B2
A. Confirm and document the data model
Design the first migration-ready schema for the data that already exists and the minimum identity/session/economy foundation needed by later phases. Keep future Gmail, Gemini, Calendar, and wallet tables out of scope unless the architecture explicitly requires a placeholder; do not prematurely implement deferred product families.
At minimum, review whether the schema needs:
- User / player identity with stable internal ID, email, password hash, verification timestamps and lifecycle fields;
- Session with hashed session-token representation, expiry, revocation and user relation;
- PlayerProfile or equivalent server-owned game state;
- normalized PlayerPreferences or a validated JSON preferences field, with an explicit whitelist;
- InventoryItem / owned cosmetic state and equipped outfit;
- placed decoration state;
- a version field for optimistic concurrency;
- timestamps and appropriate uniqueness/indexes.
B2 must document which profile fields are normalized columns/tables and which are JSON, and why. Do not put secrets, raw session tokens, email bodies, OAuth tokens, or provider payloads into generic profile JSON.
B. Resolve the B1 open choices explicitly
Record the decisions in the B2 report and the architecture/schema docs:
1. ORM: confirm Prisma unless a concrete incompatibility is found.
2. IDs: use UUIDv7 only if the selected implementation is supported and maintainable in the current runtime/toolchain. If not, stop and present the exact compatibility issue and safest alternative before implementing.
3. Stats shape: preserve existing stats and ephemeral values accurately. Inspect actual consumers before deciding persisted vs derived vs ephemeral.
4. Preferences: enumerate allowed preference keys from the existing app; validate values and preserve defaults. Do not invent settings.
5. PostgreSQL: use a native local PostgreSQL installation on Windows; Docker is not part of this phase.
6. Existing profile compatibility: keep the legacy mailxp.profile.v1 data readable during this phase. Do not silently delete or destructively rewrite localStorage.
Do not silently make a product decision where the existing code/docs do not provide evidence. List unresolved decisions and stop for the user where needed.
C. Persistence adapter refactor — zero behavior change
Refactor only the existing game/profile.ts persistence seam and the minimum imports/call sites required to route persistence through a small adapter. Keep the current localStorage implementation as the active adapter in B2.
Requirements:
- preserve the current public API where practical; document any necessary signature change before making it;
- preserve current defaults and migrations for draftCoin, ownedItems, equippedOutfit, placedDecor, and prefs;
- do not accidentally make ephemeral XP, level, mailCount, or quest progress persistent unless the current code and approved requirements explicitly require it;
- no network requests from the adapter in B2;
- no React/Phaser bridge redesign and no second event bus;
- do not move work into OfficeScene.update();
- preserve the one-time Phaser canvas mount and hydration safety;
- do not change gameplay, rewards, shop pricing, UI, routes, or visual design;
- avoid changing unrelated files.
The adapter must make it possible for a later phase to introduce a server-backed implementation without requiring a rewrite of all game components. B2 must not activate a server adapter that does not exist yet.
D. Prisma and migrations
- Install only dependencies needed for the approved Prisma/PostgreSQL foundation.
- Add a safe .env.example with variable names and placeholders only. Never add real credentials.
- Ensure .env* secrets remain ignored by Git.
- Define a local DATABASE_URL example for native PostgreSQL without embedding a real password.
- Generate the initial Prisma schema and migration only after the schema is reviewed.
- Do not run destructive resets, drop tables, delete user data, or use a command that wipes a database.
- Do not create API handlers, session cookies, password hashing flows, background workers, Gmail connections, or server routes in B2.
4. Explicitly out of scope
Do not implement:
- /api/v1/** endpoints or health route;
- registration, login, logout, email verification, password reset, or sessions at runtime;
- server-authoritative profile sync or login gate;
- reward issuance, economy ledger, purchases or inventory API;
- queue workers, outbox processing, SSE, Google OAuth, Gmail, Gemini, Calendar or Pera Wallet;
- production Cloud Run deployment;
- visual redesign or changes to the main website/game experience.
Those belong to later phases.
5. Required safety and implementation process
1. Inspect actual code and documents before editing.
2. Establish a baseline: run the existing package scripts that are available for type-check/build/tests and record results before changes.
3. If PostgreSQL is not installed or unavailable, stop before migration validation; do not substitute SQLite silently.
4. Present the proposed schema and field mapping in the report before irreversible or data-affecting steps.
5. Make changes in small steps.
6. Re-read every changed file and inspect the diff.
7. Do not claim a check passed unless it was actually run.
8. If any existing data shape or behavior is unclear, preserve it and report the uncertainty.
9. Do not create or commit a Git repository; B0 says the project currently is not a Git repository.
10. Stop after B2 and wait for explicit approval before B3.
6. Acceptance criteria
B2 is complete only when all applicable checks are recorded honestly:
Data model
- [ ] Prisma schema matches the approved model and B1 contract boundaries.
- [ ] IDs, uniqueness constraints, relations, indexes, deletion behavior and version fields are documented.
- [ ] Preferences have a specific allowlist and validation rules.
- [ ] Persistent vs ephemeral game state is documented field by field.
- [ ] No secrets or email content are stored in generic profile data.
Persistence compatibility
- [ ] Existing localStorage key mailxp.profile.v1 remains readable.
- [ ] Existing saved profile fields and defaults are preserved.
- [ ] Corrupt/old profile handling is no worse than baseline.
- [ ] The adapter performs no network calls and has no backend dependency.
- [ ] Phaser canvas mount behavior, React/Phaser bridge, routes and visual output remain unchanged.
Database/tooling
- [ ] Prisma schema validation passes.
- [ ] Migration is generated and applied to the intended local development database only, if PostgreSQL is available.
- [ ] No destructive database reset was used.
- [ ] .env.example contains placeholders only; real .env secrets are not reported or printed.
- [ ] package scripts and dependency changes are documented.
Regression
- [ ] Existing lint/type-check/build/test commands are run where available.
- [ ] Profile round-trip tests cover defaults, save/load, legacy data, malformed data and all persisted fields.
- [ ] Any baseline failures are separated from new failures.
- [ ] Changed-file list and diff review are included in docs/B2_REPORT.md.
If database setup cannot be completed, distinguish schema/adapter work from database-verified work and stop rather than pretending migrations were applied.
7. Required outputs
Create/update only these project files unless a code change is required for the approved scope:
- prisma/schema.prisma
- prisma/migrations/** (initial migration, if database setup is available)
- .env.example
- minimal Prisma/package configuration
- the small persistence-adapter refactor and focused tests
- docs/BACKEND_ARCHITECTURE.md only if a confirmed decision requires a precise update
- docs/phase_b2.md (append execution record; preserve this specification)
- docs/B2_REPORT.md
Do not rewrite the master requirements or B1 API contract merely for style.
8. B2 report format
docs/B2_REPORT.md must include:
1. Summary and completion status.
2. Baseline and post-change commands/results.
3. Confirmed schema and field mapping.
4. Prisma, ID strategy and PostgreSQL setup decisions.
5. Persistent vs ephemeral game-state table.
6. Adapter design and localStorage compatibility details.
7. Migration name and whether it was actually applied.
8. Tests performed and not performed.
9. Exact files changed.
10. Risks, unresolved decisions and anything blocked.
11. Explicit statement confirming no API routes, auth flows or provider integrations were implemented.
12. Recommendation for B3.
13. Explicit stop awaiting user approval.
9. What should be visible on the main website after B2?
Expected: effectively no visible change. The homepage/game should look and behave as it did before B2. There should be no login screen, no Gmail inbox, no AI summaries, no new profile page, no new backend-connected balance, and no Google integration yet.
The visible result is mainly engineering readiness:
- existing game still loads and plays;
- existing local profile/economy data still behaves as before;
- saved local profile still loads through the new adapter;
- no backend network calls are introduced;
- the codebase is prepared for later server-backed persistence.
If the main website looks different or the game resets after B2, treat that as a regression to fix before accepting the phase.
10. Next phase preview
After B2 is approved, B3 creates the backend application skeleton and health endpoint. B4 implements account/auth lifecycle. B5 connects server-authoritative game state and introduces the login gate while preserving the one-time Phaser mount. Gmail/Gemini work comes much later (B8–B11).
Stop condition: Once B2 report and checks are complete, stop and ask for explicit approval before B3.

11. B2 execution record (2026-10-10)
Status: EXECUTED — stopped per section 10, awaiting approval to proceed to B3.

Preflight: read docs/B0_REPORT.md, docs/B1_REPORT.md, docs/MASTER_REQUIREMENTS.md, docs/BACKEND_PHASE_PLAN.md, docs/BACKEND_ARCHITECTURE.md, docs/BACKEND_API_CONTRACT.md, docs/phase_b2.md, game/profile.ts and all profile consumers (grep of prefs usage across components/game); package/build configuration inspected; baseline recorded BEFORE changes: `npx tsc --noEmit` = 0 errors, `npx next build` = 0 errors (4/4 static pages).

User decisions collected at B2 (before build mode):
1. PostgreSQL prerequisite: user installed the EDB Windows package (PostgreSQL 18, service postgresql-x64-18) during the phase; port 5432 confirmed listening.
2. Secrets: user created .env themselves; the phase only wrote .env.example (placeholders). The real .env value was never read, printed, or stored by the agent (key-presence checked with -Quiet boolean only).
3. ORM: Prisma — confirmed. npm's `latest` served prisma@8.0.0-rc.22 (RC, platform-centric CLI) with a mismatched @prisma/client@7.10.0; deliberately pinned BOTH to stable prisma@7.10.0 + @prisma/client@7.10.0, and reverted the v8 `prisma init` artifacts (prisma.config.ts scaffold, agent-skills directories, postinstall script) before proceeding.
4. Stats shape: xp/level/mailCount/quest progress stay EPHEMERAL through B2 (zero visible change); server persistence deferred to B5.
5. Test runner: Vitest (dev dependency; `npm test` script added).

Toolchain divergences from this spec's wording (documented, not silent): Prisma 7 rejects `url = env(...)` inside the schema datasource — the migrate URL now lives in prisma.config.ts (written with Node-native process.loadEnvFile() and a conditional datasource so schema-only commands work before .env exists); `migrate diff --to-schema-datamodel` was renamed `--to-schema`, and the offline `--script` preview produced an empty result under prisma 7.10/Node 24/Windows PowerShell (inconclusive offline) — the generated migration.sql was instead reviewed directly after `migrate dev`. Client generation is explicit (`prisma generate`) and outputs to node_modules/@prisma/client.

Work performed: prisma/schema.prisma authored (User, Session, PlayerProfile, InventoryItem; UUIDv7 defaults; JSON-vs-relational decisions documented in-schema); `npx prisma validate` = valid; persistence adapter game/profileStorage.ts added and game/profile.ts routed through it (public API unchanged, zero consumer changes); vitest.config.mts + game/profile.test.ts (20 tests) added; migration 20261010064923_init_b2 created AND applied to mailxp_dev on PostgreSQL 18.6 (Prisma created the database), `prisma migrate status` = up to date, client generated.

Post-change verification: `npx vitest run` = 20/20 passed; `npx tsc --noEmit` = 0 errors; `npx next build` = 0 errors (one tsc run during the phase reported a .next/types race artifact because tsc and build were executed concurrently; a sequential re-run was clean — no code cause). Test-fix notes: two initial failures were bugs in the TEST code (a module-registry mismatch across vi.resetModules, and a test adapter that returned a JSON string instead of the parsed value per the ProfileStorage contract) — both fixed in the tests; product code needed no fix.

Out of scope honored: no /api routes, no auth/session flows, no server-authoritative sync, no economy/ledger/queue/SSE/OAuth/Gmail/Gemini/Calendar/wallet code, no deployment, no visual changes. Visible result on the website: none (game, menu, shop, decor, settings behave as before; saved local profile loads through the new adapter).

Files: see docs/B2_REPORT.md §9 for the exact list.