# Phase B10 Report — AI Email Intelligence (Advisory Analysis)

Date: 2026-10-11
Prerequisites: B9 (Gmail sync + inbox) — complete.
Status: **Implemented and validated. STOPPING for explicit approval before B11** (per `docs/phase_b10.md` execution rule).

---

## 1. Goal

Add optional, advisory-only AI analysis of synced Gmail messages: a short summary, a category,
a priority, action items and deadlines — surfaced inside the in-game inbox. The server never
mutates Gmail, never drafts or sends, and never acts on a model's suggestion. Every
provider call runs inside the durable B7 job queue with strict output validation, a per-player
daily budget, and a global pause control.

---

## 2. Product decisions (user-confirmed, 2026-10-11 question round)

| Decision | Choice |
|---|---|
| **Drafts** | **None.** `phase_b10.md` governs: advisory-only. 1 usage unit = 1 email's analysis. |
| **Provider** | Official `@google/genai` SDK (`^2.28.0`, backend-only dep — reported in `.env.example` + this report). |
| **Daily cap** | **20 per player per UTC day** (env `AI_DAILY_LIMIT`, default 20). |
| **Trigger** | **Both**: auto-enqueue of newly synced messages (behind pause + cap) AND a manual Analyze/Retry button per message. |
| **Enums** | **9 categories** (`work, personal, finance, shopping, travel, notification, promotion, social, other`) + **4 priorities** (`low, normal, high, urgent`). |

Naming constraint honored: guard tests forbid the literal `gemini` in pipeline files/registries,
so the job type is `ai.analysis`, the outbox event is `ai.analysis_requested`, and the provider
adapter lives alone in `lib/server/geminiApi.ts` (not in `PIPELINE_SOURCES`).

---

## 3. Data model (additive only)

Migration `prisma/migrations/20261011055738_b10_ai_analysis/` — purely additive.

- **`EmailAnalysis`** — one CURRENT row per message (unique `gmailMessageId`). Holds the
  validated result (`category`, `priority`, `summary`, structured `result` JSON for action
  items + deadlines), the `contentFingerprint` (sha256 of exactly the fields analyzed —
  idempotency key), `schemaVersion`, `modelId`, `limited` (snippet/subject-only fallback),
  `usageConsumed` (no double-billing on retry), `status`
  (`queued|analyzing|ready|stale|limited|failed`), and a safe `errorClass`. Denormalized
  `googleConnectionId` + `profileId` for retention/cleanup.
- **`AiDailyUsage`** — one row per `(profileId, dayUtc)` with a `units` counter. Reservation
  is an atomic conditional increment (`units < cap` in the `updateMany` predicate), so two
  racing jobs can never both slip under the cap. Released on non-success.
- **`AiSettings`** — one row per profile; the single `paused` flag blocks background AND
  manual analysis (stored results stay readable). Profile-scoped — the B5 preference
  allowlist and version counter are untouched.

**Retention wiring:** disconnect, release, and account deletion all delete `EmailAnalysis`
(before `GmailMessage`), plus `AiDailyUsage`/`AiSettings` by profile on full erasure.

---

## 4. Server implementation

Domain modules in `lib/server/` (no network in route handlers):

- **`aiConfig.ts`** — `loadAiEnv` (fail-closed when `GEMINI_API_KEY` missing), defaults
  (`gemini-2.5-flash`, cap 20, 8 000-char input bound).
- **`aiSchema.ts`** — enums, `contentFingerprint`, `prepareAnalysisInput` (bounded body,
  `limited` flag), `SYSTEM_INSTRUCTION`, `validateAnalysisOutput` (strict JSON schema;
  action-item ids REGENERATED locally as `a1`, `a2`, … so a model can never inject an
  identifier), `parseAnalysisText` (tolerates one ```json fence and nothing else).
- **`geminiApi.ts`** — the ONLY module that may touch the SDK. 20 s timeout, no in-call
  retries (the queue owns backoff), category-only errors (`quota|auth|config|timeout|provider|permanent`),
  never logs/echoes content, prompts, keys, or provider bodies.
- **`aiAnalysis.ts`** — the `ai.analysis` job handler + accounting/eligibility services:
  ownership/connection re-check at execution time; fingerprint idempotency (a matching
  ready/limited row consumes NO usage); atomic reserve-before-call / release-on-failure;
  pause and cap waits `deferJob` (no retry burn) and throw `JobDeferredError`;
  `handleAnalysisFailure` maps malformed output to a retryable `malformed_output` class and
  releases the unit only when no retry is planned; `enqueueAnalysisJob` (manual path) coalesces
  live jobs, requeues a SUCCEEDED job in place, and revives a DEAD job on explicit Retry.
- **`outbox.ts`** — `ai.analysis_requested` planner added (validates `messageId`, dispatches
  `ai.analysis`, dedupeKey `ai.analysis:<messageId>`).
- **`worker.ts`** — `ai.analysis` registered in `JOB_HANDLERS`; `TickResult` + dispatch gained
  a `deferred` outcome; `JobHandlerContext.leaseOwner` threaded through so the handler can
  defer its own claimed job.
- **`gmailSync.ts`** — after a durable commit, the sync tx collects newly imported message
  ids (oldest-first, bounded by `AUTO_ENQUEUE_MAX = 25` per run) and appends one
  `ai.analysis_requested` outbox event each, so the relay creates the jobs in the usual B7 flow.
- **`audit.ts`** — `AI_AUDIT_EVENTS` (`ai.analysis_requested`, `ai.settings_updated`); meta
  carries ids/outcome only — never content, prompts, provider payloads, or the key.
- **`deletion.ts` + disconnect/release routes** — cleanup wired (see §3).

---

## 5. API routes (player-scoped, contract §7 family)

Standard envelope, session auth, strict-Origin CSRF on mutations, `general` rate class, audit.

- `GET  /api/v1/ai/analysis/{messageId}` — `ai.analysisGet`. Owned message with no row →
  200 `not_analyzed` (the UI offers Analyze). Foreign/absent → safe 404 (existence never
  disclosed).
- `POST /api/v1/ai/analysis/{messageId}` — `ai.analysisStart` (202). Re-checks ownership +
  connected mailbox; refuses while paused (**409 `AI_PAUSED`**) or over the daily cap
  (**409 `AI_LIMIT_REACHED`**); fails closed (**503 `SERVICE_UNAVAILABLE`**) when no provider
  key is configured; enqueues the coalesced durable job — never runs the provider inline.
- `GET  /api/v1/ai/settings` — `ai.settingsGet` (pause flag + server-truth usage + `configured` bit).
- `PATCH /api/v1/ai/settings` — `ai.settingsUpdate` (flips the global pause; audited).

New `ApiErrorCode` members: `AI_PAUSED`, `AI_LIMIT_REACHED`. New DTOs: `AiAnalysisDto`,
`AiAnalysisStartDto`, `AiSettingsDto`, `AiSettingsUpdateDto`, plus the `AiCategory` /
`AiPriority` / `AiAnalysisStatus` unions (9 / 4 / 7 members).

---

## 6. Client / UI

- **`components/screens/InboxScreen.tsx`** — opening a message also fetches its analysis and
  renders an "AI insight" panel under the plain-text reader: not_analyzed → Analyze button;
  queued/analyzing → honest spinner text + bounded poll; ready → summary, category · priority
  badge, deadlines, action items; stale → dimmed + Re-analyze; limited → note that only
  subject/snippet were used; failed → honest error class + Retry. `AI_PAUSED` /
  `AI_LIMIT_REACHED` surface via the shared error banner — the client never fakes budget.
- **`components/screens/SettingsScreen.tsx`** — new "AI assistance" card (hidden when the
  server has no provider key): pause toggle + today's `used / cap` usage with the UTC reset
  time. Advisory copy states the feature is read-only over the mailbox.
- **`components/apiClient.ts`** — `fetchAiAnalysis`, `startAiAnalysis`, `fetchAiSettings`,
  `setAiPaused`.

---

## 7. Latent B9 bug discovered + fixed (enqueueJob terminal requeue)

`Job.dedupeKey` is unique across the table's whole history. Once a job SUCCEEDED, a later
enqueue with the same key (a second "Sync now" tap, or re-analysis of a finished message)
collided (P2002) and was swallowed as `created: false` — the requested work would never run
again. Fixed in `enqueueJob`: a collided row in status `succeeded` is requeued IN PLACE
(back to pending, attempts reset, lease/finish/error cleared) and reported as `created: true`.
Pending/running still coalesce. Dead rows are left for the manual `requeueDeadJob` path —
except `enqueueAnalysisJob`, which revives a dead `ai.analysis` job on the player's explicit
Retry (resetAttempts). Covered by new tests in `jobQueue.test.ts` and `aiAnalysis.test.ts`;
the existing gmail "second tap while pending coalesces" test still passes.

---

## 8. Validation (all green)

| Check | Result |
|---|---|
| **vitest** | **648 / 648 pass** (0 fail) — new `aiAnalysis` suite (25) + 3 new `jobQueue` terminal-requeue tests; existing guard tests (`outbox.test.ts`, `deletion.test.ts`) updated to sanction exactly `ai.analysis` + `ai.analysis_requested` |
| **tsc --noEmit** | **0 errors** |
| **next build** | **0 errors** — `/api/v1/ai/analysis/[messageId]` and `/api/v1/ai/settings` registered as dynamic |
| **prisma validate** | schema valid |
| **prisma migrate status** | up to date |

---

## 9. Security posture

- Provider key is server-only env; missing key fails CLOSED (503 on POST, `configured: false`
  on GET settings, `failed/config` row if a job somehow runs).
- Ownership + connection status re-checked at enqueue AND at execution time — a released,
  deleted, or transferred mailbox is never analyzed.
- Cross-user access is a safe 404 (existence never disclosed).
- Strict output validation; action-item ids regenerated locally; ungrounded ISO dates dropped.
- Prompt-injection trust boundary: the email is delimited + size-bounded; the system
  instruction forbids acting on instructions found in the email; the server never executes
  model output.
- Usage is server-truth (atomic conditional increment); the browser can never set or bypass it.
- Audit meta carries ids/outcome only — never content, prompts, provider payloads, or the key.
- Route handlers never call `fetch` (all network in `geminiApi.ts`).

---

## 10. Environment / dependencies

- New backend dependency: `@google/genai` (SDK; never imported by React/Phaser/route files —
  only `geminiApi.ts`).
- `.env.example` gains `GEMINI_API_KEY` (empty placeholder), `GEMINI_MODEL`
  (`gemini-2.5-flash`), `AI_DAILY_LIMIT` (`20`). The user pastes their own key into `.env`
  (git-ignored) — never via chat.

---

## 11. What was NOT touched

- B0–B9 data and invariants (B8b partial unique index intact; B5 preference allowlist/version untouched).
- No drafts, sends, label changes, or any Gmail mutation (B11).
- No in-call provider retries; no push/Pub/Sub; no new frontend dependencies.

**STOPPING here for explicit approval before starting B11.**
