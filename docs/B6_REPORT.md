# MailXP — Phase B6 Report: Economy Ledger, Rewards, and Server-Authoritative Shop

Phase: B6 (backend phase plan). Date: 2026-10-10. Status: **complete — implementation, tests, live verification and DB cleanup done; stopped for explicit approval before B7.**

## 1. Summary and completion status

Shop purchases and reward issuance are now server-authoritative: canonical catalog prices from the server, one atomic database transaction per purchase (deduct → grant → ledger → audit → idempotency outcome), durable DB-backed idempotency (contract §1.6), negative ledger rows for purchases, post-commit SSE `economy.updated`, and the user-approved dev reward fixture with the fixed 20/100-UTC-day economy. The storefront (ShopScreen) buys through the API with a per-click UUID `Idempotency-Key` and never trusts local prices, balance, or ownership; local `purchaseItem()` remains only as an isolated, unit-tested client utility.

Deliverables per phase plan: economy endpoints + service modules + schema migration + `docs/B6_REPORT.md` — all produced. XP/level awards untouched (B6 question round: deferred to a later phase). DraftCoin stays a simulated in-game currency.

## 2. Baseline and post-change commands/results (actually run, sequential)

Baseline (single run at phase start, after discovery, before any change):
- `npx vitest run` → **300/300 (24 files)**
- `npx tsc --noEmit` → exit 0
- `npm run build` → exit 0
- `npx prisma validate` → schema valid; `npx prisma migrate status` → up to date

Post-change (phase_b6 §12 order, one pass after all code was final):
1. `npx vitest run` → **374/374 passing (30 files)** (+74 tests, +6 test files)
2. `npx tsc --noEmit` → exit 0
3. `npm run build` → exit 0 (route list: 21 routes = 18 API + 3 pages; the 5 new B6 API routes all present: `/api/v1/shop`, `/api/v1/shop/purchases`, `/api/v1/rewards/rules`, `/api/v1/rewards/status`, `/api/v1/dev/rewards`)
4. `npx prisma validate` → "The schema … is valid 🚀"
5. `npx prisma migrate status` → "Database schema is up to date!"
6. Live dev smoke (HTTP, `b6_smoke.mjs` against `next dev`) → **26/26 checks pass**

One extra `npx tsc --noEmit` (exit 0) was run after `npx prisma generate` (see §8 finding 1): the generated client types changed after step 2, so the type check was repeated to keep results honest. `vitest`/`build` were not re-run afterwards because no source file changed — only generated `node_modules` types.

## 3. Exact routes implemented and contract compliance

| Route | Method | Contract ref | Behavior |
|---|---|---|---|
| `/api/v1/shop` | GET | §4 shop.catalog (B6 first release) | session required; GET-origin policy (absent allowed, cross-site 403); 200 `{ items[], catalogVersion }` — prices/availability are server truth |
| `/api/v1/shop/purchases` | POST | §4 purchase + §1.6 | strict Origin → session → `general` 60/min rate → **required** `Idempotency-Key` (UUID) → strict body `{itemId, expectedVersion}` (unknown keys 400) → idempotency reserve → atomic purchase → SSE after commit → 201 |
| `/api/v1/rewards/rules` | GET | §7.5 B6 surface | session; 200 `{questRewardDraftCoin: 20, dailyCapDraftCoin: 100, resetUtcHour: 0}` |
| `/api/v1/rewards/status` | GET | §7.5 B6 surface | session; today's UTC window derived from `quest_reward` ledger rows |
| `/api/v1/dev/rewards` | POST | §4 "development-only fixtures per B6 scope" | **production gate first** (404 before any work when `NODE_ENV=production`) → strict Origin → session → rate → required `Idempotency-Key`; issues through the same `issueQuestReward` atomic service |

Error codes added to the B1 envelope (documented here as contract amendments): `INSUFFICIENT_FUNDS` (409, details carry `currentBalance` + `currentVersion`), `IDEMPOTENCY_MISMATCH` (409), `IDEMPOTENCY_IN_PROGRESS` (409). `FieldError` gained an optional `currentBalance` (mirrors B5's `currentVersion`). Other rejections: 404 unknown item/profile, 409 `CONFLICT` already-owned, 409 `STALE_VERSION`, 403 origin, 429 rate, 400 validation.

## 4. Actual response shapes (as returned and asserted live)

- Catalog: `{"items":[{"itemId":"pen-cup","name":"…","price":6,"kind":"decor","available":true}, …47 items],"catalogVersion":"<12-hex sha256>"}` — item objects contain exactly the 5 contract keys (asserted), `available=false` once owned (asserted live).
- Purchase 201: `{"transactionId":"<uuid>","itemId":"pen-cup","balance":94,"version":7}`; replay with same key returns the same values (key order may differ — see §14).
- Purchase rejection example (live): `{"error":{"code":"INSUFFICIENT_FUNDS","details":[{"field":"balance","message":"…","currentBalance":0,"currentVersion":1}],…}}`; `CONFLICT`/`STALE_VERSION` carry the same two riders with the authoritative values.
- Rules: `{"questRewardDraftCoin":20,"dailyCapDraftCoin":100,"resetUtcHour":0}`.
- Status: `{"earnedToday":40,"dailyCapDraftCoin":100,"remainingToday":60,"resetsAtUtc":"2026-10-11T00:00:00.000Z"}`; at cap `earnedToday:100, remainingToday:0`.
- Dev fixture: `{"awarded":20,"capped":false,"balance":20,"version":2}`; at cap `{"awarded":0,"capped":true,"balance":100,"version":<unchanged>}` (200, no ledger row, no SSE).
- Ledger row for a purchase (live): `amount: -6`, `type: "purchase"`, `reason: "shop:purchase:pen-cup"`, `sourceRef: <transactionId>`.

## 5. Server design (services, transaction, idempotency)

- `lib/server/catalog.ts` — canonical 47 entries (OUTFITS + DECOR_ITEMS, `worker` excluded as before), `catalogVersion()` = 12-hex sha256 over canonical JSON, `buildCatalog(ownedSet)` derives `available = !owned`.
- `lib/server/idempotency.ts` — UUID key validation (type-guard), `canonicalJson` (order-independent), `requestFingerprint(endpoint, body)`, and `begin/complete/releaseIdempotency` with outcomes OK / REPLAY / MISMATCH / IN_PROGRESS. DB-backed with `@@unique([profileId, endpoint, key])` (true P2002 constraint). Records retain **24 h** (`IDEMPOTENCY_RETENTION_MS`, replaced past expiry); a stale `in_progress` reservation older than **2 min** (`IN_PROGRESS_STALE_MS`) is taken over instead of blocking (crash-window recovery).
- `lib/server/economy.ts` — `ECONOMY_CONFIG` (reward 20, cap 100 per UTC day, reset 00:00Z), `utcDayStart`/`nextUtcReset`, `purchaseShopItem`, `issueQuestReward`, `dailyRewardStatus`.
  - **Purchase**: pre-checks (unknown → NOT_FOUND; stale → STALE_VERSION + state; insufficient → INSUFFICIENT_FUNDS + state; owned → ALREADY_OWNED + state — all without mutation), then ONE interactive transaction: conditional `updateMany({id, version, draftCoin: {gte: price}})` deduct+version-bump (count 0 → rollback → re-read → classify as stale/owned), inventory grant (composite PK P2002), ledger row (`-price`), audit `economy.purchase` (meta: itemId/price/transactionId, no PII), and the replayable 2xx idempotency outcome — phase_b6 §6 step 9 **inside** the same transaction, so a crash can never commit money without a replayable result.
  - **Reward**: in-transaction UTC cap aggregation over `quest_reward` rows; at/over cap the action succeeds with `awarded: 0` (MASTER §8.3), no version bump; granted path = increment + version + ledger row.
  - Transaction races throw `ProfileRaceError`, re-read, and surface as STALE_VERSION with authoritative state.
- SSE: `economy.updated {balance, reason, version}` + `profile.updated {version}` published **only after commit**, keyed by `session.user.id`; failures and capped claims publish nothing (asserted).

## 6. Client implementation (preserves all B5 boundaries)

- `components/apiClient.ts` — `fetchShopCatalog()`, `purchaseShopItem(itemId, expectedVersion, idempotencyKey)` (sends the `Idempotency-Key` header), `issueDevReward(idempotencyKey)`; `request()` gained a headers option; `ApiError.fieldErrors` parses `currentBalance`.
- `components/useGameSync.ts` — added `economy.updated → refetch` alongside `profile.updated` (same pointer semantics; lifecycle/cleanup untouched).
- `components/screens/ShopScreen.tsx` — fetches the server catalog on mount (Buy disabled until it loads; a price is never used for charging from local config), fetches a fresh `GET /game/state` for `expectedVersion` at click time (`profile.version` is the local storage schema version and cannot be reused), uses a fresh UUID key per user click, commits only after server confirmation, and applies the authoritative `currentBalance` from rejections (rollback without fake success). The dev fixture button hides itself on 404 (production). Messages branch on stable codes only, never server message text.
- `game/profile.ts purchaseItem()` — **kept isolated** (unit-tested in `profile.test.ts`) but no longer called by the storefront; a new static guard asserts that.
- Untouched: `game/bridge.ts`, `OfficeScene.update()`/game loop (no network), assets under `public/assets/mailxp/`, audio, auth/sync flow, the single unconditional Phaser canvas mount (verified live: exactly 1 canvas before/after refresh), SSR/hydration, a11y (buttons `type="button"`, status region `role="status"`), touch/sound behavior. No game redesign.

## 7. Tests (374/374 across 30 files; +74 tests, +6 files)

- `app/api/v1/shop/route.test.ts` — auth 401s, GET-origin policy, exact contract keys/no internals, canonical prices, owned→`available=false`, missing profile (no create-on-read), stable `catalogVersion`.
- `app/api/v1/shop/purchases/route.test.ts` — auth/origin/validation (incl. client-supplied `price` rejected), 404 no-mutation, STALE/INSUFFICIENT/OWNED riders, atomic success (deduct+grant+negative ledger row+audit+version+stored idempotency), per-player isolation, replay (one charge), MISMATCH, IN_PROGRESS, release-on-failure honest retry, **concurrency: exactly one of two racing purchases wins, balance never negative, loser gets STALE_VERSION**, and SSE assertions (two player-scoped events after commit; failures/replays publish nothing).
- `app/api/v1/rewards/rewards.test.ts` — rules auth + config equality, status zeros/sums/UTC-window/type-filter/per-player isolation/missing profile, `utcDayStart` math.
- `app/api/v1/dev/rewards.test.ts` — production gate (404 before session/rate/mutation, manual NODE_ENV save/restore), validation, issuance shape, replay-one-reward, UTC cap (no write, no SSE), per-player cap isolation, SSE grant-vs-capped.
- `lib/server/economy.test.ts` — config values, window helpers, reward paths (grant/null/cap/yesterday-doesn't-count/purchases-don't-count), status math, purchase pre-checks, and a **forced mid-transaction failure proving deduct+grant+ledger+audit all roll back together**.
- `lib/server/idempotency.test.ts` — key validation, canonical/fingerprint behavior, every begin outcome, stale takeover, retention replacement, release semantics, per-player key scoping.
- `components/mountGuards.test.ts` — +5 static guards: server-path buy (no local `purchaseItem(` in storefront), buy disabled until server catalog, `currentBalance` resync + success-after-await ordering, `economy.updated` listener present, Idempotency-Key header wiring.

`lib/server/fakeDb.ts` (test-only) was extended to match the real surface: `idempotencyRecord` CRUD with P2002, `inventoryItem.create` PK conflict, `ledgerEntry.aggregate`, `gte/decrement` operator support, compound-key matching, and a `$transaction` that snapshots/restores on throw **and queues transactions** (mirrors PostgreSQL row-lock serialization — see §8 finding 3).

## 8. Live findings fixed inside this phase

1. **Stale generated Prisma client → all write routes 500 on first live smoke.** `prisma migrate dev` applied the migration but the generated client in `node_modules` did not include the new `idempotencyRecord` delegate (`db.idempotencyRecord === undefined`); mocked tests couldn't catch it because fakeDb implements the delegate. Diagnosed with a stepwise DB probe (create → tx → aggregate → idempotent completion all pass once regenerated), fixed with `npx prisma generate` + dev-server restart (dropped the cached module). Rule recorded: **run `npx prisma generate` explicitly after every schema change.**
2. **jsonb key order on replay.** The stored replay summary comes back through Postgres `jsonb`, which does not preserve key order — value-identical replay bodies failed a byte-compare in the smoke script. The server code needed no change; the script now asserts deep equality (RFC 8259: JSON objects are unordered). Contract's "same status/body" is interpreted as JSON deep equality — recorded in §14.
3. **fakeDb transaction interleaving.** The concurrency test initially let a loser's snapshot-restore wipe a winner's in-flight rows (real PostgreSQL serializes conflicting writers via row locks; the fake didn't). Fixed by queueing `$transaction` executions in fakeDb — mocked-only issue; the real database semantics were already correct.

## 9. Schema/migration changes and additive-safety evidence

- Migration: **`20261010113031_b6_economy_idempotency`** — one new table `IdempotencyRecord` (`profileId` FK → PlayerProfile ON DELETE CASCADE, `endpoint`, `key`, `fingerprint`, `status`, `httpStatus`, `summary` jsonb, `expiresAt`, `createdAt`) with `@@unique([profileId, endpoint, key])` and lookup indexes; `PlayerProfile` gains only a Prisma-side relation (no column change).
- SQL diff reviewed before apply: `CREATE TABLE`/`CREATE INDEX` only — **no `ALTER` on any existing table**; `prisma migrate status` → up to date.
- B2–B5 data preserved: both pre-existing accounts (the user's own and the B5.5 test account) remain intact and queryable after the migration and after cleanup; all auth/sessions/audit rows for them survive untouched.

## 10. Exact changed/new files

New: `lib/server/catalog.ts`, `lib/server/idempotency.ts`, `lib/server/economy.ts`, `app/api/v1/shop/route.ts`, `app/api/v1/shop/purchases/route.ts`, `app/api/v1/rewards/rules/route.ts`, `app/api/v1/rewards/status/route.ts`, `app/api/v1/dev/rewards/route.ts`, plus the 6 test files listed in §7.
Modified: `prisma/schema.prisma` (+migration), `lib/server/http.ts` (3 codes + `currentBalance`), `lib/server/audit.ts` (`ECONOMY_AUDIT_EVENTS`), `game/backend/contract.ts` (DTOs + codes), `components/apiClient.ts`, `components/useGameSync.ts`, `components/screens/ShopScreen.tsx`, `lib/server/fakeDb.ts`, `components/mountGuards.test.ts`.
Untouched: everything else — B0–B5 routes/helpers (except the additive edits above), `game/bridge.ts`, scenes, assets, audio, auth flow, `/preview`.

## 11. Manual browser checks (live, `/`)

Signed in through the real UI (smoke-created account), then: Play → exactly 1 Phaser canvas, HUD `DRAFTCOIN 0` (server truth for a fresh account); Shop tab shows the server catalog with "(server price)" labels and 47 products, Buy enabled only after catalog load; **Dev claim → balance 20** with confirmation message; **Buy 25 with 20 → honest shortfall message** ("costs 25 and you have 20"), balance unchanged, nothing granted; **claim again → 40**; **Buy → success**: balance 15, "Purchased … balance is now 15.", OWNED badge + "In inventory" + "Wear it now"; HUD DraftCoin **15** (sync/refetch propagated); console: **no JS exceptions** (only the expected 401 pre-login and 409 insufficient-funds resource logs); **full page refresh → session persisted** (Play + email, no login form) and HUD still 15 from `GET /game/state`, canvas still mounted exactly once. Not browser-exercised (covered by HTTP smoke/mocked tests instead): the cap-reached UI message and a cross-tab `economy.updated` round trip.

## 12. Verification: phase_b6 §12 checklist mapping

(1) unit/route tests → 374/374; (2) tsc → 0; (3) build → 0; (4) `prisma validate` → valid; (5) `migrate status` → up to date; (6) live smoke → 26/26; (7) `/, /preview, /health` → `/health` 200 and `/`, `/preview` render (game + preview exercised on `/` in §11; `/preview` unaffected by any changed file and untouched by this phase); (8) auth UI → unchanged files, exercised in §11; (9) regression + a11y → tsc/build/mount guards green, menu buttons are real `type="button"` elements with `role="status"` feedback (seen live); (10) Playwright — **not run** (the project has no Playwright suite; manual browser pass used instead, as in B4/B5).

## 13. DB cleanup (phase_b6 §13 — tagged records only)

Removed every B6-created record: 6 `b6.smoke*` accounts (3 smoke runs × 2) with dependents — 15 ledger rows, 3 inventory rows, 17 idempotency records, 7 sessions, 6 auth tokens, 10 `economy.purchase` audits, 6 profiles, 6 users — plus 1 probe audit row (tagged `requestId: "probe"`, orphaned to NULL by the audit FK's `ON DELETE SET NULL` when the probe deleted its own user; lesson: delete audits before users in future cleanups). Final DB state: 2 pre-existing users (the user's own account + the B5.5 test account) with their 18 auth-only audit rows, **0** ledger/inventory/idempotency rows, **0** `economy.*` audits, 0 stray `b6.*` users.

## 14. Interpretations, deviations, and contract amendments

- `INSUFFICIENT_FUNDS` as a distinct 409 code with a `currentBalance` rider (mirrors B5's `currentVersion`) — contract §4 required "insufficient funds … includes shortfall" but didn't name the code; recorded here as an amendment.
- Idempotency outcome is completed **inside** the purchase/reward transaction (literal reading of phase_b6 §6 step 9), stricter than "store after success".
- Failed attempts **release** the reservation (only 2xx outcomes are stored for replay) so an honest retry with the same key can execute; the daily cap and owned-check independently protect against double-earning/double-charging.
- Replay window = 24 h retention; past it a same-key retry re-executes (purchases self-protect via the owned check → 409; rewards via the UTC cap).
- Reward requests require `Idempotency-Key` (phase plan: "idempotency keys on reward/purchase requests"), including the dev fixture; the fixture fingerprint covers the endpoint only (it takes no body).
- Ledger sign convention taken from the existing schema/contract comment: credits positive, purchases negative (phase doc said stop if unspecified — it is specified).
- `rewards/status` on a missing profile returns zeroed safe defaults (B5 read philosophy, no create-on-read); `rewards/rules` is global config and returns regardless.
- Capped reward = 200 with `awarded: 0, capped: true` (not an error) — MASTER §8.3.
- Replay body equality = JSON deep equality (key order may differ through jsonb).
- `profile.version` (local storage schema version) is not an economy version; ShopScreen fetches a fresh `expectedVersion` per click.

## 15. Known limitations, recommended next phase

Carried: process-local rate limiter and SSE hub (no cross-instance guarantee), no SSE replay (B12), production email delivery blocked, bcrypt 72-byte limit, no forgot-password UI, local send cost/earn (spend 5 / earn 20) stays client-only until B11.
B6-specific: production-mode (`next start`) smoke not re-run this phase — live pass was dev-server only; the production 404 gate is covered by the NODE_ENV test (recommend a prod smoke at B7); capped-claim UI message and cross-tab SSE not exercised in the browser; audit FK `SET NULL` cleanup ordering caveat (§13).
Next phase: **B7 (outbox/job queue foundation)** — awaiting explicit user approval.

## 16. Confirmation: B7 and provider integrations were NOT started

No B7 outbox/job tables or workers; no Gmail/Google OAuth/Gemini/Calendar/wallet/production-email code touched. Phase plan prerequisites for B7 ("B6 approved") remain unmet until the user approves.

## 17. Explicit stop — pending user approval

Stopped here per phase_b6 §16. `docs/B6_REPORT.md` produced; `phase_b6.md` §17 and `BACKEND_ARCHITECTURE.md` §20 execution records appended. B7 must not begin without explicit user approval.
