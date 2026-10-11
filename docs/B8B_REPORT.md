# B8b Report — One-Gmail-Per-MailXP-Account Hardening

Phase: B8b (spec `docs/phase_b8b.md`) · Date: 2026-10-11 · Status: **COMPLETE — stopping for explicit approval before B9.**

## 1. Completion status, blockers, deferred items

Complete: the one-Gmail-per-MailXP-account rule is now enforced in code AND in the database. A user may hold at most ONE active/connected Google mailbox; a Google identity may be linked to at most one MailXP user (unchanged, unique `googleSub`). A user who already has a different connected Gmail is refused (`conflict`) instead of silently gaining a second mailbox; switching requires an explicit disconnect/release first. A reviewed raw-SQL partial unique index enforces the invariant at the PostgreSQL layer so no code path — reconnect, sign-in, release, disconnect, or a concurrent callback race — can bypass it. Settings now shows exactly one current Gmail with a clearly explained "Switch Gmail" (disconnect-first) flow. **No blockers; no stop condition triggered.**

This phase also resolved a previously-undocumented database state (§2) and performed the approved cleanup (§3) — the first time a valid-token **real** Google remote revocation was actually exercised (B8/B8a never did).

Deferred (per spec, not gaps): Gmail message fetching/history/labels/push (B9), Gemini (B10), send/draft/archive/label actions (B11), Calendar (B12), production KMS swap, OAuth-state purge job. All remain out of scope and untouched.

## 2. Baseline: safe inspection of the existing connections (phase_b8b.md §1)

Inspected with **safe fields only** — connection ID, owner user ID, email, status, timestamps. **Never** selected or printed encrypted token columns, OAuth state hashes, `.env` values, client secrets, or encryption keys.

**Discovered state (2026-10-11) — it had drifted from the B8a report, which documented 2 connections:**

4 MailXP users:
| User ID | Email | Verified |
|---|---|---|
| `01a12532…4f30` | manikaabir6@gmail.com | yes |
| `01a1253e…e3f3` | wasd.keys.test@example.com | no |
| `01a1268e…0177` | srijitagoswami273@gmail.com | yes |
| `01a12707…d536` | aabirmanik1@gmail.com | yes |

**3 Google connections, all `connected`** (not 2 as B8a recorded):
| Connection ID | Owner | Email | Connected at |
|---|---|---|---|
| `01a12674…fbe2` | manikaabir6 user | manikaabir6@gmail.com | Oct 10 15:36 |
| `01a126ec…58ad` | srijitagoswami273 user | srijitagoswami273@gmail.com | Oct 10 17:46 |
| `01a12707…ebfe` | aabirmanik1 user | aabirmanik1@gmail.com | Oct 10 18:16 |

The third connection (`aabirmanik1`, 18:16) post-dates the B8a report and was undocumented. **Each connection belonged to a different MailXP user — no user had multiple active connections** (the invariant already held in the data). There was also an unverified, connection-less leftover test account `wasd.keys.test@example.com`.

## 3. Approved cleanup (user decision 2026-10-11)

User instruction: start fresh — one email, one owner per MailXP account. Decision: **release/disconnect all 3 connections**, preserving every account, profile, inventory, DraftCoin ledger, and game row.

Cleanup mirrored the normal `google.accountDisconnect` route semantics exactly (a throwaway script, since no live user session exists for all three owners):
1. **Best-effort remote revoke BEFORE the local delete** — only if configured + key present + ciphertext readable; any failure → `revoked=false`, never blocks the local unlink.
2. **One transaction per row**: `deleteMany(id + userId)` + audit `google.disconnected` with the honest `revoked` boolean + a `reason` note.
3. Never touched `User`/`PlayerProfile`/inventory/ledger/game data.

Result: **all 3 disconnected, `revoked=true` for all three** — Google's real revoke endpoint confirmed each. This is the first live exercise of a valid-token remote revoke (B8 §11.7 explicitly noted it had never been run). `CONNECTION_COUNT_AFTER 0`. No broad `deleteMany`, no reset, no truncation, no account recreation. The leftover `wasd.keys.test@example.com` account was left untouched (no Google connection; does not violate the rule).

## 4. Implemented invariant and hardening

**Database (phase_b8b.md §5)** — reviewed raw SQL, additive migration `20261010201518_b8b_one_gmail_per_user`:
```sql
CREATE UNIQUE INDEX "GoogleConnection_userId_connected_key"
  ON "GoogleConnection"("userId")
  WHERE status = 'connected';
```
At most ONE connected row per user; released historical rows remain and do NOT trip the index. Together with the pre-existing UNIQUE `googleSub` (one Google identity → one user, ever) this yields a partial injective connected-mailbox mapping. A plain transactional `CREATE UNIQUE INDEX` was used rather than `CONCURRENTLY` (the table was empty post-cleanup, so nothing to lock, and it stays inside Prisma's transaction). Prisma cannot express a partial index in the datamodel — documented as **expected drift** in a schema comment above `OAuthState` (`prisma migrate diff` will always report it missing; that is not a bug).

**Code (`lib/server/googleOAuth.ts`, `linkGoogleIdentity`)** — two additions:
- **Pre-check**: before any create, if THIS user already holds a DIFFERENT connected `googleSub`, return `{ok:false, reason:"conflict"}` — never add a second mailbox, never overwrite. Released rows do not block (they are the sanctioned transfer precondition). Same-sub reconnect still updates in place.
- **Race guard**: the create is wrapped so a `P2002` from the partial index (or unique sub) — the concurrent-callback case — maps to the same safe `conflict`, never surfacing SQL/Prisma details.

**Sign-in (phase_b8b.md §4)**: an email match to an account that already has a different active Google identity raises the conflict sentinel inside the callback transaction → the whole transaction (session + any link) rolls back → safe `conflict` redirect, no second connection, no duplicate account, no silent Gmail switch. Browser-supplied identity is still ignored; identity still comes only from Google's verified userinfo.

**Outcome message (`components/oauthOutcome.ts`)**: `conflict` now explains both cases and points to the resolution — use the already-linked identity, or disconnect the current one first to switch.

**UI (`components/screens/SettingsScreen.tsx`, phase_b8b.md §6)**: removed the "Connect another Google account" affordance. The card now shows exactly ONE current Gmail (connected rows only; released history is not offered) + Disconnect, plus a "Switch Gmail" explanation (each account keeps one Gmail — disconnect first, then connect; disconnect removes MailXP's saved connection and asks Google to revoke, never deletes your Gmail/messages). "Connect Google" appears only when nothing is connected.

## 5. Tests (mocked storage via fakeDb, stubbed Google fetch, real crypto)

`lib/server/fakeDb.ts` gained `findFirst` on `googleConnection` and now enforces the partial-unique invariant on `create` (throws `P2002`) so tests genuinely exercise the DB rule, mirroring the real index.

Added **6 new tests** (576 total, up from 570):
- `googleOAuth.test.ts` — B8b block: a user with a DIFFERENT connected sub is refused (no second mailbox; original sub + credentials untouched); same-sub reconnect still allowed; after explicit release the same user MAY connect a different sub (switch flow); the DB invariant rejects a second connected row (P2002); released historical rows for one user do NOT trip the invariant.
- `callback.test.ts` — sign-in email-match to an account with a DIFFERENT active connection → `conflict`, no Set-Cookie, exactly one connection (original sub) retained, no duplicate account, `google.link_conflict` audited, no identity leak in audits.

Existing coverage retained: no-connection connect; same-sub reconnect; different-user sub conflict; concurrent-callback guard; sign-in chooses linked account; explicit switch; pending-deletion guard; identity cannot link to two users; token redaction/no plaintext fallback; account-deletion cleanup; auth/economy/SSE/worker/game regressions.

## 6. Final sequential validation (unchanged final state)

| # | Command | Result |
|---|---|---|
| 1 | `npx vitest run` | **576/576 passed, 40 files** |
| 2 | `npx tsc --noEmit` | **exit 0** |
| 3 | `npm run build` | **exit 0** |
| 4 | `npx prisma validate` | **valid** |
| 5 | `npx prisma migrate status` | **up to date, 8 migrations** |
| 6 | live PostgreSQL (ownership + uniqueness) | **pass** (below) |
| 7 | browser `/` and `/preview` | **exactly one canvas each; 0 MailXP console errors** |

**Live PostgreSQL verification (6)**: confirmed `GoogleConnection_userId_connected_key` exists with the correct `WHERE (status = 'connected')` definition; proved the invariant live by creating a throwaway user + first connection (ok) then a second (rejected `P2002`); erased the throwaway user via FK-safe delete. Final: 4 users, 0 connections, 0 test rows left.

**Browser (7)**: `/` and `/preview` each show exactly one Phaser canvas. The only console errors are the **Agentation dev-tooling** CORS failures (`localhost:4747`) and the expected signed-out `GET /api/v1/me 401` — identical to prior-phase disclosed noise, not MailXP application errors (filtered set = 0 app issues).

## 7. Changed / untouched files

**Created**: `prisma/migrations/20261010201518_b8b_one_gmail_per_user/migration.sql` · `docs/B8B_REPORT.md`.

**Modified**: `prisma/schema.prisma` (drift-note comment on the partial index) · `lib/server/googleOAuth.ts` (`linkGoogleIdentity` pre-check + P2002 race guard) · `lib/server/fakeDb.ts` (`findFirst` + partial-unique enforcement on create) · `components/oauthOutcome.ts` (richer `conflict` message) · `components/screens/SettingsScreen.tsx` (one-mailbox card + Switch-Gmail flow, removed "Connect another Google account") · `lib/server/googleOAuth.test.ts` (+5) · `app/api/v1/callbacks/googleOAuth/callback.test.ts` (+1).

**Untouched**: `game/bridge.ts`, all Phaser scenes/gameplay (`game/**`), `public/assets/mailxp/**`, `app/page.tsx`, `app/layout.tsx`, `next.config.ts`, `instrumentation.ts`, all B0–B8a migrations, session/password/economy/http/logger/catalog/sseHub/prisma/jobQueue/outbox/worker modules, and every auth/shop/rewards route. The user's `.env` was never created/edited/read for values. No pre-existing account, profile, inventory, DraftCoin ledger, or game row was deleted.

## 8. Security / redaction confirmation

Real Google-hosted OAuth, server-side code exchange, verified-identity enforcement, AES-256-GCM sealed refresh tokens, hash-only single-use state, Origin/CSRF/rate-limit protections, and 404-not-403 ownership are all preserved. No Gmail message APIs were added — source scans still show no `gmail/v1`, no `users.messages/threads/labels/drafts`, no Calendar. Inspection, cleanup, and verification selected/printed only safe fields — never token columns, state hashes, `.env` values, client secrets, or keys. Uniqueness races map to a safe `conflict`, never SQL/Prisma details.

## 9. Limitations and B9 handoff

- The partial index is enforced in PostgreSQL; the in-memory `fakeDb` mirrors it for tests but a real DB is the source of truth (drift note in schema).
- `migrate dev` cannot regenerate this index from the datamodel (Prisma limitation) — future schema edits must not assume `migrate diff` sees it.
- Inherited: process-local rate limits, no OAuth-state purge job, env-key encryption (KMS = production swap), single-process worker.
- The database now starts from a clean slate (0 connections); the user reconnects a single Gmail through the normal Connect flow.
- **For B9**: mailbox sync must read only stored granted scopes; per-mailbox isolation starts from `status`; use `openStoredRefreshToken` (fail-closed); revoked connections degrade to "not connected", not retry storms.

**Recommendation: B8b is complete — approve B9 (Gmail connection/sync) to proceed.**
