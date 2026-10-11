MailXP Backend Phase B9 — Real Gmail Sync and In-Game Inbox
Prerequisite: B8, B8a, B8b complete.
Execution rule: Implement B9 only. Create docs/B9_REPORT.md, then STOP for explicit approval before B10.
1. Goal
Connect the existing real Google OAuth connection to the in-game inbox: fetch real Gmail messages, persist the necessary message data, display sender/subject/date/unread state and safe message details, and keep the inbox reasonably current. Preserve at most one active Gmail connection per MailXP account. This phase adds no Gemini analysis or email mutation actions.
2. Inspect before editing
Read docs/MASTER_REQUIREMENTS.md, docs/BACKEND_PHASE_PLAN.md, docs/BACKEND_ARCHITECTURE.md, docs/BACKEND_API_CONTRACT.md, docs/phase_b0.md through docs/phase_b8.md, docs/phase_b8a.md, docs/phase_b8b.md, docs/B8_REPORT.md, and docs/B8B_REPORT.md. Inspect the actual current worktree, Prisma schema/migrations, OAuth helpers, secret encryption, worker/outbox/queue, API conventions, Settings and inbox/computer UI, SSE, and game/bridge.ts. Record baseline results before edits.
Never print or log .env values, access/refresh tokens, state hashes, encryption keys, raw provider payloads, or private message contents. If the approved initial history window, message-content retention policy, or required Pub/Sub setup cannot be determined from existing docs, STOP and ask rather than inventing product policy.
3. Scope
In scope:
- Server-only Gmail API integration using the existing OAuth/credential pattern.
- Refresh access tokens using the stored, actually granted scopes and openStoredRefreshToken (or the exact current helper).
- Initial sync and incremental history sync.
- Product-approved history selection: 7 days, 30 days, 90 days, or all available history. Do not silently choose a default if the requirements do not define one.
- Durable message records and sync status/cursors.
- Authenticated, player-scoped message list/detail and sync-status APIs.
- Existing in-game inbox UI integration, safe previews, loading/error/empty states.
- Push/watch via /api/v1/callbacks/gmailPush and Pub/Sub only when configuration/authentication is grounded in the existing docs.
- Scheduled reconciliation as backup to push, bounded durable jobs, retry/backoff, dedupe, watch renewal if push is configured.
- Attachment metadata-only previews.
Out of scope:
- Gemini summaries/classification/tasks/suggested replies (B10).
- Sending, drafting, archiving, labeling, marking read, deleting, or any Gmail mutation (B11).
- Calendar, wallet, ALGO, NFTs, production deployment, queue replacement, multiple mailboxes per user.
- Attachment byte download/storage or Gemini attachment analysis.
- Rebuilding Phaser or creating a separate backend.
4. Non-negotiable OAuth and ownership rules
- Preserve B8b's PostgreSQL partial unique index: one active connected GoogleConnection per MailXP user. Preserve unique googleSub.
- Never add, silently replace, transfer, or merge a mailbox, or create duplicate MailXP accounts.
- Every sync job/API must re-check connection status and ownership. The browser cannot choose a trusted userId, owner, email, googleSub, token, or mailbox.
- Use only the granted scopes stored for that connection. If gmail.modify was not granted, do not try to widen permissions silently; mark reconnect-required.
- Use the existing encrypted refresh-token helper; never persist tokens in plaintext or return them to the client.
- Revoked/invalid credentials transition to reconnect-required without infinite retry storms.
- Disconnect/release/account deletion makes pending jobs harmless; stale jobs must re-check state before provider calls and writes.
- No Gmail mutations in B9, even if the granted scope technically permits them.
5. Gmail data handling
- Keep all provider calls server-only and outside React render paths and OfficeScene.update(). Follow the project's audited network helper pattern; do not call fetch directly from route handlers.
- Fetch only fields needed by the inbox. Use bounded page sizes and concurrency; avoid huge unbounded mailbox loads.
- Use Gmail message ID plus owning GoogleConnection ID as external identity; enforce unique (googleConnectionId, gmailMessageId).
- Store UTC timestamps; display dates in the client.
- Parse MIME safely. Prefer text/plain; if HTML must be shown, sanitize with a maintained sanitizer. Never render raw Gmail HTML as trusted DOM. Block scripts, forms, remote active content and remote images by default.
- Attachments are metadata only: filename, MIME type, size and provider attachment ID if needed. Do not download/store bytes.
- Minimize persisted personal content to what master requirements approve. If disconnect/release retention behavior is unspecified, stop and ask. Account deletion must erase personal email content and sync state according to the approved deletion policy.
- Do not log email bodies, snippets, subjects, addresses, attachment content or raw provider responses. Use safe internal IDs, counts, durations and error categories.
6. Initial sync and incremental sync
- Initial sync must be durable queued work using the existing transactional outbox and DB-backed job queue; never perform a full sync in a route/UI request.
- Show persistent states such as queued, syncing, synced, delayed, reconnect-required and error.
- Implement the requirements-approved history window: 7/30/90 days/all. Persist the choice if selectable. Do not widen it silently.
- Fetch IDs in pages and details in bounded batches; idempotently upsert messages.
- Advance the Gmail history cursor only after corresponding changes are durably committed. Partial failure must not corrupt the last committed cursor.
- Incremental sync uses Gmail history from the stored cursor. If the cursor expired, schedule a controlled resync, not an endless retry loop.
- Coalesce duplicate pending/running sync jobs per connection. Repeated push notifications and retries must not duplicate messages/jobs.
- Scheduled reconciliation recovers from missed push notifications. Use durable timestamps, bounded batches, per-mailbox isolation and backoff. Document that B7's in-process worker is not a production multi-instance guarantee.
7. Push notifications and watch
- Use /api/v1/callbacks/gmailPush if supported by the existing contract.
- Push payloads are untrusted hints, not message data. Validate Pub/Sub envelope and configured authentication/audience/secret before accepting.
- Callback validates and enqueues/coalesces sync work only; no Gmail fetch inline.
- Resolve notifications to known active connections. Never trust caller-supplied MailXP user ID.
- Unknown, released, disconnected or revoked mailbox notifications are acknowledged safely without exposing account existence.
- Renew Gmail watch before expiry if configured.
- If Pub/Sub topic/subscription/auth settings are absent, do not invent them or claim push is live. Follow the existing requirements; if push is a release blocker and config is missing, stop and ask. Do not expose an unauthenticated sync-trigger endpoint.
8. Schema and migration safety
Add only needed models/fields, likely:
- Message: GoogleConnection FK, Gmail message ID/thread ID, internal timestamp, sender, subject, snippet, approved body representation, unread/labels as permitted, attachment metadata, received date and sync timestamps.
- Sync state: initial sync status, history cursor, last success, next reconciliation, last safe error class, watch expiration and selected history window.
Requirements:
- Unique (googleConnectionId, gmailMessageId), indexes for mailbox/date/unread/thread/status as needed.
- Disconnect/release data-retention behavior must match approved policy. Account deletion removes messages and sync state.
- Review migration SQL before applying; additive only. Never alter/delete B0–B8b migrations or existing account/economy data. Do not reset the database.
- Run npx prisma generate explicitly after schema changes.
- Preserve B8b's partial unique index; Prisma may not represent it in the datamodel, so do not remove it accidentally during schema edits. Document/check raw migration drift.
9. API and UI
Follow docs/BACKEND_API_CONTRACT.md; extend existing route conventions, error envelope and origin/CSRF/auth/rate-limit policy. Expected capabilities: sync status, start/retry sync, cursor-paginated list, safe message details, attachment metadata, push callback, internal jobs. No public worker trigger.
- Use { error: { code, message, requestId, details? } }.
- Player-scoped endpoints verify ownership; cross-user resources use safe not-found.
- Never return tokens, state, raw provider payloads, SQL details or stack traces.
- No send/draft/archive/label/mark-read/delete routes in B9.
- Emit player-scoped SSE events only after durable commits; reconnect must refetch canonical state.
- Integrate into the existing computer/inbox UI and game/bridge.ts; no second bridge.
- Show real sender, subject, date, unread state, safe preview and safe message detail.
- Provide loading, empty inbox, initial-sync progress, delayed sync, retry, reconnect-required and provider-error states.
- Do not display stale messages as freshly synced without status.
- Preserve /, /preview, SSR safety, touch/accessibility, sound, and exactly one Phaser canvas. No network work in OfficeScene.update(). Avoid unrelated UI redesign or changes to public/assets/mailxp/.
10. Required tests
Test:
- No connection => clear UI state and no Gmail API call.
- Scope validation and reconnect-required behavior.
- Refresh token missing/undecryptable/revoked/invalid without secret leakage or retry storm.
- Cross-user list/detail/sync isolation.
- Initial history-window behavior, pagination, MIME parsing, HTML sanitization, metadata-only attachments, malformed payloads.
- Duplicate IDs/pushes/jobs are idempotent.
- Cursor advances only after durable processing; expired cursor triggers controlled resync.
- Partial failures, retry/backoff, 429/quota, 5xx, timeout, worker restart, stale lease, disconnect during sync.
- Push authentication/envelope validation, unknown mailbox handling, coalescing, no inline Gmail fetch.
- Reconciliation after missed push and watch renewal if configured.
- Logs do not include email content, addresses, tokens, secrets or raw provider payloads.
- No Gmail mutation endpoints and no Gemini code.
- Account deletion cleanup and disconnect/release policy.
- B0–B8b regression tests, including economy, OAuth, partial unique index, worker, SSE and Phaser.
- / and /preview: one canvas each, no unexpected MailXP console errors.
11. Final validation sequence
Run sequentially on the final unchanged state:
1. npx vitest run
2. npx tsc --noEmit
3. npm run build
4. npx prisma validate
5. npx prisma migrate status
6. Live PostgreSQL sync/dedupe/cursor/ownership/disconnect/cleanup tests.
7. Provider smoke with configured test Gmail; distinguish real calls from mocks and do not claim a real sync unless it occurred.
8. Browser smoke for /, /preview, and inbox with one connected test mailbox.
9. Check safe DB counts and clean only test-created rows.
Fix failures and rerun the full sequence; disclose intermediate failures.
12. Required docs/B9_REPORT.md
Include status/blockers; baseline/final tests/build/Prisma/live DB/browser results; migration name and reviewed SQL; exact changed/created/untouched files; actual scopes used; history-window behavior; pagination/cursor/retry/dedupe guarantees; push/Pub/Sub and watch status; reconciliation behavior; fields persisted and HTML/attachment policy; disconnect/release/deletion retention; whether a real Gmail fetch happened or tests were mocked; safe before/after counts; anomalies/limitations; confirmation B8b invariant and B0–B8b data/game lifecycle remain intact; recommendation for B10 only if complete. Never include tokens, secrets, state hashes, or private email contents.
13. Stop conditions
Stop and ask if:
- Approved history-window default/selection cannot be determined.
- Retention of locally synced messages on disconnect/release is unspecified.
- Approved body storage/rendering behavior is unclear.
- Required Pub/Sub configuration/authentication is missing and push is required.
- Migration risks existing data or the B8b partial index.
- Current source differs materially from B0–B8b reports.
- Tests show unresolved cross-user access, token leakage, duplicate mailbox connection, unsafe HTML, or game lifecycle regression.
Otherwise implement B9 only, write docs/B9_REPORT.md, and stop. Do not begin B10 without explicit user approval.