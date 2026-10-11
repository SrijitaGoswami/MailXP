# MailXP — Phase B5 Report: Session Gate, Server-Authoritative Game State, and SSE

Date: 2026-10-10. Scope: B5 only (per `docs/phase_b5.md`). All command results below were actually run, sequentially, in the order shown.

## 1. Summary and completion status

**Complete, with two live-found defects fixed inside B5 scope.** All four contract routes are implemented and verified live (dev + production server), the session gate works end-to-end in a real browser, the Phaser canvas provably never remounts across auth transitions, the legacy-local-profile migration runs backup-first with the approved field authority, and every gate check is green.

| Gate | Baseline (B5 start) | Final (B5 end) |
|---|---|---|
| `npx vitest run` | 143/143 pass, 13 files | **297/297 pass, 24 files** (+154 tests, +11 files) |
| `npx tsc --noEmit` | 0 errors | **0 errors** |
| `npx next build` | exit 0 | **exit 0** (16 routes; 4 new B5 routes dynamic `ƒ`) |
| `npx prisma validate` | valid | **valid** |
| `npx prisma migrate status` | up to date | **up to date** |
| Live API smoke (dev) | — | **41/41 PASS** |
| Live API smoke (`next start`, prod) | — | **41/41 PASS** |
| Browser manual checks (§11) | — | **all pass** (see §11) |
| DB rows | 0 | **0** (cleanup verified after final smoke) |

No blockers. Two defects were found by live verification and fixed within B5 scope (detailed in §14): the strict Origin gate rejected real-browser EventSource GETs, and an open game menu could float over the sign-in gate after sign-out.

## 2. Baseline and post-change commands/results (actually run, sequential)

Final sequence, run in this exact order after the last code change:

```
1. npx vitest run         → Test Files 24 passed (24) / Tests 297 passed (297), exit 0
2. npx tsc --noEmit       → exit 0, no output
3. npx next build         → exit 0; routes include ƒ /api/v1/events,
                            ƒ /api/v1/game/ledger, ƒ /api/v1/game/preferences,
                            ƒ /api/v1/game/state (plus all B4 routes unchanged)
4. npx prisma validate    → "The schema at prisma\schema.prisma is valid"
5. npx prisma migrate status → "Database schema is up to date!"
6. Dev live smoke         → SUMMARY 41 passed, 0 failed (zero FAIL lines in output)
7. Prod live smoke        → SUMMARY 41 passed, 0 failed (account ..., exit 0)
8. Browser manual pass    → §11 (fresh Chrome session against the dev server)
9. DB cleanup             → DELETED sessions/authTokens/auditEvents/profiles/users;
                            REMAINING all 0 → "DB-CLEAN: zero rows"
```

The baseline at B5 start (re-recorded before any edit) was: 143/143 vitest, tsc 0, build 0, prisma valid, migrate up to date, DB zero rows. The smoke script lives at `C:\Users\manik\AppData\Local\Temp\opencode\b5_smoke.mjs` (41 assertions, exit≠0 on any failure); the cleanup script at `b5_cleanup.mjs`.

## 3. Exact routes implemented and contract compliance

Only the four routes `phase_b5.md` §4 authorizes were added. No extra endpoints.

1. **`GET /api/v1/game/state`** (`app/api/v1/game/state/route.ts`) — identity solely from the B4 session; includes `inventoryItems`; returns computed contract defaults when the profile row is missing, **without create-on-read** (404-anomaly is not surfaced; PATCH would 404). Excludes password/session/token/audit material.
2. **`PATCH /api/v1/game/preferences`** (`app/api/v1/game/preferences/route.ts`) — order: strict Origin → session → `general` rate class (60/min per player) → JSON body parse → allowlist validation (exactly the six B2/B4 keys; unknown keys, wrong types, out-of-bounds, empty patch → 400 with field details) → `expectedVersion` required integer ≥1 → **atomic conditional `updateMany`** on `version = expectedVersion`; 0 rows → 409 `STALE_VERSION` with the current version (§7); on success version increments, merged preferences returned, and `profile.updated` is published **only after commit**.
3. **`GET /api/v1/game/ledger`** (`app/api/v1/game/ledger/route.ts`) — session-scoped; §1.5 cursor pagination (default 25, max 100, opaque base64url cursor, `createdAt DESC, id DESC` tie-break, `nextCursor: null` at end, dedupe-by-id sufficient); unsupported query params → 400 (strict whitelist); malformed cursor/limit → 400. Returns an honest empty `{items: [], nextCursor: null}` until B6 writes rows (user-approved choice; see §14).
4. **`GET /api/v1/events`** (`app/api/v1/events/route.ts`) — SSE: relaxed Origin gate (§14.4) → session → 3-streams-per-player cap (429 + `Retry-After`) → stream with `retry: 5000`, named events, `ping` heartbeat every 25 s, server close at 30 min, full teardown on cancel/abort/max-age. Player scope comes only from the server session. This route reproduces `handle()` semantics (request id on every response, category-only error logging) instead of using it, because a streaming success body cannot pass through the JSON wrapper.

Unchanged: `GET /api/v1/me` (identity source), `GET /api/v1/health`, all B4 auth routes (register only refactored to import the shared `DEFAULT_PROFILE_PREFS`), `/`, `/preview`.

## 4. Actual response shapes (as returned and asserted live)

**`GET /game/state` 200**
```json
{"playerId":"usr_...","draftCoin":0,"xp":0,"level":1,"stats":{"mailCount":0},
 "ownedItems":[{"itemId":"tech","ownedSince":"2026-01-01T00:00:00.000Z"}],
 "equippedOutfit":"worker","placedDecor":[{"itemId":"plant-1","x":40,"y":60}],
 "preferences":{"masterVolume":0.8,"uiVolume":0.9,"gameVolume":0.8,"muted":false,
                "motion":"full","touchControls":"auto"},
 "version":1}
```
**`PATCH /game/preferences`** request `{"preferences":{"muted":true},"expectedVersion":1}` → 200 `{"preferences":{...six keys merged...},"version":2}`; stale → 409 envelope with `details:[{"field":"expectedVersion","message":"...","currentVersion":2}]` (§14.1); validation → 400 `VALIDATION_ERROR` with `details[].field` such as `preferences.theme`.

**`GET /game/ledger` 200** → `{"items":[],"nextCursor":null}` in B5; with rows (seeded in tests) each item is exactly `{"id","type","amount","reason","sourceRef","createdAt"}` — no `profileId` or internal columns.

**`GET /events` 200** `content-type: text/event-stream`, first bytes `retry: 5000\n\n`, then e.g. `event: profile.updated\ndata: {"version":3}\n\n`, heartbeat `event: ping\ndata: {}\n\n`; cap → 429 envelope + `Retry-After: 60`.

All of these appear verbatim in the dev/prod smoke output (§2 items 6–7) and the route test suites.

## 5. Auth gate and expired-session behavior

- Boot runs **one** `GET /api/v1/me` probe (StrictMode-guarded; identity never inferred from localStorage). `checking` → `signedOut` renders the existing title overlay with the tabbed `AuthPanel` (Sign in / Create account, `role=alert` errors, autofocus email, B4-exact request shapes); `signedIn` renders Play + email + Sign out top-right and the footer "Progress saves to your account."
- **Strict gate:** `started` is forced off whenever `auth.status !== "signedIn"` — sign-out or session expiry drops back to the overlay; `startGame` is additionally guarded by `signedIn`. The Phaser canvas block in `AppShell` is untouched and unconditional (static guard test asserts exactly one `<PhaserCanvas />`, never inside a conditional).
- 401 handling is deliberate and single-transition: `UNAUTHENTICATED`/`SESSION_EXPIRED` → `reportSessionLost` sets `signedOut` + a notice, idempotently — no retry loops, no re-probe; other error codes never kill the session. `fetchMe` maps those two 401s to `null`; network failure → one attempt + visible notice (never silently "signed out as success" without saying why).
- Sign-out revokes server-side first (`POST /logout`), clears local state in `finally` (even on network failure), and returns to the gate. Live-verified: state/me after logout → 401 `SESSION_EXPIRED`, and the browser gate re-probes correctly.
- Focus discipline: sign-in hands focus to Play; sign-out autofocuses the form; the game menu now closes with the play session (§14.5). Unverified email never blocks play (register → immediate Play).
- Error copy maps stable codes only (`INVALID_CREDENTIALS` → "Invalid email or password.", etc.) — no account-enumeration wording beyond B4's documented register behavior. No forgot-password UI in B5 (B4 routes/tokens exist; login/register only, per plan — §14.8).

## 6. Local profile migration, authority by field, backup and limitations

Keys (all `localStorage`): `mailxp.profile.v1` (live cache, untouched key name/API), `mailxp.profile.v1.legacy-backup` (one-time raw copy), `mailxp.profile.v1.migrated` (marker; prevents any re-run, even if the backup is later lost).

Field authority after sign-in (user-approved "contract-clean" option):

| Field | Authority | Behavior |
|---|---|---|
| `preferences` (6 keys) | server, **one-time local import** | if local differs from server defaults at first sync, the six keys are PATCHed once (debounced, bounded stale-retry); then server wins |
| `draftCoin` | server | never imported from local; server value mirrored into the local cache on every refetch |
| `ownedItems`, `equippedOutfit`, `placedDecor` | server | never imported from local |
| `xp`, `level`, `stats` | server | not present in the local profile v1 shape anyway; defaults until B6 awards |
| raw pre-sign-in profile | preserved byte-identical under the backup key | never deleted, never overwritten (verified live: seeded payload → identical backup; server defaults won the live cache) |

Migration runs backup-first and only once; on repeated network failure the import **abandons** (backup still holds the data — never a silent discard). `stateToProfilePatch` coerces unknown outfit ids to `worker` and emits only Profile-shaped keys. Known limitation, by approved design: local gameplay earnings are non-authoritative and reset to the server value on any refetch (sign-in, SSE reconnect, `profile.updated`, polling fallback) — converges in B6 when the economy becomes server-issued (§12).

## 7. Concurrency/versioning and tests

- Optimistic concurrency exactly per contract: `expectedVersion` mandatory; conditional `updateMany({where: {userId, version: expected}, data: {prefs: merged, version: {increment: 1}}})`; count 0 → read current version → 409 `STALE_VERSION` (no lost update). A dedicated race test fires two concurrent PATCHes at the same version and asserts exactly one 200 and one 409.
- Version is bumped only by real writes; empty patches are rejected (400) so no-op churn cannot occur.
- **297 tests / 24 files** (up from 143/13). New suites: route tests for state (auth, shape, defaults, inventory mapping, isolation, secret exclusion, no-create-on-read, malformed-JSON coercion), preferences (origin, auth, 15 validation cases, merge, stale+currentVersion, race, isolation, 404, rate 61st→429, post-commit SSE publish), ledger (auth, empty honesty, isolation, item shape, §1.5 pagination incl. tie-breaks/dedupe/defaults, 7 invalid-input 400s), events (gates, wire format, fake-timer heartbeat/max-age, cap+Retry-After, cleanup, cross-player isolation); units for `gameState`, `preferences`, `sseHub`, `http.originConflicts`; client units for `apiClient` (request shapes, envelope mapping), `gameSync` (migration/backup/import/stream state machine), `authStore` (probe/sign-in/sign-out/session-lost transitions); static guard tests (canvas mount-once, no network primitives in `game/`).

## 8. SSE lifecycle, reconnection, refetch and connection-limit caveats

- Client: `EventSource` opens after hydration; **open → refetch**; `profile.updated` → REST refetch; ≥3 consecutive failures → 30 s polling fallback (outside Phaser); a successful open resets counters and stops polling; full cleanup on sign-out/unmount. Verified live: sign-in produced `me → state → state` (hydrate + open-refetch), and a UI mute toggle produced `PATCH 200 → events → state 200` (server commit → `profile.updated` → refetch).
- Heartbeat `ping` every ~25 s keeps proxies alive; **the server closes the stream after 30 min** (documented in the route header) and EventSource auto-reconnects — each (re)connect refetches authoritative state. No replay log; `Last-Event-ID` deferred to B12.
- Cap: 3 concurrent streams per player → 429 + `Retry-After: 60`; slots free after disconnect (verified live in both probe and smoke: abort/reader-cancel → reconnect reaches 200). Delivery is player-scoped (unit + live verified; A's events never reach B).
- **Caveats (honest):** the hub is **process-local** — no cross-instance guarantee (N Cloud Run instances → up to 3×N streams; documented, not claimed as distributed); rate limits likewise per-process (B4 carry-over); SSE is best-effort (missed events are covered by the refetch-on-reconnect and polling fallback); the hub holds no persistence.

## 9. Schema/migration changes and additive-safety evidence

Migration `20261010084635_b5_game_state_ledger` (created with `prisma migrate dev`, applied to `mailxp_dev`, status "up to date"):

- `PlayerProfile`: **+3 columns, all with defaults** — `xp Int @default(0)`, `level Int @default(1)`, `stats Json @default({"mailCount":0})`. No existing column altered or dropped; existing rows read back through defaults.
- **New** `LedgerType` enum (`quest_reward`, `purchase`, `adjustment`, `reversal`) and **new** `LedgerEntry` table (cascading FK to `PlayerProfile`, index `[profileId, createdAt DESC, id DESC]` matching the pagination query). No existing table touched.
- Purely additive: no renames, no drops, no type changes; `prisma validate` passes; the only B4 code change is the register route importing the shared `DEFAULT_PROFILE_PREFS` constant (identical values). `prisma migrate reset`/`drop` were never run; DB ends at zero rows.

## 10. Exact changed/untouched files

**Added (server):** `lib/server/preferences.ts`, `lib/server/gameState.ts`, `lib/server/sseHub.ts`; `app/api/v1/game/state/route.ts`, `app/api/v1/game/preferences/route.ts`, `app/api/v1/game/ledger/route.ts`, `app/api/v1/events/route.ts`.
**Added (client):** `game/backend/contract.ts` (types-only), `components/apiClient.ts`, `components/authStore.ts`, `components/gameSync.ts`, `components/useGameSync.ts`, `components/AuthPanel.tsx`.
**Modified (server):** `lib/server/http.ts` (+`STALE_VERSION`, `currentVersion?`, +`originConflicts`), `lib/server/fakeDb.ts` (test fake: inventory/ledger/date-aware where/increment), `app/api/v1/auth/register/route.ts` (shared prefs constant only), `prisma/schema.prisma` + `prisma/migrations/20261010084635_b5_game_state_ledger/`.
**Modified (client):** `components/AppShell.tsx` (auth wiring + gate/menu close; **PhaserCanvas block byte-identical**), `components/screens/SettingsScreen.tsx` (Account section, honest Demo-data copy), `vitest.config.mts` (include `components/**/*.test.ts`).
**Tests added:** 11 files (4 route suites, 3 server units, 3 client units, 1 static guard suite) — listed in §7.
**Untouched:** `game/scenes/**` (incl. `OfficeScene.update()`), `game/bridge.ts`, `game/profileStorage.ts` public API, `game/profile.ts`, `public/assets/mailxp/**`, `/preview`, `/api/v1/health`, all B4 auth route logic and session/token/rate/audit/email modules, sound/touch/a11y behavior.
**Docs:** this report; `phase_b5.md` §16 (execution record); `BACKEND_ARCHITECTURE.md` §19.

## 11. Manual checks of /, /preview, health, login/register/logout and Phaser one-time mount

Run against the live dev server in a real browser, plus the two smokes:

- **`/`** 200, correct shell: boot shows "checking session" → sign-in gate (canvas mounted behind it from first paint). **`/preview`** 200 unchanged. **`/api/v1/health`** `{status:"ok"}`.
- **Register via UI** (Create account tab → 201 → Play + email + Sign out + new footer; no "Local demo" copy anywhere).
- **Play** → HUD live (LV1, XP 0/100, DRAFTCOIN 0 — scene session-local until B6), Menu opens, **Settings → Account** shows "Signed in as …@example.test" + Sign out; Sound/Motion/Controls unchanged and correctly defaulted.
- **Server-authoritative round trip:** toggling Mute in Settings → `PATCH /game/preferences 200` → `profile.updated` on the open stream → `state 200`; a direct `fetch /game/state` then returned `{"muted":true,"version":2}` — persisted across a later sign-out/sign-in cycle.
- **Phaser one-time mount (proof):** the canvas element was tagged (`dataset.b5MountTag`) after load; through Play → menu → Settings → Sign out → gate → Sign back in, `document.querySelectorAll("canvas").length === 1` and the tag **remained on the same element** (`"final-persist"`) — no remount, no OfficeScene reset. Static guard tests independently enforce the single unconditional mount.
- **Migration live:** a seeded legacy profile produced a byte-identical `mailxp.profile.v1.legacy-backup`, the `migrated` marker, and a live cache holding server defaults (backup never overwritten).
- **Console:** only one network-level `401 /api/v1/me` while signed out (expected boot probe); no app JS errors/warnings after the origin fix.
- **Login/logout via API (smoke):** wrong password → 401 `INVALID_CREDENTIALS`; correct → 200 + cookie; duplicate register → 409 `EMAIL_EXISTS`; logout → 204; then state/me → 401 `SESSION_EXPIRED`; 10 bad logins → 429 `RATE_LIMITED`.
- **SSE in the browser:** the app's `GET /events` opened as a held-open 200 (server logged request durations of 13.6 s and 31.5 s for two sessions, and 2.4 min for another) and completed cleanly when the tab navigated or the user signed out — the same teardown path the route's cancel/abort cleanup is unit-tested against; it reopened on the next sign-in.

## 12. Known limitations, unresolved decisions, recommended next phase

**Limitations (carried from B4 unless noted):** per-process rate limits and per-process SSE hub (no cross-instance guarantee); production email delivery blocked until an approved provider phase; marker-based account deletion until the B7 worker; bcrypt 72-byte truncation; first-XFF IP keying. **B5-specific:** no SSE replay (B12); prefs changed during the initial sync window may be dropped once (bounded import retry); local gameplay earnings/purchases are non-authoritative until B6 (approved design — server wins, backup holds originals; shop purchases do not survive reload while signed in); polling fallback only after 3 stream failures; one-time Fast Refresh "deps size" warning observed during the menu-close edit itself (dev-HMR artifact of a 2→3 deps change; subsequent fresh renders clean — no production impact).

**Recommended next phase — B6 (shop/purchases, server-authoritative economy):** add idempotent purchase/balance mutations on the existing versioning pattern, write `LedgerEntry` rows (the read route already pages them), emit `economy.updated` through the existing hub, and award XP server-side. Reuse `sseHub`, `gameState` cursors, `preferences` validation style, and the `handle()` wrapper unchanged.

## 13. Confirmation: B6 and provider integrations were NOT started

B5 scope only. No purchase/mutation routes, no coin awards, no reward issuance, no ledger rows were written, no `economy.updated` emission, no Gmail/Google OAuth/Gemini/Calendar/wallet/ALGO/NFTs, no quest/notification/email-provider/deletion-worker code, no game redesign, no asset changes. DraftCoin remains a simulated, client-displayed number with a server-held (default 0) authoritative value — no real money anywhere.

## 14. Interpretations, deviations and live findings

1. **`STALE_VERSION` details shape** (contract §1.4 details + §1.7 code): 409 envelope with `details:[{"field":"expectedVersion","message":"Profile version is stale.","currentVersion":<n>}]` — the safe `currentVersion` rides inside the field error so a conflicted client can refetch-and-retry without a second round trip.
2. **Heartbeat = named event** `event: ping\ndata: {}\n\n` every ~25 s (contract: "around every 25 seconds"), chosen over a comment line so tests and logs can observe it; harmless to EventSource consumers.
3. **Stream max age:** the server closes streams after 30 min (route header documents it); EventSource's built-in reconnect + connect-refetch makes this invisible to players. No replay (contract defers to B12).
4. **Origin on SSE — live finding and fix:** browsers **omit the `Origin` header on same-origin EventSource GETs**. The initially implemented strict gate (missing Origin → 403) therefore rejected the app's own stream in Chrome — caught by the first browser pass (`GET /events 403` twice in the server log). Fix: new `originConflicts()` relaxes only the stream route — absent Origin allowed; present-but-mismatched/null/garbage → 403 as before. Mutations keep the strict `originMismatch` (browsers always send Origin on PATCH/POST). Security unchanged: a cross-origin `EventSource` performs a CORS request and always sends Origin (rejected), and `SameSite=Lax` cookies are not attached cross-site (401 anyway). Verified live after the fix: browser stream 200 and the full PATCH→publish→refetch round trip.
5. **Menu over the gate — live finding and fix:** the game menu mounts unconditionally (by design), so signing out from *inside* Settings left the dialog floating over the sign-in gate. The strict-gate effect now also closes the menu (overlay-state only; no layout/redesign change). Verified live: sign-out from Settings → clean gate, dialog closed, canvas tag intact.
6. **Ledger in B5:** per the question round, an empty-but-real `LedgerEntry` table was created (additive) so the route performs genuine cursor pagination returning `{items:[], nextCursor:null}`; no fake entries. B6 writes rows.
7. **Until-B6 economy limitation:** shop/purchases/awards stay client-side (B5 boundary), and server state wins on every refetch — so local purchases/earnings do not persist across reload or resync. Approved in the question round (backup preserves originals); B6 closes the loop.
8. **Strict readings adopted:** unsupported ledger query params → 400 (whitelist, not ignored); empty preferences patch → 400; missing profile → GET computes defaults without create-on-read, PATCH → 404; no audit rows for preference writes (none are security-relevant); only login/register UI in B5 (B4 forgot-password routes exist but no UI was requested this phase); `devDelivery` is a dev-only object (`purpose:"email_verification"`) and is absent in production responses (both asserted in the smokes).

## 15. Explicit stop — pending user approval

B5 is complete and reported. **I am stopping here and will not start B6 without your explicit approval.**

Pending your side (unchanged from B4): authorization to clean up the stale "no backend" wording in `context.md` / `README.md` / `FRONTEND_PHASE_PLAN.md`, and optionally approving prisma's preinstall script.
