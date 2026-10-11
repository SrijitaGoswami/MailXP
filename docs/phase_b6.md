MailXP — Phase B6: Server-Authoritative Economy and Shop Purchases
Prerequisites: B0–B5 complete. Scope: B6 only. Create docs/B6_REPORT.md, then stop for explicit approval before B7.
1. Mission
Make DraftCoin, shop purchases, inventory ownership, ledger entries, and any explicitly approved XP awards server-authoritative. Use the existing Next.js + React + Phaser repository, B4 authentication, B5 game-state API, B5 ledger model/read route, and B5 SSE hub. Do not create a separate backend project or redesign the game.
2. Mandatory discovery
Before editing:
1. Read MASTER_REQUIREMENTS.md, BACKEND_PHASE_PLAN.md, BACKEND_ARCHITECTURE.md, BACKEND_API_CONTRACT.md, this phase file, and available B0–B5 reports.
2. Inspect actual current shop/catalog definitions, all client-side coin/purchase/XP/inventory mutations, PlayerProfile, InventoryItem, LedgerEntry, /api/v1/game/state, /api/v1/game/ledger, /api/v1/events, lib/server/sseHub.ts, and existing API/error/session helpers.
3. Record baseline tests/build/Prisma status.
4. Use the contract and existing requirements as authority. Do not invent item prices, ledger sign conventions, XP awards, route shapes, or idempotency semantics. If a required rule is missing, stop and ask for approval.
5. Remember B5’s documented limitation: client-only earnings/purchases do not persist; server state wins on refetch.
3. Non-negotiable boundaries
- Work in the existing repository. Preserve Next.js, React, Phaser, /, /preview, assets, audio/accessibility/touch behavior, SSR safety, and the single unconditional Phaser canvas mount.
- React/Phaser communication remains through game/bridge.ts; no second event bus.
- No network/database work in OfficeScene.update().
- Reuse B3/B4 HTTP envelope, request IDs, session validation, Origin checks, rate-limit helpers and redaction.
- Never trust client-supplied user/profile IDs, item prices, balance-after-purchase, ownership, XP, levels, reward amounts or client success claims.
- No arbitrary “grant coins” endpoint, fake reward, or client-submitted reward value.
- No Gmail/Google OAuth/Gemini/Calendar/Pera Wallet/ALGO/NFTs, production email provider, quests/notifications, or account-erasure worker.
- Do not run prisma migrate reset, drop tables, or destructively recreate data.
- Do not begin B7.
4. API routes and contract
Inspect docs/BACKEND_API_CONTRACT.md and the phase plan for the exact B6 shop/economy routes, methods, payloads, idempotency header/key format, response shape, and error codes. Implement only authorized routes. Do not invent endpoints or alter B5 public shapes without a contract requirement.
B5 already provides:
- GET /api/v1/game/state
- PATCH /api/v1/game/preferences
- GET /api/v1/game/ledger
- GET /api/v1/events
If the contract is ambiguous about a required route or idempotency behavior, stop and request approval.
5. Canonical catalog
- Inspect existing shop/item definitions and identify the authoritative source for item IDs, prices, category, ownership rules and eligibility.
- Server computes price and eligibility. Reject or ignore client-supplied price, balance, ownership and arbitrary item fields.
- Keep IDs and ownership semantics compatible with the existing game.
- Implement a catalog read route only if the contract assigns it to B6; do not add unapproved routes.
- Unknown, disabled, already-owned or non-purchasable items must fail with a stable contract error and no mutation.
- Avoid catalog duplication/drift. Shared catalog modules imported by client and server must contain no secrets or server-only dependencies.
If prices or catalog rules cannot be grounded in project requirements, stop rather than inventing them.
6. Atomic purchase transaction
For each valid purchase, a single database transaction must:
1. Resolve the authenticated player/profile from the validated B4 session.
2. Validate the idempotency key according to the contract.
3. Resolve item and price from the canonical server catalog.
4. Verify affordability and purchase eligibility.
5. Deduct DraftCoin.
6. Insert inventory ownership.
7. Insert exactly one LedgerEntry with correct type, amount/sign convention, reason and source reference.
8. Increment profile version if the contract requires it.
9. Persist enough idempotency outcome data to safely replay a successful result.
Any failure must roll back all steps. Never deduct without granting, grant without deducting, or create a ledger row for a failed purchase. Use atomic/conditional balance checks or transaction-safe isolation so concurrent requests cannot overspend.
7. Durable idempotency
- Follow B1’s exact idempotency format and conflict behavior.
- Use database uniqueness/constraints, not only an in-memory cache.
- Same player + same key + same semantic request must execute once and replay the contract-defined result.
- Same key with a different request must return the contract-defined conflict without mutation.
- Concurrent retries with one key must cause one purchase and one ledger entry.
- If the existing schema lacks a safe durable idempotency record, propose the smallest additive schema change, review the SQL, and document its uniqueness constraints before applying.
- Never blindly retry a request whose transaction outcome may already have committed; reconcile via the durable idempotency record first.
8. Ledger integrity
Use B5’s LedgerEntry model and response shape: id, type, amount, reason, sourceRef, createdAt.
- Every successful purchase writes exactly one ledger row.
- Failed, unaffordable, invalid, already-owned, conflicting, and Origin-rejected requests write no purchase row.
- Preserve stable pagination (createdAt DESC, id DESC) and player isolation.
- Follow the contract’s amount sign convention. If unspecified, stop and ask.
- Never put email content, passwords, cookies, tokens, or secrets in ledger metadata.
9. XP and level authority
Inspect the master requirements and phase plan for explicitly approved B6 XP rules.
- Implement XP only if the qualifying action, amount and level formula are already defined and assigned to B6.
- Never accept arbitrary client-submitted XP or reward amounts.
- If reward rules belong to a later phase or are unspecified, leave XP/level unchanged and report the dependency; do not invent values or move later-phase rewards into B6.
- If level calculation is in scope, keep it deterministic and server-authoritative and test boundary levels.
10. Client/game integration
- Update the existing shop UI to use the canonical server catalog and approved purchase API.
- Show loading, success, insufficient-funds, already-owned, invalid-item and conflict/retry states using contract error codes.
- Do not show success or mutate authoritative balance before server confirmation.
- After purchase success, refetch game state and ledger using the established B5 sync/client API.
- Publish economy.updated through the existing SSE hub only after the transaction commits; failed purchases must not emit success events.
- Ensure the event is player-scoped and compatible with B5 reconnect/refetch and polling fallback.
- Remove or isolate client-only purchase mutations so local state cannot override server balance/inventory after refresh, sign-in, reconnect or polling.
- Explain what happens to legacy local demo coins/items; preserve B5’s legacy backup.
- Keep the Phaser canvas mounted once across purchases, errors, auth changes and state refreshes. No network calls in Phaser’s frame update.
11. Security and reliability
- Every mutation requires a valid B4 session and strict same-origin/Origin validation before DB work.
- Apply B1 rate limits where appropriate; note that B4 limits are process-local, not distributed across Cloud Run instances.
- Validate bodies strictly and scope all writes to the authenticated player’s profile.
- Map Prisma/constraint failures to safe contract errors; do not expose SQL, stack traces or internal data.
- Handle transaction and uniqueness races deliberately.
- A lost response after commit must be recoverable with the same idempotency key without spending twice.
- Do not log raw idempotency keys or secrets.
- Emit SSE only after commit and only to the correct player.
12. Tests and acceptance gates
Add tests following existing Vitest patterns and distinguish mock from live evidence. Cover:
- Canonical catalog prices and item eligibility.
- Authentication and player A/B isolation.
- Origin rejection before mutation.
- Invalid item/body, client-supplied price/balance, already-owned and insufficient balance cause no changes.
- Successful purchase updates balance, inventory, version (if required), and exactly one ledger entry atomically.
- Transaction failure rolls back every effect.
- Concurrent purchases cannot overspend or duplicate inventory/ledger effects.
- Sequential/concurrent idempotent retry performs one effect; same key/different request conflicts without mutation.
- Ledger pagination/order and player isolation after purchases.
- economy.updated is emitted after commit only; failed purchases emit no success event.
- Client UI uses server prices and handles failed/uncertain requests honestly.
- Refresh, sign-in, SSE reconnect and polling preserve authoritative economy state.
- B2–B5 tests, /, /preview, health and Phaser mount-once behavior remain green.
Run checks sequentially, never concurrently:
1. npx vitest run
2. npx tsc --noEmit
3. npx next build
4. npx prisma validate
5. npx prisma migrate status
6. Relevant live DB/API smoke tests for successful, failed, concurrent and repeated purchases.
Use the repository’s actual scripts if different. If a command fails, fix within B6 scope and rerun the full sequence. Do not claim a check passed unless it ran successfully.
13. Schema and migration safety
- Prefer existing PlayerProfile, InventoryItem and LedgerEntry.
- Any new idempotency table/columns must be additive, narrowly scoped, and protected by reviewed unique indexes/FKs.
- Review generated SQL before applying. Never reset/drop existing tables.
- Verify migration status and relevant schema after applying.
- Clean up only tagged test records created by B6. Never delete arbitrary player data.
- Report exact migration name and evidence that B2–B5 data/tables were preserved.
14. Required docs/B6_REPORT.md
Include:
1. Status, blockers and deferred work.
2. Baseline and final sequential command results.
3. Exact routes/request/response/error shapes.
4. Canonical catalog source and price authority.
5. Transaction sequence and rollback behavior.
6. Idempotency storage, uniqueness, replay and conflict semantics.
7. Ledger sign convention and examples.
8. XP/level decision and its source rule.
9. SSE event timing and player isolation.
10. Schema/migration details and additive-safety evidence.
11. Exact changed/untouched files.
12. Tests, live smoke results, and mock/live distinction.
13. Manual shop flow, refresh/reconnect, and Phaser mount checks.
14. Limitations and recommended next phase.
15. Confirmation B7/provider integrations were not started.
15. Stop conditions
Stop and request approval if route/idempotency semantics, canonical prices, ledger sign convention or XP rules are unspecified; safe atomic idempotency cannot be guaranteed; migration safety is ambiguous; a transaction could commit without a reconcilable idempotency result; client integration would require trusting economy state or remounting Phaser; or a core acceptance criterion cannot be honestly verified.
16. Final instruction
Implement B6 only. Make shop purchases and economy state server-authoritative with the approved contract, canonical server prices, atomic DB transactions, durable idempotency, ledger entries and post-commit SSE. Preserve the game and B5 architecture. Run checks sequentially, write docs/B6_REPORT.md, summarize actual results, and stop for explicit approval before B7.
17. Execution record (2026-10-10)
Discovery: contract §1.6/§4/§7.5, MASTER §8.1–8.3, shopConfig/profile purchase semantics, schema, B5 route/SSE/fakeDb/apiClient/useGameSync patterns. Baseline (single run): vitest 300/300 (24 files), tsc 0, build 0, prisma valid, migrate up to date.
Question round (user-approved options): (a) dev reward fixture = dev-only POST /api/v1/dev/rewards (404 in production) issuing through the same atomic service with the cap enforced; (b) rewards reads implemented now — GET /rewards/rules + /rewards/status; (c) economy values questReward=20 DraftCoin, dailyCap=100/UTC day, reset 00:00Z, XP/level deferred untouched; (d) every item ownable exactly once — re-purchase 409 CONFLICT, available = !owned, no multi-copy decor.
Implementation: additive migration 20261010113031_b6_economy_idempotency (IdempotencyRecord, @@unique([profileId, endpoint, key]), FK cascade); services lib/server/catalog.ts, idempotency.ts (canonical fingerprint, begin/complete/release, 2-min stale takeover, 24-h retention), economy.ts (conditional-update purchase tx: deduct → grant → ledger −price → economy.purchase audit → in-tx idempotency completion; in-tx UTC reward cap); routes shop (GET catalog), shop/purchases (POST, Idempotency-Key required), rewards/rules, rewards/status, dev/rewards (production gate first); http.ts +INSUFFICIENT_FUNDS/IDEMPOTENCY_MISMATCH/IDEMPOTENCY_IN_PROGRESS and FieldError.currentBalance; contract DTOs; client apiClient (header-carrying purchase/claim), useGameSync economy.updated→refetch, ShopScreen rewired to server catalog + per-click fresh expectedVersion + authoritative rollback (local purchaseItem kept isolated); fakeDb extended (idempotencyRecord/inventory/ledger aggregate/conditional ops + transaction snapshot-rollback with queue); 6 new test files + 5 mountGuards static guards.
Verification (sequential): vitest 374/374 (30 files), tsc 0, build 0 (21 routes), prisma validate + migrate status clean, live dev smoke 26/26, browser pass (login → claims → insufficient honesty → purchase → OWNED/HUD 15 → console clean → refresh persistence, canvas mounted exactly once). Cleanup: 6 b6.smoke* accounts + dependents (15 ledger, 3 inventory, 17 idempotency, 10 economy audits) + 1 probe-tagged audit removed; DB left with only the 2 pre-existing accounts, 0 economy rows.
Live findings fixed in scope: (1) generated Prisma client was stale after migrate (db.idempotencyRecord undefined → write routes 500) → npx prisma generate + dev-server restart, rule recorded; (2) jsonb reorders replay body keys → smoke asserts deep equality (contract "same body" = JSON deep equality); (3) fakeDb interleaved snapshots could wipe a winner's rows in the concurrency test → fake transactions queued to mirror PG row locks. Interpretations recorded in B6_REPORT §14 (INSUFFICIENT_FUNDS code + currentBalance rider, in-tx idempotency completion, release-on-failure, reward key requirement, ledger sign from schema, capped reward = 200). End state: docs/B6_REPORT.md produced; stopped before B7 awaiting approval.