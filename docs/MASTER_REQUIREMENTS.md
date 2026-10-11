MailXP — Master Requirements
Document status: B0-reviewed (2026-10-10). Confirmed decisions recorded in section 14; everything else remains as written, with OPEN DECISION marks still binding.
Product: MailXP — gamified email productivity platform
Scope: Backend, integrations, persistence, security, economy, and frontend integration
Rule: This document records confirmed product decisions. Choices explicitly marked OPEN DECISION must be resolved before the affected implementation phase.
1. Product vision
MailXP combines a real email productivity platform with a playable 2D pixel-office game built with Next.js, React, and Phaser. Players manage real email workflows through an in-game office. The game is a presentation and motivation layer; it must never be trusted as the authority for email actions, rewards, balances, or progression.
Players can connect multiple Gmail accounts and optionally Google Calendar, receive background email updates, use Gemini-powered assistance, complete qualifying email actions, earn off-chain DraftCoin, buy in-game assets, and later connect Pera Wallet for eligible ALGO-based purchases.
Product principles
1. Player control: AI may recommend and prepare work. Every operation that changes Gmail requires explicit player approval.
2. Server authority: Backend records are authoritative for account ownership, Gmail action execution, XP, level, DraftCoin, inventory, purchases, reward history, usage limits, and persistent progression.
3. Verified rewards: Rewards are issued only after a qualifying action is independently verified. Receiving or opening an email alone never earns a reward.
4. Privacy by design: Retain the minimum email content needed for product functionality; avoid permanent full-body or attachment retention by default.
5. Resilience: Sync and AI work must survive restarts, retries, temporary provider failures, and missed notifications.
6. Frontend preservation: Backend work must not break the existing Next.js/React/Phaser frontend, existing game assets, /preview, or the current Phaser bridge.
7. Incremental delivery: Implement one approved phase at a time, verify it, report it, and stop for review.
2. Existing frontend constraints
The current frontend is documented as Next.js 16, React 19, Phaser 3, TypeScript, and Tailwind. Although the user's preferred general stack has sometimes excluded TypeScript and Next.js for other projects, this MailXP project already uses Next.js and TypeScript; backend work must preserve the existing project rather than rewrite it.
- Phaser canvas mounts once and must not be unmounted or reset as a side effect of React state or backend activity.
- React/Phaser communication goes through the existing game/bridge.ts; do not introduce a second event bus.
- Keep network calls and asynchronous work outside OfficeScene.update().
- Preserve SSR/hydration safety.
- Preserve /preview, existing assets under public/assets/mailxp/, sound, accessibility, and touch support.
- Keep the existing frontend build green.
- Do not redesign or replace frontend architecture unless a separately approved phase requires it.
- Inspect actual files before implementation; documents may be stale or incomplete.
3. Account, authentication, and ownership
3.1 MailXP identity
- A player must register or sign in before gameplay requiring a persistent account, Gmail integration, Calendar integration, or wallet/payment functionality.
- Support email/password registration and Google sign-in.
- Email verification is required before enabling Gmail, Calendar, or payment/wallet operations.
- Password recovery uses expiring, single-use reset links.
- Sessions and credentials must be handled securely; passwords are never stored in plaintext.
- Account state, integrations, and profile must be isolated by authenticated player identity.
3.2 Google identity and mailbox ownership
- Use a stable Google identity identifier to avoid creating duplicate Google connections, mailboxes, sync jobs, emails, or rewards when the same Google account is reused.
- A Gmail account may be linked to only one active MailXP player at a time.
- A mailbox transfer requires the current owner to authorize release; the new owner must authenticate with Google and confirm the link.
- Game progress does not transfer with a mailbox.
- One mailbox's auth failure or disconnection must not interrupt other linked mailboxes.
- Temporary OAuth/token failure pauses work for that mailbox, preserves its data, and prompts reconnection.
- After successful reconnection, sync and queued jobs resume automatically, respecting the global AI pause and usage limits.
4. Gmail and Google Calendar integrations
4.1 Google setup
- Provide a guided Google connection flow before background sync starts.
- Let the player select Gmail and/or Calendar and review requested scopes.
- Explain what data is accessed, how Gemini is used, applicable limits, and how to disconnect.
- Gmail and Calendar permissions are independently manageable even if the initial onboarding presents them in one streamlined flow.
- Request minimal OAuth scopes and expand only when a feature requires them.
- Start background sync only after the player completes setup and grants the required consent.
4.2 Gmail sync
- Support multiple Gmail accounts per MailXP player.
- Continue syncing new email in the background while the player is away.
- Use Gmail push notifications plus scheduled reconciliation; renew provider watches and recover from missed notifications.
- Historical sync range is player-configurable: 7 days, 30 days, 90 days, or all available mail.
- New mail continues to sync after initial setup.
- Historical work is queued and subject to rate limits and AI usage limits.
- Deduplicate using stable Gmail message/thread/history identifiers and provider metadata.
- Do not change Gmail messages without explicit approval.
- Disconnecting one mailbox must not affect other mailboxes.
4.3 Email data and retention
- Store necessary identifiers and metadata, classification, summaries, deadlines/tasks, recommendations, drafts, workflow status, and audit references needed by product features.
- Minimize retention of full message bodies. If body text is temporarily needed for analysis, avoid keeping it longer or more broadly than necessary.
- Analysis and drafts may remain available until the player deletes them or deletes the account, subject to applicable policy and storage minimization.
- Disconnecting Gmail stops future sync, invalidates/revokes credentials where supported, and deletes retained email analysis/drafts for that mailbox; preserve game progression and reward history.
- Account deletion disables login/integrations, revokes credentials, and begins deletion of personal data. Retain only records required for legitimate financial, security, fraud-prevention, or legal reasons.
- Never delete or modify Gmail messages as a consequence of disconnecting or deleting a MailXP account.
4.4 Gmail action approval
Each Gmail-changing action requires individual approval. No batch approval is allowed.
- The approval screen must show the exact action and relevant target.
- Sending a reply requires reviewing the exact recipient, subject, and message body.
- Creating a Gmail draft and sending that draft are separate approvals.
- The exact approved version is the only version eligible for execution.
- Editing or regenerating a draft after approval invalidates the approval and requires a new one.
- If an email changes, retain the old recommendation marked outdated, generate a new recommendation, and require approval for the new version. Do not alter historical rewards or completed actions.
- Use Gmail message/history identifiers and content/version fingerprints to detect changes and stale approvals.
- If the outcome of send/draft creation is uncertain, reconcile with Gmail before retrying. If safe reconciliation is impossible, ask the player to inspect Gmail rather than risk a duplicate send.
4.5 Attachments
- Show attachment names, MIME types, and sizes.
- Provide secure previews for common supported formats where feasible.
- Original files and downloads remain subject to Gmail access control.
- Do not permanently store attachment contents by default.
- Gemini attachment analysis is out of initial scope.
4.6 Search and Priority inbox
- Support AI-assisted natural-language search and advanced filters.
- Prefer stored metadata and analysis; avoid unnecessary Gemini calls for search.
- Urgent emails appear in Priority inbox and trigger a non-blocking in-game notification.
- Urgency criteria/sensitivity are configurable; initial defaults are server-defined.
- Urgency never causes an automatic Gmail action.
5. Gemini analysis and agent workflows
5.1 Per-email workflow
For each eligible email selected by the player's configured categories, Gemini should provide:
- Classification/category
- Concise summary
- Deadlines and actionable tasks when present
- Recommendations and suggested next steps
- Contextual reply draft for every eligible email
- Priority/urgency assessment
Store results with model/configuration version, source message version/fingerprint, status, timestamps, and usage accounting sufficient for auditing and reanalysis.
5.2 Prompt-injection and trust boundaries
- Email content, attachments, quoted text, and external content are untrusted data, never instructions that override system/developer policy or user intent.
- Do not allow email content to authorize Gmail actions, reveal secrets, change permissions, or bypass approval.
- Treat AI output as a recommendation until validated and approved by the player.
- Validate structured model output before storing or using it.
5.3 Limits, pause, and queue behavior
- Start with one Gemini model configurable server-side.
- Configure daily per-player analysis limits.
- One usage unit is one unique email's full analysis-plus-reply-draft workflow.
- Consume a unit only when the complete analysis and draft workflow succeeds.
- Retries of the same job do not consume extra units.
- When a daily limit is reached, queue eligible work oldest-first.
- Limits reset at 00:00 UTC.
- Global AI pause blocks both background and player-triggered Gemini analysis across all linked Gmail accounts.
- During global pause, stop starting new analysis jobs; allow already-running analysis/draft workflows to finish and account for usage normally.
- New jobs queue oldest-first while paused; stored analysis and drafts remain accessible.
- On resume, queued jobs run subject to configured categories, limits, auth state, and provider availability.
- Gmail sync and Priority inbox continue during AI pause.
- Version-aware reanalysis occurs when relevant email content changes; do not reanalyze unchanged content unnecessarily.
6. Notifications and cross-device state
- Initial notifications are in-game only.
- Persist unread notifications for new mail, completed analysis, urgent email, sync errors, and required reconnection.
- Notifications are non-blocking and visible through toasts, unread counters, and an inbox/panel.
- Mark a notification read when opened or when the player explicitly marks it read.
- Sync read/unread state across devices using the backend database.
- Support dismissing an individual notification and clearing all read notifications from the active list.
- Clearing notifications must not delete the underlying email, task, recommendation, or reward records.
- Avoid repeatedly notifying the player for transient errors; notify when intervention is needed.
7. Quests, tasks, and Calendar
- Extracted email tasks can become gamified quests with priority, deadline, linked email, and progress.
- Checking a quest checkbox alone is not sufficient to earn a reward.
- A quest reward is permitted only when a separately defined qualifying action has been independently verified.
- Show upcoming Google Calendar events alongside quests.
- Creating or modifying a Calendar event requires individual explicit approval.
- Google setup may combine onboarding, but Gmail and Calendar services remain independently manageable.
8. Progression, rewards, and economy
8.1 Authoritative profile
PostgreSQL is authoritative for:
- XP, level, and progression
- Earned off-chain DraftCoin balance
- Inventory, outfit, decorations, and owned game assets
- Shop purchases
- Reward and transaction history
- Persistent player profile and preferences that are meant to sync
The client may keep a local cache for responsiveness, but it cannot authoritatively award currency, set balances, set inventory ownership, or decide qualifying rewards. The backend returns authoritative state after important actions. Sync on login, refresh after important actions, and notify connected clients of remote changes. Server-authoritative fields win conflicts; migrate only approved local-only preferences/cosmetic data.
8.2 Qualifying Gmail actions
Initial candidate qualifying actions:
- Send an approved reply, after Gmail confirms the message was sent
- Archive an email, after verification
- Apply/change a label, after verification
- Mark an email read, after verification
- Create a Gmail draft, after verification
- Complete an extracted task only when linked to an independently verified qualifying action
Receiving or opening an email does not qualify. Define fixed reward amounts in server-side configuration. Issue rewards at most once per qualifying action per email, with separately tracked reward types and idempotency protection.
8.3 Daily cap and ledger
- Enforce a server-side daily DraftCoin reward cap per player.
- Reset the cap at 00:00 UTC.
- When the cap is reached, qualifying actions may still complete, but no further DraftCoin is awarded until the next UTC day.
- Use an append-only or auditable ledger for coin grants, spends, adjustments, and purchases.
- Balance updates and ledger entries must be atomic.
- Enforce duplicate prevention at the database level where possible.
8.4 Shop
- The server validates item availability, price, balance, and ownership.
- Deduct currency and grant the item atomically.
- The client rolls back optimistic changes if the server rejects a purchase.
- Never trust client-supplied price, balance, reward amount, or ownership state.
8.5 DraftCoin vs ALGO
- Earned/off-chain DraftCoin and on-chain ALGO purchase benefits are separate accounting concepts.
- Do not assume or implement a conversion rate between earned DraftCoin and ALGO.
- Pera Wallet integration is planned for a later phase.
- A player must explicitly approve an ALGO transaction.
- Wallet connection alone is not proof of payment.
- Verify transaction status, network, destination, amount, eligibility, and replay/duplicate status on the server before crediting a purchase benefit.
- NFTs are deferred and not part of the initial implementation.
9. Reliability and operational behavior
- Durable queues must preserve work across process restarts.
- Transient Gmail/Google API errors use exponential backoff with jitter and respect provider rate limits and Retry-After where applicable.
- Invalid or revoked auth requires player action; pause only the affected mailbox.
- Prevent duplicate Gmail actions and duplicate rewards.
- Reconcile uncertain send/draft outcomes before retrying.
- Gemini failures preserve records and retry according to policy; other emails continue processing.
- Notify the player when intervention is needed, not for every retry.
- Jobs must be idempotent, observable, and traceable without logging sensitive message bodies or credentials.
10. Hosting and deployment direction
- Target managed Google Cloud infrastructure.
- Cloud Run is the intended application runtime.
- Use managed PostgreSQL.
- Use durable background processing and scheduled reconciliation.
- DECIDED AT B0 (2026-10-10): transactional DB outbox + database-backed job queue with a worker loop for local development and tests; dispatch may migrate to Cloud Tasks at production without redesign. Rationale: atomic job+event writes in one transaction, oldest-first ordering per player, full local testability with no GCP dependency. Cloud Tasks remains the likely production dispatcher; Pub/Sub stays deferred until true fan-out is needed. (Was: OPEN DECISION pending selection after considering retry semantics, ordering, fan-out, delivery guarantees, cost, and operational complexity.)
- Secrets must use an appropriate managed secret facility and must never be committed to source control.
- Environments, OAuth redirect URIs, encryption, backups, observability, and deployment strategy must be defined before production.
11. Security, privacy, and compliance requirements
- Use TLS for network traffic and secure storage for tokens/secrets.
- Encrypt sensitive data at rest using platform-supported controls.
- Do not expose Google refresh tokens, provider credentials, wallet secrets, or internal error details to the browser.
- Validate authentication and authorization on every protected API.
- Apply least privilege and per-player data isolation.
- Protect against CSRF where cookie-based auth is used, XSS, injection, replay, brute-force attempts, IDOR, and abuse of expensive AI endpoints.
- Rate-limit authentication, integration, AI, and mutation endpoints.
- Maintain audit records for approvals, Gmail action attempts/results, rewards, purchases, wallet credits, and account lifecycle operations.
- Avoid logging full email content, OAuth tokens, passwords, reset tokens, or private keys.
- Define account deletion and data export procedures before production release.
- Legal/privacy policy, Google OAuth verification, and any required provider policy review must be completed before public launch.
12. Acceptance criteria
The implementation is not complete until:
1. Existing frontend behavior and build remain intact.
2. A player can securely authenticate and access only their own data.
3. Gmail connections are independently managed and recover safely from auth loss.
4. Sync handles push notifications, watch renewal, and reconciliation.
5. Gemini processing respects pause, categories, limits, UTC resets, versioning, and retry rules.
6. No Gmail-changing action runs without a current, exact, individual approval.
7. Rewards are granted only after verified qualifying actions and cannot be duplicated.
8. Economy changes are atomic and server-authoritative.
9. Notifications and progression synchronize across devices.
10. Account disconnect/deletion follows the retention and revocation requirements.
11. Failures are observable and recoverable without losing queued work.
12. Wallet-related credits, when implemented, require server-verified transactions.
13. Each phase has a report, verification evidence, known limitations, and a clear stop point.
13. Open decisions to resolve in planning
The following should not be silently guessed:
- Exact session/auth implementation — CONFIRMED AT B0: custom sessions (email + password, httpOnly session cookie, users/sessions tables, bcrypt hashing); Google sign-in via a hand-rolled OAuth code flow in B8. No third-party auth library or managed auth provider.
- Exact Gmail and Calendar OAuth scopes per feature and Google verification requirements.
- Queue/orchestration selection and transactional outbox strategy.
- Exact API route names, request/response schemas, pagination, and error envelope.
- Database migration/tooling and repository conventions.
- Deployment environments, domain, callback URLs, secrets, backups, and observability.
- Exact Gemini model, structured-output schema, safety filters, and cost controls.
- Reward values, qualifying-action verification details, and daily cap values.
- Shop catalog, prices, and inventory schema.
- Wallet network, accepted ALGO transaction shape, confirmation policy, and purchase benefits.
- Notification expiry/retention policy and urgent-email thresholds.
- Attachment preview allowlist and sanitization strategy.
- Retention durations where legal/security needs or product choices require a specific period.
Resolve each decision in the appropriate phase and record its rationale in the phase report.

14. B0 reconciliation notes (2026-10-10)
Evidence source: direct repository inspection (see docs/B0_REPORT.md). Requirements above are unchanged except where a decision item was explicitly marked CONFIRMED/DECIDED.

Confirmed product decisions (user, at B0):
- Backend lives inside this repository (Next.js route handlers + services, one deployable toward Cloud Run).
- Auth: custom sessions (no auth library/provider).
- Local database: native PostgreSQL installed on Windows (user explicitly rejects Docker) with Prisma as the recommended ORM/migration tool (confirm at B2 entry).
- Login gate: players must register/sign in before Play (strict reading of 3.1; the title overlay gains an auth step in B5 — the Phaser canvas still boots paused behind it and must never remount).
- Realtime: SSE (server→browser) with API refetch on reconnect.
- Queue: transactional DB outbox + worker (see section 10).
- Google Cloud project + Gemini API key: available/planned, so B8/B10 are not credential-blocked.

Code-vs-requirement gaps found (handled, not silently resolved):
- XP, level, mail count and quest progress are currently ephemeral (bridge snapshot only) while draftCoin persists in localStorage — requirement 8.1 makes PostgreSQL authoritative for progression, so B2/B5 must decide persistence of stats explicitly (candidate: add stats to the saved profile).
- The existing 4-quest demo loop awards coins client-side (game/scenes/OfficeScene.ts via addDraftCoin/spendDraftCoin); under 8.2–8.4 those flows become development-only fixtures until B11 provides verified Gmail evidence. B6 already reserves this.
- The frontend has no login UI at all today (components/AppShell.tsx title overlay); the login gate is new frontend work scheduled in B5, subject to frontend-preservation rules.
- Legacy "no backend" wording exists in context.md, README.md and docs/FRONTEND_PHASE_PLAN.md (plus historical phase reports). It does not override this document; historical reports stay untouched as records. Updating the live docs is a separate documentation-approved step.