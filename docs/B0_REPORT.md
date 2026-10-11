MailXP — Phase B0 Report
1. Summary
Phase B0 (read-only discovery and backend planning) was executed on 2026-10-10. The repository was inspected as evidence, seven product/architecture decisions were confirmed by the user, and the four master planning documents were reconciled with the actual codebase and updated in place. The phase roadmap (B0–B15) is finalized with per-phase prerequisites, verification, exit criteria, and explicit out-of-scope items. No application code, dependency, asset, environment file, or runtime data was created, modified, or deleted. B0 stops here per docs/phase_b0.md §9 and awaits explicit approval before B1.

2. Project root and inspection date
Project root: C:\Users\manik\Desktop\MailXP
Inspection date: 2026-10-10
Not a git repository (no .git) — change verification is by tool-call record (every write in B0 targeted docs/*.md only).

3. Files inspected
- Planning: docs/phase_b0.md, docs/MASTER_REQUIREMENTS.md, docs/BACKEND_PHASE_PLAN.md, docs/BACKEND_ARCHITECTURE.md, docs/BACKEND_API_CONTRACT.md, docs/FRONTEND_PHASE_PLAN.md, docs/PHASE_7_REPORT.md, context.md, frontend_file_structure.md, README.md
- Configuration: package.json, tsconfig.json, .gitignore, CLAUDE.md, AGENTS.md
- Source: app/ (layout.tsx, page.tsx, preview/page.tsx), components/AppShell.tsx, components/GameMenu.tsx, components/PhaserCanvas.tsx, components/screens/*, game/profile.ts, game/bridge.ts, game/createGame.ts, game/config.ts, game/flow.ts, game/scenes/OfficeScene.ts, scripts/*.ps1, scripts/verify-atlas-parse.js
- Environment/repository state: no .env* files anywhere; no app/api/, prisma/, server/, backend/ directories; public/assets/mailxp/ present and untouched.

4. Verified current architecture
- Single Next.js (App Router) application, client-heavy, three routes: / (game), /preview (debug), root layout. No API routes, no server logic, no database.
- React↔Phaser integration: components/PhaserCanvas.tsx mounts Phaser exactly once; game/bridge.ts is the only typed event/snapshot channel; no second event system.
- Persistence seam: game/profile.ts — synchronous localStorage under "mailxp.profile.v1" (schema v1) with a sanitizer; single choke point for draftCoin, ownedItems, equippedOutfit, placedDecor, prefs.
- Economy today is client-side only (purchaseItem/spendDraftCoin/addDraftCoin in game/profile.ts; call sites in ShopScreen.tsx and OfficeScene.ts); OfficeScene.update() contains no network work (and must never gain any).
- Ephemeral state: xp, level, mailCount, quest progress live only in the bridge snapshot — not persisted anywhere.
- Verification tooling available: `npx tsc --noEmit`, `npx next build`, asset scripts under scripts/. No test framework exists.

5. Existing features and persistence
- Full-screen pixel office game with quests, shop, inventory, decorations, DraftCoin balance, sound, accessibility, touch support — all local.
- Only draftCoin/ownedItems/equippedOutfit/placedDecor/prefs persist (localStorage, schema v1 with versioned migration hook); stats/quest progress reset on reload.
- 4-quest demo loop awards coins client-side; shop purchases are optimistic local mutations with insufficient-funds guard.
- Network footprint: zero fetch/XHR to any API; no secrets; .gitignore already excludes .env*.

6. Documentation/code conflicts
- Legacy "no backend" wording exists in context.md (lines 6, 13), README.md (line 88), docs/FRONTEND_PHASE_PLAN.md (lines 26, 126, 147, 204, 235) and in historical phase reports. It does NOT override docs/MASTER_REQUIREMENTS.md. Historical reports remain untouched as records; updating the live docs is a separate documentation-approved step (listed in §10).
- XP/level/mailCount/quest progress are ephemeral while MASTER_REQUIREMENTS 8.1 requires PostgreSQL-authoritative progression — gap routed to B2 (how stats enter the saved profile) and B5 (sync authority).
- Quest/shop rewards are client-side today, conflicting with requirements 8.2–8.4 (rewards only from provider-verified actions) — routed to B6 with development-only fixtures until B11 evidence exists (B6 already reserves this).
- Frontend has no auth UI; requirement 3.1 (strict reading, user-confirmed: login gate before Play) requires new frontend work — scheduled in B5 with canvas/bridge invariants enforced.
- frontend_file_structure.md "Network today: Zero" remains factually accurate as of B0 and becomes stale by design at B5 (update belongs to that phase).

7. Requirements reconciliation
All confirmed product requirements in MASTER_REQUIREMENTS were preserved; nothing was weakened. Reconciliation actions taken:
- §10 queue OPEN DECISION → DECIDED at B0 (transactional DB outbox + DB-backed queue + worker; Cloud Tasks deferred to production; Pub/Sub deferred until fan-out need).
- §13 "Exact session/auth implementation" → CONFIRMED at B0 (custom sessions; no auth library/provider).
- New §14 "B0 reconciliation notes" records the seven user decisions and the four code-vs-requirement gaps with the phase that handles each.
- Every conflict is visible in a phase's scope; no requirement was silently dropped or reinterpreted.

8. Architecture decisions and alternatives
All seven were put to the user as explicit questions and answered (2026-10-10):
| Decision | Selected | Alternatives considered | Rationale / trade-off |
| Backend placement | Inside this repo (app/api/** + server-only service modules; one Cloud Run deployable) | Separate service/repo | No CORS/two-server overhead; shared types; simplest ops. Trade-off: larger single deployable — acceptable at this scale. |
| Auth | Custom sessions: email+password, httpOnly SameSite=Lax cookie, users/sessions tables, bcrypt; Google OAuth hand-flow in B8 | Auth.js (NextAuth v5); managed provider (Clerk etc.) | Full control, phase-by-phase verifiability, no library-compatibility risk with Next 16, no vendor dependence. Trade-off: we own reset/verification/rate-limit details — covered explicitly in B4 scope. |
| Local database | Native PostgreSQL installed on Windows; Prisma recommended (confirm at B2) | Docker Postgres (user rejects Docker); SQLite dev; hosted dev PG | Real Postgres locally = production parity for constraints/locking/migrations; no Docker, no external account, data stays local. Trade-off: one-time installer on the machine. |
| Login UX | Login gate before Play | Guest-first with "sign in to sync" | User's product choice (strict reading of 3.1). Trade-off: every visitor must register — gate UI added minimally in B5; Phaser still mounts once behind it. |
| Realtime | SSE (server→browser), cookie-authenticated, player-scoped, refetch on reconnect; polling fallback | Polling; WebSockets | One-directional updates fit our needs; auto-reconnect; trivial in route handlers; no second event bus. WebSockets rejected as unnecessary complexity. |
| Queue | Transactional DB outbox + DB-backed queue + worker (in-process dev) | Cloud Tasks now; Pub/Sub now | Atomic job+event writes; fully local testability without GCP; dispatch migrates to Cloud Tasks at production without redesign. Trade-off: self-managed retries — mitigated by idempotent handlers (B7). |
| Credentials | Google Cloud project + Gemini API key available/planned | Not yet / later | B8/B10 are not credential-blocked; no phase re-sequencing needed. |

9. Recommended phase order and dependencies
B0 → B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9 → B10 → B11 → B12 → B13 → B14 → B15, exactly as detailed in docs/BACKEND_PHASE_PLAN.md (each phase now carries prerequisites, verification, exit criteria, and out-of-scope). The order is already dependency-correct: contract before code, data model before services, auth before user data, sync before economy authority, queue before background integrations, verified Gmail evidence (B11) gating real rewards, wallet only after the off-chain economy is stable, B15 as the launch gate. No re-ordering recommended.

10. Open decisions requiring user approval
Blocking now:
- Approve (or amend) this roadmap to authorize B1.
- Approve updating the live legacy "no backend" wording in context.md / README.md / docs/FRONTEND_PHASE_PLAN.md (historical reports will stay untouched regardless).
Deferred to their named phase (no action needed now):
- ORM/migration tool final confirmation — B2 entry (Prisma recommended).
- API versioning strategy, error envelope, pagination conventions — B1.
- Stats (xp/level/mailCount/quest) persistence shape — B2 proposal, user sign-off before B5.
- OAuth scopes and token encryption/KMS approach — B8.
- Gemini model, structured-output schema, safety filters, cost controls — B10.
- Reward values, qualifying-action verification details, daily cap values — B6.
- Search indexing approach; attachment preview allowlist/sanitization — B13.
- ALGO network, transaction confirmation policy, purchase benefits — B14.
- Data retention periods and deletion workflow details — B15.
- Cloud Run topology, Cloud SQL connectivity, environment/backup/monitoring strategy — B3 foundations + B15 gate.

11. Files created or updated
All writes were documentation-only, all under docs/:
- docs/MASTER_REQUIREMENTS.md — updated (status, §10 queue decided, §13 auth confirmed, new §14 reconciliation notes)
- docs/BACKEND_PHASE_PLAN.md — rewritten as the B0-finalized sequence (confirmed decisions header; per-phase prerequisites/verification/out-of-scope; B0 marked executed)
- docs/BACKEND_ARCHITECTURE.md — updated (status, §6 queue decided, §14 decided-vs-open split, new §15 repository reconciliation, §16 login-gate trust boundary)
- docs/BACKEND_API_CONTRACT.md — updated (status, §1.2 session transport confirmed, §13 realtime = SSE, B1 checklist annotated)
- docs/phase_b0.md — appended §10 execution record (spec text preserved)
- docs/B0_REPORT.md — created (this report)
No other file was written.

12. Verification performed and not performed
Performed (B0 is read-only for application code):
- Existence checks for every referenced path (glob/read) before describing it as present — app/, components/, game/, scripts/, public/assets/mailxp/, docs/* all confirmed; app/api, prisma/, server/, backend/, .env* confirmed ABSENT; docs/B0_REPORT.md confirmed absent before creation.
- All four master docs read end-to-end; cross-document consistency checked — the seven confirmed decisions are recorded identically in MASTER_REQUIREMENTS §14, BACKEND_ARCHITECTURE §14, BACKEND_PHASE_PLAN header, BACKEND_API_CONTRACT status/§1.2/§13, and phase_b0 §10.
- All updated Markdown re-read after writing (readability/consistency); phase plan and contract clearly separate CONFIRMED vs PROPOSED/OPEN items.
- Byte-level encoding check on docs/BACKEND_ARCHITECTURE.md: an intermediate append via PowerShell Add-Content wrote ANSI bytes (em-dash as 0x97) into the UTF-8 file; the corrupted tail was truncated at byte level and re-appended with the UTF-8-safe editor; final file verified consistent.
Not performed (by design — B0 is documentation-only):
- No build (`next build`), no type-check (`tsc`), no tests, no dev server run — no code changed, so build verification is not applicable and is not claimed.
- No dependency installation; no schema/migration; no deployment; no Gmail/Google/Gemini API call; no secrets or .env created; no runtime data touched.
- No git commands (not a repository).

13. Confirmation that application code/dependencies/assets were not changed
Confirmed. Zero writes outside docs/*.md occurred in this phase: package.json, tsconfig.json, node_modules, app/, components/, game/, public/, scripts/, and all assets under public/assets/mailxp/ are byte-identical to pre-B0 state; no files were created or deleted outside docs/. Because the project has no git history, this confirmation rests on the complete tool-call record for the phase: every write targeted one of the six documents listed in §11.

14. Recommended next action
Begin B1 — API contract and integration boundary finalization (documentation-only: exact first-release routes, schemas, errors, ownership, idempotency, SSE event shapes, shared contract file location under the two-chat ownership matrix). B1 requires no application code and no dependencies, so it can start immediately after approval. Before B2, ensure PostgreSQL is installed natively on Windows (Prisma confirmation happens at B2 entry).

15. Stop point awaiting explicit user approval
STOPPED as required by docs/phase_b0.md §9. No implementation code exists, no dependencies were installed, no infrastructure was changed, and B1 has not been started. This report and the four updated master documents are presented for review; reply with explicit approval (or amendments) before any backend phase begins.
