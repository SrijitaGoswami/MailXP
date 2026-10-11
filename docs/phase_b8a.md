# Phase B8a — Google sign-in (Continue with Google) + verification convenience

Approved addendum to B8 (user decisions 2026-10-10, question round after the
B8 report). B9 (Gmail fetch) stays ON HOLD until B8a is reported and the user
explicitly approves it.

## 1. User decisions (2026-10-10, question round)

1. **"Continue with Google" is added as an entrance** (beyond the B8 link-only
   design): one click takes the player through Google's own consent/verification
   screen (the GitHub/Facebook pattern — MailXP never sees the Google password)
   and lands back in the game signed in.
2. **Existing password account + same Google email → sign INTO that account**
   (no duplicate, no lost progress; audit-logged). The Google identity is
   additionally linked (Gmail consent) in the same click.
3. **One-click consent**: the sign-in consent asks for identity
   (`openid email`) AND `gmail.modify` together — logged in AND connected in
   one round-trip (B9 then reads the mail).
4. **"Resend verification email" button** on the Settings Google card so new
   accounts can unlock Connect Google without the console (dev mode surfaces
   the token; a "Verify now (development)" helper completes the flow in-UI).

## 2. Scope

In scope:

- `intent: "signin"` on `POST /api/v1/integrations/google/start` — works
  WITHOUT a session (a signed-out visitor starts it), IP-keyed `oauth` rate.
- Callback branch for sign-in: consume the unbound state, exchange code,
  fetch provider-attested identity, **locate-or-create** the MailXP account,
  issue a session (rotation on login parity), link the Google identity, audit,
  redirect `/?googleOAuth=signin` with the session cookie set.
- Schema: `OAuthState.userId`/`sessionId` become nullable (sign-in states are
  unbound — the 256-bit state itself is the CSRF defense) — additive migration.
- New audit events `auth.register_google` / `auth.login_google`.
- Frontend: "Continue with Google" button on the AuthPanel gate; shared
  `?googleOAuth=` outcome handling for signed-OUT players (previously only
  Settings handled it); Settings resend-verification + dev verify buttons.

Out of scope (unchanged phase discipline):

- B9's Gmail reading — no Gmail API call happens in B8a.
- Password-set-after-Google-signin UX: a Google-created account has a random
  (discarded) password; the existing B4 "forgot password" flow remains the
  documented path to set a real password later.
- Google sign-in does NOT bypass the B8 Connect verified-email gate for the
  link intent — the gate stays exactly as B8 shipped it.

## 3. Design

### 3.1 State (googleOAuth.ts)

- `StateIssueInput` gains `userId: string | null` / `sessionId: string | null`
  (link/reconnect rows keep both; sign-in rows store NULL for both).
- `intent: "signin"` is a first-class intent. `consumeSignInState()` validates:
  hash lookup → `intent === "signin"` → BOTH bindings NULL → unconsumed →
  unexpired → guarded single-use claim (same atomic pattern as
  `consumeOAuthState`). A bound (link) state is NEVER consumable here and a
  sign-in state is NEVER consumable by the bound path (`row.userId !==
  bound.userId` already fails closed for null).
- `peekOAuthState()` is a read-only hash lookup used by the callback to pick
  the branch BEFORE consuming (intent is known from the row, never from the
  browser).

### 3.2 Start route (`google.connectStart`)

Body: `{ intent?: "link" | "signin", accountId?: string }` — unknown intent
value or `intent:"signin"` + `accountId` → 400 VALIDATION_ERROR. Sign-in path:
strict Origin → parse → `oauth` rate keyed `signin:<ip>` → `beginGoogleSignIn`
(config check first, variable NAMES only; unbound state mint; server-configured
redirect URI). No session, no verified-email gate — Google has just verified
the email on its own screen.

### 3.3 Locate-or-create (resolveSignInTarget)

Order of authority:

1. `googleSub` linked and `connected` → sign into THAT player (the stable
   subject wins over any email coincidence).
2. Else email matches an existing MailXP account → sign into it
   (`deletionRequestedAt` set → refused, redirect token `account`).
3. Else create: `passwordHash = bcrypt(random 256-bit secret)` with the secret
   DISCARDED (no password login is ever possible for this account; password
   reset remains the path to set one), `emailVerifiedAt = now` (Google
   verified it), `PlayerProfile` with the standard B4 defaults — identical to
   the register route. P2002 email race → re-resolve once.

### 3.4 Callback sign-in branch

Same invariants as the link branch (state consumed before any exchange,
identity only from userinfo with `email_verified`, no secrets in Location):
then ONE transaction: rotation (revoke presented session, login parity) →
locate-or-create → `createSession` → `linkGoogleIdentity` (conflict throws a
sentinel → full rollback + `google.link_conflict` audit + `conflict` redirect;
unreachable in practice because rule 1 above resolves connected subs first,
but fail-closed anyway) → audits (`auth.register_google` when created, else
`auth.login_google`; plus `google.connected|reconnected|transferred`). Redirect
`/?googleOAuth=signin` carrying the NEW session cookie. Redirect tokens for
sign-in: `signin | denied | state | nocode | provider | unverified | conflict |
config | account`.

### 3.5 Frontend

- `components/oauthOutcome.ts` — shared safe-token message map (adds
  `signin`, `account`) + `readOAuthOutcomeToken()` that reads `?googleOAuth=`
  ONCE and scrubs it. Used by AuthPanel (signed-out) and Settings (signed-in).
- `AuthPanel` — "Continue with Google" button under the form (divider "or"):
  `startGoogleSignIn()` → `window.location.assign(authUrl)`. OAuth outcomes
  that land signed-out show as the panel's alert.
- `SettingsScreen` — unverified branch gains "Resend verification email"
  (POST existing endpoint; dev response surfaces the token) + "Verify now
  (development)" (POST verify-email) after which the Google status refetch
  reveals the Connect button. No new endpoints, no new DTOs (`GoogleStartDto`
  unchanged).

## 4. Tests (spec §11 discipline — mocked storage, stubbed Google fetch, real crypto)

- googleOAuth.test.ts: unbound state mint/consume (ok, replay, expired, wrong
  intent, bound-row rejection, null-binding rejection); resolveSignInTarget
  (existing account, sub-wins-over-email, create+verify+profile+unusable
  password, deletion-pending refusal, released-sub + email match).
- google.test.ts (start): sign-in without session → 200 + unbound state row;
  invalid intent / signin+accountId → 400; CSRF still enforced; separate IP
  rate key; 503 when unconfigured.
- callback.test.ts: sign-in happy path (created account, cookie set,
  audits, clean Location); existing-account sign-in + rotation; sub-wins;
  deletion-pending → `account`; replay/state gates; link-state not consumable
  via sign-in branch; denied/unverified/provider paths create nothing.
- apiClient.test.ts: `startGoogleSignIn` posts `{intent:"signin"}`.

## 5. Stop condition

Implement → vitest/tsc/build/prisma-verify sequence → live smoke (scripted
flows + real browser consent if the user wants) → addendum report in
docs/B8_REPORT.md (§15) → STOP and wait for explicit approval before B9.

## 6. Execution record (2026-10-10)

- Migration applied: `20261010163847_b8a_google_signin_state` (OAuthState userId/sessionId nullable); Prisma validate and migration status both green, 7/7 migrations current.
- Final sequential verification (after the linked-sub deletion guard): `npx vitest run --reporter=dot` 570/570 across 40 files; `npx tsc --noEmit` exit 0; `npm run build` exit 0; `npx prisma validate` valid; `npx prisma migrate status` up to date.
- Live smoke: 22/22 checks passed against the real dev server/PostgreSQL, including unbound hash-only state, Origin gate, validation, IP rate cap, one-time denial/replay, missing code, and real Google token-endpoint rejection of a fake code. Smoke-owned state rows were cleaned.
- Real Google E2E: existing `manikaabir6@gmail.com` account signed in with no duplicate; `auth.login_google`/`google.reconnected`, connection remains sealed, previous session revoked, one fresh session. A second browser round-trip also signed into existing `srijitagoswami273@gmail.com` and created another connected Google identity; it was retained and disclosed in report §15.
- Browser: gate exposes Continue with Google; safe cancellation notice displayed and query scrubbed; resend verification → development token → Verify now → verified status/Connect button succeeded. One Phaser canvas remained mounted. One expected signed-out `GET /me` 401 was seen; no app exception observed.
- Cleanup: the exact temporary account created for the verification-button test (`b8a.resend.test@example.com`) was erased using the FK-safe order from `deletion.ts`; final user count returned to 3. Final counts: 3 users, 2 connected Google rows, 3 OAuthState rows (two consumed, one pending link state); no test account remains. The pending OAuth state expires normally and was left untouched.
- Report: `docs/B8_REPORT.md` §15. **Stopped before B9; explicit approval still required.**
