MailXP — Phase B1: API Contract and Integration Boundary Finalization
Phase ID: B1
Status: Ready for execution after explicit user approval
Mode: Documentation-only
Prerequisite: B0 completed and its report reviewed
Primary rule: Finalize the first-release API contract without implementing application code.
1. Objective
Turn the draft docs/BACKEND_API_CONTRACT.md into a consistent, reviewable contract for the first implementation phases. The contract must match the actual MailXP repository, the B0 decisions recorded in docs/B0_REPORT.md, and the confirmed product requirements in docs/MASTER_REQUIREMENTS.md.
B1 is a contract/design phase only. It must not implement endpoints, authentication, database schemas, migrations, background workers, Gmail/Gemini integrations, frontend pages, or deployment infrastructure.
2. Mandatory preflight
Before work:
1. Confirm the working directory is the existing MailXP project root.
2. Read:
   - docs/B0_REPORT.md
   - docs/MASTER_REQUIREMENTS.md
   - docs/BACKEND_PHASE_PLAN.md
   - docs/BACKEND_ARCHITECTURE.md
   - docs/BACKEND_API_CONTRACT.md
   - docs/phase_b0.md
   - context.md
   - frontend_file_structure.md
   - docs/FRONTEND_PHASE_PLAN.md
   - docs/PHASE_7_REPORT.md
3. Inspect existing app routes and shared type conventions. Do not assume B0's route suggestions already exist in code.
4. Check for existing B1 specification/report files before creating or updating them.
5. Do not print environment values, credentials, tokens, email content, or private keys.
6. Treat B0's seven recorded architecture decisions as confirmed unless the user explicitly amends them.
If a required file is missing, report that fact and continue only when enough reliable information remains. Do not invent the missing contents.
3. B0 decisions B1 must preserve
According to docs/B0_REPORT.md, the following decisions were confirmed:
- Backend remains inside the existing repository as one Cloud Run deployable.
- Authentication uses custom sessions, email/password, an httpOnly SameSite=Lax cookie, users/sessions tables, and bcrypt; Google OAuth is handled in B8.
- Local development database direction is native PostgreSQL on Windows; Prisma is recommended for confirmation at B2.
- Login is required before Play; the gate UI is planned for B5 while preserving one-time Phaser mounting.
- Realtime updates use cookie-authenticated, player-scoped SSE, with refetch on reconnect and polling fallback.
- Background work uses a transactional database outbox, database-backed queue, and in-process development worker; Cloud Tasks is deferred until production and Pub/Sub until a fan-out need.
- Google Cloud project and Gemini API key are available/planned; secrets must remain server-side.
Do not silently change these decisions in B1. If the repository exposes a concrete blocker, document it and ask the user rather than substituting an alternative.
4. Scope
In scope
- Finalize the route inventory and HTTP methods for the first-release API.
- Define request/response schemas and validation constraints.
- Define authentication, email verification, authorization, ownership, and CSRF expectations.
- Define the shared error envelope and status mapping.
- Define pagination/filter/sort conventions.
- Define idempotency requirements for side-effecting operations.
- Define optimistic concurrency/version handling for drafts, recommendations, profile changes, and approvals.
- Define SSE event types, payload shape, authentication, reconnection, and refetch behavior.
- Define API boundaries between player-facing routes, Google provider callbacks, background jobs, and internal-only operations.
- Mark routes needed in early phases versus later Gmail/Gemini/Calendar/wallet phases.
- Record open decisions and phase dependencies.
- Produce a report with a clear stop point.
Out of scope
- No application code or shared TypeScript types.
- No API route implementation.
- No database schema or migration files.
- No package installation or package changes.
- No auth UI or frontend modifications.
- No Google/Gmail/Gemini/Calendar/Pera API calls.
- No secret/configuration files.
- No deployment or database setup.
- No B2 or later implementation.
5. Contract design requirements
5.1 Route inventory
Review the draft routes and classify each as:
- B3/B4 foundation: health/readiness and authentication/profile foundations
- B5: authoritative game state and preference sync
- B6: rewards ledger and shop
- B7: job status/operational interfaces if user-facing
- B8: Google integration connection lifecycle
- B9: Gmail sync, messages, inbox, priority, and settings
- B10: AI settings, pause/resume, analysis, usage, and job status
- B11: recommendations, draft editing, approvals, and Gmail action execution/status
- B12: notifications, quests, and Calendar
- B13: search and attachment metadata/preview
- B14: wallet and ALGO purchase intents/status
- B15: production/operational concerns, not necessarily public endpoints
Do not expose internal job dispatch or reward issuance as unrestricted player APIs. Provider callbacks must be distinct from player-facing endpoints.
For every route, specify:
- Stable route identifier
- HTTP method and path
- Phase
- Purpose
- Authentication and email-verification requirement
- Ownership/authorization checks
- Request schema and validation
- Success response schema
- Error cases/statuses
- Idempotency/concurrency requirements
- Rate-limit or quota requirements
- Side effects and audit needs
- Whether it is required for the initial usable release or later
5.2 Authentication and session contract
Use the B0-confirmed custom session direction. Define the observable contract, not implementation code:
- Registration and login inputs and safe outputs
- Logout semantics and session invalidation
- Email verification token lifecycle
- Password reset request and completion behavior
- Account enumeration protection
- Cookie expectations: httpOnly, Secure in production, SameSite=Lax, path, expiry/rotation policy
- CSRF protection strategy for cookie-authenticated mutations
- Rate limiting and brute-force controls
- Authentication response for expired/unauthenticated sessions
- Player ID and verified-email representation without leaking internal secrets
Exact session duration, rotation cadence, password policy, and verification-link expiry must be set to safe concrete values only if the B0 docs already specify them. Otherwise mark them OPEN — USER/SECURITY REVIEW REQUIRED with a recommended default and rationale, rather than silently inventing a final value.
5.3 Authorization and data ownership
For every resource:
- Require the authenticated player context.
- Resolve mailbox ownership server-side.
- Never trust a player ID supplied in the body as authority.
- Scope every query and mutation to the authenticated player and the linked Google account.
- Distinguish 401 unauthenticated, 403 unauthorized, and 404 not found according to the selected information-disclosure policy.
- One mailbox auth failure must not block other linked mailboxes.
- Never return Google refresh tokens or internal provider credentials.
5.4 Error envelope
Define one stable JSON error shape. Recommended draft:
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Safe user-facing message",
    "requestId": "correlation-id",
    "details": []
  }
}
This is a proposal for B1 to confirm, not an already implemented response. Define a consistent mapping for:
- 400 malformed request
- 401 unauthenticated/expired session
- 403 forbidden
- 404 resource not found
- 409 conflict, stale version, duplicate state transition, or idempotency mismatch
- 422 syntactically valid but semantically invalid request, if chosen
- 429 rate/quota limit
- 502/503 upstream provider or temporary service failure
- 500 unexpected internal error
Do not leak stack traces, tokens, raw email bodies, raw provider payloads, or database details. Decide whether 422 is used consistently or whether validation uses 400; document one convention.
5.5 Pagination, sorting, and filters
Define one pagination approach for list endpoints. Cursor pagination is recommended for growing email/job/notification feeds. Specify:
- limit default and maximum
- opaque cursor format and invalid-cursor behavior
- stable sort order and tie-breaker
- filter validation and supported filter combinations
- response fields such as items and nextCursor
- behavior when a cursor's underlying data changes
If exact defaults are not in existing requirements, propose values and label them as B1 recommendations for user review.
5.6 Idempotency and concurrency
For side-effecting operations, specify:
- Which endpoints require an idempotency key
- Key format and per-player scope
- Retention window or policy
- Request fingerprint behavior
- Same key/same request returns the stored result
- Same key/different request returns conflict
- In-progress duplicate request behavior
- Database uniqueness/transaction expectations
At minimum evaluate idempotency for:
- registration/verification token consumption where applicable
- shop purchase
- reward issuance (internal operation, not client-issued)
- Gmail action execution
- OAuth callback processing
- job enqueueing
- wallet purchase credit
- Calendar mutations
For mutable resources, define version preconditions such as version or If-Match where useful. A stale draft or source message must not execute with an outdated approval.
5.7 Server-Sent Events (SSE)
B0 confirmed player-scoped SSE with cookie authentication and polling fallback. Define:
- Endpoint path proposal, e.g. GET /api/events
- Same-origin/cookie-authenticated access
- Player scoping on the server; client-supplied player IDs must not control subscription scope
- Event names and minimal payload fields
- Keep full email bodies, credentials, and sensitive draft contents out of general-purpose events
- Reconnect behavior and event IDs where supported
- Heartbeats/timeouts and deployment constraints to validate later
- Client refetch behavior after reconnect or missed events
- Fallback polling intervals/conditions to be finalized before implementation
- Events for profile/economy updates, notifications, Gmail sync status, analysis completion, and relevant action status
- Do not introduce a second React/Phaser event bus; React-facing events must follow the existing frontend integration pattern and Phaser bridge invariants.
Do not claim the frontend already supports SSE; this is a backend contract decision.
5.8 Provider callbacks and internal operations
Define separately:
- Google OAuth callback and state validation
- Gmail push notification callback validation and durable enqueueing
- Any future payment/provider callbacks
- Internal worker operations and trusted service boundaries
Do not expose internal job dispatch, direct reward minting, or arbitrary Gmail mutation as public routes. Provider callbacks must validate their supported authenticity/state controls and enqueue work quickly rather than performing long-running Gemini processing inline.
5.9 Privacy and data minimization
For all responses:
- Return only fields needed by the caller.
- Do not include OAuth tokens, internal secrets, password hashes, reset tokens, raw provider payloads, or private keys.
- Avoid returning full message bodies in list responses.
- Define a detail endpoint for permitted email content if needed, with ownership checks and retention policy.
- Attachment endpoints must enforce Gmail access and content/type/size safety.
- Account deletion/disconnect must not mutate or delete the original Gmail messages.
6. Required B1 deliverables
Create or update only documentation files under docs/:
1. docs/BACKEND_API_CONTRACT.md — finalized contract for agreed scope, with explicit labels for confirmed, proposed, and open items.
2. docs/phase_b1.md — this specification, updated with actual B1 execution record if appropriate.
3. docs/B1_REPORT.md — summary of route decisions, schemas, auth/authorization rules, errors, pagination, idempotency, SSE, unresolved decisions, files changed, verification, and stop point.
If a useful docs/API_SCHEMA.md or equivalent is justified, propose it first in the report; do not create extra documents without a clear reason. No code/types are to be added during B1.
7. Verification
- Confirm all route entries have method, path, phase, auth, ownership, request, response, errors, side effects, and idempotency fields as applicable.
- Ensure route names are consistent across sections.
- Ensure provider callbacks/internal operations are not described as ordinary public client endpoints.
- Ensure all cookie-authenticated mutations document CSRF handling.
- Ensure SSE events are player-scoped and payload-minimal.
- Ensure Gmail action approval rules are explicit: individual approval only; exact recipient/subject/body for send; draft creation and sending are separate; editing invalidates approval; stale source versions require refreshed approval.
- Ensure rewards require server-verified provider evidence.
- Ensure AI pause, per-player usage limits, oldest-first queueing, and 00:00 UTC reset are reflected.
- Ensure wallet and ALGO routes are marked deferred to B14.
- Cross-check the API contract against MASTER_REQUIREMENTS and BACKEND_ARCHITECTURE.
- Re-read all changed Markdown files for consistency.
- Do not run builds or tests because no code should change.
- Confirm no files outside the approved docs scope were changed.
8. Required B1 report structure
docs/B1_REPORT.md must include:
1. Summary and status
2. Project root and date
3. B0 decisions used
4. Route inventory by phase
5. Authentication/session and authorization contract
6. Error envelope and HTTP status mapping
7. Pagination/filtering/sorting
8. Idempotency and concurrency rules
9. SSE event contract and fallback
10. Provider callback/internal-operation boundaries
11. Privacy and response minimization
12. Open decisions and affected phases
13. Files created/updated
14. Verification performed and not performed
15. Confirmation that no code/dependencies/runtime data were changed
16. Recommendation for B2
17. Explicit stop awaiting user approval
9. Exit criteria
B1 is complete only when:
- The contract is consistent with B0 and master requirements.
- Every first-release route is specified or explicitly deferred.
- Auth, ownership, errors, pagination, idempotency, concurrency, SSE, and provider callbacks are described clearly enough for implementation.
- Any unknowns that block implementation are listed with recommendations and phase ownership.
- docs/phase_b1.md and docs/B1_REPORT.md exist and accurately describe the work.
- No application code, dependencies, frontend pages, schemas, migrations, secrets, or runtime data were modified.
- The report recommends whether B2 can begin.
10. Stop condition
After completing the B1 documentation and report, STOP. Do not begin B2 or create implementation code. Present B1_REPORT.md for review and wait for explicit user approval before proceeding.

11. B1 execution record (2026-10-10)
Status: EXECUTED — documentation-only; stopped per section 10, awaiting approval to proceed to B2.

Preflight performed: project root confirmed (C:\Users\manik\Desktop\MailXP); read docs/B0_REPORT.md, docs/MASTER_REQUIREMENTS.md, docs/BACKEND_PHASE_PLAN.md, docs/BACKEND_ARCHITECTURE.md, docs/BACKEND_API_CONTRACT.md (draft), docs/phase_b0.md, context.md, frontend_file_structure.md, docs/FRONTEND_PHASE_PLAN.md, docs/PHASE_7_REPORT.md; inspected app routes (only layout/page/preview/globals.css — no API routes exist, confirming B0); checked for existing B1 files (none — docs/B1_REPORT.md did not exist); no environment values or credentials printed (none exist).

User decisions collected at B1 (recorded in the finalized contract):
1. Session lifetime: 30 days, sliding renewal, rotation on login; password reset revokes all sessions.
2. Password policy: minimum 10 characters, common-password blocklist, no composition rules, no forced rotation.
3. Token expiry: email verification 24 h, password reset 1 h — both single-use and stored hashed.
4. Verify-before-play: NO — play immediately after registration; verification gates only Gmail/Calendar/wallet (MASTER_REQUIREMENTS 3.1).
5. First-release scope: B3–B6 only (health, auth, profile/game state, preferences, ledger, shop, SSE). All Gmail/Gemini/Calendar/wallet/notifications/quests families inventoried as DEFERRED with phase markers.
6. API versioning: /api/v1 prefix from day one.

Contract finalizations made under spec authority (recommendations recorded, marked accordingly): error envelope with a single 400-for-validation convention (422 explicitly unused) and a 15-row status/code table; cursor pagination (limit 25/max 100, opaque cursor, createdAt DESC + id DESC); Idempotency-Key mechanics (24h retention, fingerprint conflict → 409, in-progress → 409); optimistic concurrency via expectedVersion (→ 409 STALE_VERSION); SSE shapes (profile.updated / economy.updated / ping, retry 5000, refetch-on-reconnect, 3-failure poll fallback recommended); CSRF = SameSite=Lax + Origin check; rate-limit table marked RECOMMENDED pending B3/B4 security review; information-disclosure policy (cross-player → 404; 403 reserved).

Files created/updated: docs/BACKEND_API_CONTRACT.md (rewritten as B1-finalized), docs/phase_b1.md (this record), docs/B1_REPORT.md.
Not performed: any application code, shared TypeScript types, route implementation, schema/migration files, package changes, frontend/auth UI work, provider API calls, secrets, deployment, database setup, or B2+ implementation.

Verification (per section 7) is recorded in docs/B1_REPORT.md §14; no builds/tests were run because no code changed.