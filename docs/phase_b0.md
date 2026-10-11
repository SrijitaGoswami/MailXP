MailXP — Phase B0: Read-Only Discovery and Backend Planning
Phase ID: B0
Status: Ready for execution after the user places the four master planning documents in docs/
Mode: Documentation-only / read-only application inspection
Primary rule: Do not modify application code during B0.
1. Objective
Inspect the actual MailXP repository and prepare an implementation-ready, dependency-ordered backend plan that reconciles the real codebase with the existing frontend documentation and these backend planning documents:
- docs/MASTER_REQUIREMENTS.md
- docs/BACKEND_PHASE_PLAN.md
- docs/BACKEND_ARCHITECTURE.md
- docs/BACKEND_API_CONTRACT.md
B0 must not assume the documentation perfectly matches the repository. The actual source code and project configuration are the evidence for current implementation state. Preserve the user's confirmed product decisions unless a real contradiction or technical blocker is identified; report conflicts explicitly rather than silently changing requirements.
2. Required preflight
Before making any changes:
1. Confirm the exact project root and current working directory.
2. Confirm that the project root is the user's existing MailXP project, not a new or nested accidental project.
3. Inspect the actual file tree and package scripts.
4. Check for an existing docs/phase_b0.md or docs/B0_REPORT.md; read them before considering replacement.
5. Check for any existing backend code, backend planning documents, auth, persistence, API routes, integrations, environment examples, and tests.
6. Read, if present:
   - context.md
   - frontend_file_structure.md
   - docs/FRONTEND_PHASE_PLAN.md
   - docs/PHASE_7_REPORT.md
   - docs/MASTER_REQUIREMENTS.md
   - docs/BACKEND_PHASE_PLAN.md
   - docs/BACKEND_ARCHITECTURE.md
   - docs/BACKEND_API_CONTRACT.md
7. Inspect package.json, lockfile, app/router structure, game/bridge.ts, Phaser bootstrap/scene lifecycle, current local persistence, /preview, asset paths, and existing verification scripts.
8. Never display or copy secret values. If environment files exist, report only their names and whether they appear present; do not print their contents.
If the project root cannot be confirmed, stop and ask the user to open the correct folder. Do not guess.
3. Hard constraints
- Do not create, edit, delete, rename, or move application source files.
- Do not install, remove, or update dependencies.
- Do not run database migrations, deployments, OAuth flows, provider calls, or commands that mutate state.
- Do not start implementation of B1 or later phases.
- Do not rewrite frontend docs or replace existing reports without inspecting them and explaining the need.
- Do not change existing game assets, especially anything under public/assets/mailxp/.
- Preserve /preview, sound, accessibility, touch support, and existing frontend behavior.
- Phaser canvas must mount once and must not be reset/unmounted due to React or backend work.
- React/Phaser communication must continue through the existing game/bridge.ts; do not propose a second event bus.
- Keep network and asynchronous work outside OfficeScene.update().
- Preserve SSR/hydration safety.
- Do not assume old “no backend” wording in a legacy context document overrides the newer approved requirement to add a backend. Record it as a documentation conflict and recommend an explicit update in a later documentation-approved step.
- Do not infer that any feature is implemented just because it appears in a plan.
4. Required inspection and analysis
4.1 Current-state inventory
Produce a concise inventory of:
- Frontend framework/runtime and package versions
- Routing and API route structure
- Phaser initialization and React integration
- Existing bridge/events
- Current profile/progression state and persistence mechanism
- Existing authentication or backend services, if any
- Existing tests/build/lint/type-check commands
- Relevant environment variable names only, never values
- Existing documents and phase reports
- Relevant source files inspected
Use exact paths from the repository. Distinguish verified present, documented but not found, not inspected, and unknown.
4.2 Requirements reconciliation
Compare the repository and documents against the requirements in MASTER_REQUIREMENTS.md. Identify:
- Existing functionality that can be preserved
- Gaps that require backend implementation
- Conflicts between code and documents
- Decisions already confirmed by the user
- Decisions that remain open
- Dependencies and risks between features
Do not implement or silently resolve conflicts during B0.
4.3 Architecture decisions to prepare
For each decision below, provide the recommended option, rationale, alternatives, impact, and whether it blocks B1 or a later phase. If the actual repository or requirements do not support a confident recommendation, mark it OPEN — USER DECISION REQUIRED.
- Backend placement: inside the existing repository or separate service/repository
- API route conventions and versioning
- Authentication/session approach
- PostgreSQL access and migration tooling
- Durable queue and scheduled work strategy
- Transactional outbox or equivalent reliable dispatch approach
- Google OAuth scope and token lifecycle boundaries
- Realtime profile/notification updates (polling, SSE, WebSocket, or managed alternative)
- Gemini provider adapter, structured output, and usage accounting
- Logging, metrics, tracing, secret management, and environments
- Local cache versus server-authoritative data migration
- API error envelope, pagination, and idempotency conventions
Do not present illustrative routes from BACKEND_API_CONTRACT.md as finalized endpoints until B1 approves them.
5. B0 deliverables
Create or update only planning documents in the existing docs/ directory. Do not touch application source code.
A. docs/MASTER_REQUIREMENTS.md
- Preserve the confirmed requirements.
- Add a brief reconciliation note if actual code/docs reveal gaps or contradictions.
- Do not silently weaken a requirement.
- Keep unresolved decisions visibly marked.
B. docs/BACKEND_PHASE_PLAN.md
- Produce the final proposed phase sequence based on actual dependencies.
- Each phase must have goal, scope, prerequisites, deliverables, verification, exit criteria, and explicit out-of-scope items.
- Keep phases small enough to implement and verify independently.
- Avoid doing all phases in one run.
- Mark any scope changes and rationale.
C. docs/BACKEND_ARCHITECTURE.md
- Reconcile logical components with the actual repository and deployment direction.
- Document trust boundaries, data ownership, background work, failure/retry behavior, privacy, approval state, and economy consistency.
- Clearly separate confirmed decisions from recommendations and open decisions.
D. docs/BACKEND_API_CONTRACT.md
- Keep endpoint proposals marked draft unless they are actually approved.
- Identify API domains and define what must be finalized in B1.
- Do not claim endpoints already exist unless verified in source.
- Do not invent exact schemas where requirements are insufficient.
E. docs/phase_b0.md
- Record the actual B0 scope and findings.
- Include the verified project root, inspection date, inspected files, current architecture, constraints, decisions, risks, open questions, and exit checklist.
- If the file already exists, inspect and update only if needed; do not overwrite valuable prior content blindly.
F. docs/B0_REPORT.md
- Record an executive summary, current-state inventory, documents reconciled, files created/updated, conflicts, recommendations, unresolved decisions, checks performed, and explicit confirmation that application code was not changed.
- If a command was not run, say so.
- If build/tests were not run because B0 is read-only, state that clearly.
- If no code was modified, do not claim build verification or implementation success.
6. Verification
Because B0 is read-only for application code:
- Prefer read-only inspection commands.
- Do not install dependencies.
- Do not run commands known to write build artifacts or modify the project unless they are already known to be safe and strictly necessary; generally, do not run the build during B0.
- Verify all referenced file paths exist before describing them as present.
- Verify all new/updated Markdown files are readable and consistent with one another.
- Ensure the phase plan and API contract distinguish confirmed decisions from provisional proposals.
- Ensure no application source, game assets, dependency files, or environment files were changed.
7. B0 report template
docs/B0_REPORT.md must contain:
1. Summary
2. Project root and inspection date
3. Files inspected
4. Verified current architecture
5. Existing features and persistence
6. Documentation/code conflicts
7. Requirements reconciliation
8. Architecture decisions and alternatives
9. Recommended phase order and dependencies
10. Open decisions requiring user approval
11. Files created or updated
12. Verification performed and not performed
13. Confirmation that application code/dependencies/assets were not changed
14. Recommended next action
15. Stop point awaiting explicit user approval
8. Exit criteria
B0 is complete only when:
- The actual project root was confirmed.
- Existing project docs and source architecture were inspected.
- Requirements and documentation conflicts are reported.
- The four master documents are reconciled with actual repository evidence.
- The phase roadmap is dependency-ordered and each phase has measurable exit criteria.
- Unresolved decisions are clearly marked, with the affected phase identified.
- docs/phase_b0.md and docs/B0_REPORT.md exist and accurately describe what was done.
- No application source, dependencies, game assets, secrets, or runtime data were modified.
- The report explicitly recommends whether B1 is ready to begin.
9. Stop condition
After producing the B0 documents and report, STOP. Do not begin B1, create implementation code, install dependencies, or make infrastructure changes. Present the report and wait for the user's explicit approval to proceed.

10. B0 execution record (2026-10-10)
Status: EXECUTED — documentation-only; stopped per section 9, awaiting approval to proceed to B1.
Project root: C:\Users\manik\Desktop\MailXP (confirmed; existing MailXP, not a nested repository).

Scope performed:
- Read this specification, docs/MASTER_REQUIREMENTS.md, docs/BACKEND_PHASE_PLAN.md, docs/BACKEND_ARCHITECTURE.md, docs/BACKEND_API_CONTRACT.md in full.
- Read context.md, frontend_file_structure.md, docs/FRONTEND_PHASE_PLAN.md, docs/PHASE_7_REPORT.md, package.json, game/profile.ts, game/bridge.ts, README.md, .gitignore, CLAUDE.md/AGENTS.md.
- Inspected repository tree: app/ (layout, page, preview), components/, game/, public/assets/mailxp/, scripts/, docs/. Confirmed NO backend code: no app/api, no .env* files, no prisma/, no server/, no backend/. Not a git repository (no .git). No test framework; verification is `npx tsc --noEmit`, `npx next build`, scripts/*.ps1.

Decisions confirmed by the user at B0 (recorded in all four master docs):
1. Backend placement: inside this repository (Next.js route handlers + service modules, one Cloud Run deployable).
2. Auth: custom sessions (email+password, httpOnly cookie, users/sessions tables, bcrypt; Google OAuth hand-flow in B8).
3. Local database: native PostgreSQL on Windows — user explicitly rejects Docker; Prisma recommended (confirm at B2 entry).
4. Login gate: register/sign in before Play (frontend wiring scheduled B5; Phaser canvas still mounts once behind the gate).
5. Realtime: SSE with refetch-on-reconnect (formalize B1, implement B5).
6. Queue: transactional DB outbox + DB-backed queue + worker (B7); Cloud Tasks deferred to production if needed.
7. Google Cloud project + Gemini API key: available/planned — B8/B10 not credential-blocked.

Conflicts/gaps found (reported, not silently resolved):
- Legacy "no backend" wording in context.md (lines 6, 13), README.md (line 88), docs/FRONTEND_PHASE_PLAN.md (5 places) and historical phase reports — does not override MASTER_REQUIREMENTS; live-doc cleanup is a separate documentation-approved step; historical reports stay untouched as records.
- XP/level/mailCount/quest progress are ephemeral in bridge state while DraftCoin persists in localStorage — requirement 8.1 conflict; B2 must decide how stats enter the saved profile.
- Quest/shop rewards are client-side today (game/profile.ts + OfficeScene.ts call sites) — become development-only fixtures until B11 evidence exists (B6 scope).
- Frontend has no auth UI at all; login gate is new frontend work (B5).
- Encoding incident during editing: an ANSI-encoded append into docs/BACKEND_ARCHITECTURE.md was truncated and rewritten as UTF-8 in the same session; final file verified clean.

Files created/updated by B0 (docs only): docs/MASTER_REQUIREMENTS.md, docs/BACKEND_PHASE_PLAN.md, docs/BACKEND_ARCHITECTURE.md, docs/BACKEND_API_CONTRACT.md, docs/phase_b0.md (this record), docs/B0_REPORT.md.
Not performed: any application source change, dependency installation, migration, deployment, provider API call, secret creation.

Exit checklist: root confirmed ✓ · docs/source inspected ✓ · conflicts reported ✓ · four master docs reconciled with evidence ✓ · roadmap dependency-ordered with measurable exit criteria ✓ · unresolved decisions marked with affected phase ✓ · phase_b0.md + B0_REPORT.md exist ✓ · no application source/deps/assets/secrets/runtime data modified ✓ · report recommends whether B1 is ready ✓.