# Phase B9 Report — Real Gmail Sync and In-Game Inbox

Date: 2026-10-11
Prerequisites: B8, B8a, B8b — all complete.
Status: **Implemented and validated. STOPPING for explicit approval before B10** (per `docs/phase_b9.md` execution rule).

---

## 1. Goal

Connect the existing real Google OAuth connection to the in-game inbox: fetch real Gmail
messages, persist the necessary message data, display sender/subject/date/unread state and
safe message details, and keep the inbox reasonably current — while preserving **at most one
active Gmail connection per MailXP account** (B8b's invariant). No Gemini analysis and no
email-mutation actions in this phase.

---

## 2. Product decisions (user-confirmed, 2026-10-11 question round)

The spec forbids inventing these; the user decided:

| Decision | Choice |
|---|---|
| **History window** (initial sync) | **30 days** (stored per mailbox in `GmailSyncState.historyWindowDays`, default 30) |
| **Body rendering** | **Plain text only** — the `text/plain` part is extracted; HTML is never rendered *or stored*. HTML-only messages fall back to the plain snippet (or null). No HTML sanitizer is needed because no HTML ever reaches the client. |
| **Retention on disconnect/release** | **Delete synced messages** — disconnect (row delete) and release (in-place wipe) both remove that mailbox's `GmailMessage` + `GmailSyncState`. Account deletion erases them too. |
| **Keep inbox current** | **Reconcile-on-open + timer, NO push.** There is no Pub/Sub config in `.env`; the spec forbids faking it. A durable `gmail.sync` job is enqueued (coalesced) when the player opens the inbox and via "Sync now". `callbacks.gmailPush` is **not implemented** (see §9 Deviations). |

---

## 3. Data model (additive only; B8b invariant preserved)

Migration `prisma/migrations/20261010212228_b9_gmail_sync/` — **purely additive**, touches no
existing table. `GoogleConnection` gains only a back-relation.

- **`GmailMessage`** — minimal personal content: `sender`, `subject`, `snippet`, `bodyText`
  (plain text only), `isUnread`, `labels` (ids), `attachments` (**metadata only** — filename,
  MIME type, size; never bytes), `internalDate`, `gmailThreadId`. Unique on
  `(googleConnectionId, gmailMessageId)` for idempotent upsert. Indexes for newest-first,
  unread filter, thread lookup. Raw provider payloads, access/refresh tokens, and HTML are
  **never persisted**.
- **`GmailSyncState`** — exactly one row per mailbox: `status`
  (`pending|running|synced|delayed|reconnect_required|error`), `historyId` (Gmail cursor,
  advanced **only after a durable commit**), `historyWindowDays` (default 30), `lastSyncedAt`,
  `lastSuccessAt`, `nextReconcileAt`, `lastErrorClass` (safe category).

**Retention wiring:**
- Disconnect (`DELETE .../accounts/{id}`): deletes messages + sync state, then the connection row.
- Release (`POST .../accounts/{id}/release`): deletes messages + sync state; the identity row stays reserved for transfer.
- Account deletion (`lib/server/deletion.ts`): erases messages + sync state for every connection before the rows are removed.

**B8b partial unique index `GoogleConnection_userId_connected_key` verified intact** in live
PostgreSQL after the migration (see §7).

---

## 4. Server implementation

All provider work lives in `lib/server/` domain modules (never in route handlers), following
the audited-network pattern established by `googleOAuth.ts` (injectable `fetchFn`, endpoint
constants in one place, category-only errors, host allow-list enforced by test).

- **`lib/server/gmailApi.ts`** — Gmail REST client. `refreshAccessToken` exchanges the stored
  refresh token for a short-lived in-memory access token (never persisted/logged).
  `invalid_grant` → `GmailReconnectRequiredError` (no retry storm). Read helpers:
  `listMessages` (initial window via `after:`), `listHistory` (incremental delta),
  `getMessage` (`format=full`), `getProfile` (cursor source). 15s timeout. Hosts:
  `gmail.googleapis.com`, `oauth2.googleapis.com`.
- **`lib/server/gmailMime.ts`** — pure extractor. `text/plain` only; HTML dropped by
  construction. Attachment **metadata** only (bytes never downloaded). Malformed payloads
  degrade safely, never throw.
- **`lib/server/gmailSync.ts`** — the durable `gmail.sync` job handler. Re-checks connection
  **status + ownership** before any provider call (a released/disconnected mailbox makes the
  job a harmless dead-letter). Scope gate (no silent widen). Opens the sealed refresh token
  (fail-closed → `reconnect_required`). Initial (30-day) + incremental history sync. Cursor
  advances **in the same transaction** as the committed message changes. Idempotent upserts.
  Expired cursor (Gmail 404) → **controlled resync** (clear cursor → re-seed), not a loop.
- **Worker / outbox** — `gmail.sync` registered in `JOB_HANDLERS`; `gmail.sync_requested`
  planner added to `OUTBOX_PLANNERS`. Coalescing via the unique dedupeKey
  `gmail.sync:<connectionId>`. No public worker trigger.

---

## 5. API routes (player-scoped, contract §7.2)

Standard envelope, session auth, strict-Origin CSRF, rate-limit, audit. No route calls `fetch`
(all network is in `gmailApi.ts`, asserted by test).

- `GET  /api/v1/gmail/sync-status` — `gmail.syncStatus` (DB-only; no Gmail call).
- `POST /api/v1/gmail/sync` — `gmail.syncStart` (202; enqueues a **coalesced** durable job; `RECONNECT_REQUIRED` 409 when credentials are dead).
- `GET  /api/v1/gmail/messages` — `gmail.messagesList` (cursor-paginated, newest-first).
- `GET  /api/v1/gmail/messages/{messageId}` — `gmail.messageGet` (plain-text detail; metadata-only attachments).

Cross-user access is a safe **404** (never 403 — existence is not disclosed). No mutation
endpoints (send/draft/label/mark-read are B11).

---

## 6. Client / UI

- **`components/screens/InboxScreen.tsx`** — the in-game inbox (new `Inbox` menu section in
  `GameMenu.tsx`). Reads the local mirror; on open it enqueues a reconcile (coalesced) and
  shows sender/subject/date/unread + a plain-text reader. States: no-mailbox, initial-sync,
  empty, list, delayed, error, reconnect-required. No network in any Phaser update loop;
  one canvas preserved.
- **`components/apiClient.ts`** — `fetchGmailSyncStatus`, `startGmailSync`,
  `fetchGmailMessages`, `fetchGmailMessage`.
- **`game/backend/contract.ts`** — `GmailSyncStatus(Dto)`, `GmailMessageSummaryDto`,
  `GmailMessageListDto`, `GmailMessageDetailDto`, `GmailSyncStartDto`; `RECONNECT_REQUIRED`
  added to `ApiErrorCode`.

---

## 7. Validation (all green)

| Check | Result |
|---|---|
| **vitest** | **617 / 617 pass** (0 fail) — includes new `gmailMime` (9), `gmailApi` (14), `gmailSync` (12), `gmail` routes (17) suites |
| **tsc --noEmit** | **0 errors** |
| **next build** | **0 errors** — all 4 Gmail routes registered as dynamic |
| **prisma validate** | schema valid |
| **prisma migrate status** | up to date — 9 migrations |
| **live PostgreSQL** | B8b partial index `GoogleConnection_userId_connected_key` **intact**; `GmailMessage` + `GmailSyncState` tables present; 0 stray messages/sync states; 0 stray `gmail.sync` jobs |
| **HTTP route gates** (live dev server) | reads → **401** unauthenticated; `POST /sync` → **403** on cross-site origin (CSRF before auth); health → 200 |

New tests: `lib/server/gmailMime.test.ts`, `lib/server/gmailApi.test.ts`,
`lib/server/gmailSync.test.ts`, `app/api/v1/gmail/gmail.test.ts`. Existing guard tests
(`deletion.test.ts`, `outbox.test.ts`) were updated to sanction **exactly** the approved
`gmail.sync` job + `gmail.sync_requested` planner while still forbidding Gemini and any
provider network code in the worker pipeline.

---

## 8. Security posture

- Access tokens obtained by refreshing the stored token, used in-memory for one sync, never persisted or logged.
- Refresh token opened server-side via secretBox; fail-closed on undecryptable/missing.
- `invalid_grant` (revoked) → `reconnect_required`, no infinite retry.
- History cursor never advances past uncommitted data; expired cursor resyncs rather than loops.
- Bodies are plain text; HTML never stored/rendered; attachments metadata-only.
- Provider response bodies never embedded in error messages (category-only).
- Route handlers never call `fetch` (all network in the audited lib, allow-list tested).

---

## 9. Deviations from the contract

- **`callbacks.gmailPush` (Pub/Sub push) is NOT implemented.** `.env` has no Pub/Sub topic /
  subscription / service-account config, and the spec (`phase_b9.md`) forbids inventing it or
  claiming push is live. Per the user's explicit decision, B9 uses **reconcile-on-open + timer**
  instead of push. Real push can be added as a later phase once a public server + GCP project
  exist. The server still emits a minimal `gmail.inbox.updated` SSE pointer after a commit
  (clients currently refresh via reconcile/poll; the event is available for future live-refresh).
- **No Gmail mutations** (send/draft/archive/label/mark-read) — deferred to B11 by design.
- **No attachment byte download** — metadata only (spec §5).

---

## 10. What was NOT touched

- B0–B8b data, the B8b partial unique index, and the existing DB rows (no reset).
- No Gemini (B10) and no mutation/quest/wallet code.
- No Pub/Sub / watch / push-renewal code.

**STOPPING here for explicit approval before starting B10.**
