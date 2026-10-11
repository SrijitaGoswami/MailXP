# MailXP — Frontend File Structure & Backend Connection Brief

**Audience:** the AI engineer (ChatGPT session) that will plan and build the backend.
**Written:** 2026-10-10, after Phase 7 (frontend complete).
**Companion reads:** `context.md` (project state), `docs/PHASE_7_REPORT.md` (current architecture),
`docs/FRONTEND_PHASE_PLAN.md` (what already shipped).

This one file must let you understand the running frontend well enough to design and
connect a proper backend — data model, API endpoints, sync, auth — phase by phase,
without breaking anything that already works.

---

## 1. Project at a glance

| Item | Value |
|---|---|
| App | **MailXP** — gamified mail-office game ("Deliver. Grow. Level Up.") |
| Stack | Next.js **16.3.8** (App Router), React **19.3.0**, Phaser **3.90.0**, TypeScript **5.9.3**, Tailwind **4** |
| Entry | `app/layout.tsx` → `app/page.tsx` → `components/AppShell.tsx` |
| Extra route | `app/preview/page.tsx` — asset-preview page (Scale.FIT box; keep working) |
| Commands | `npm run dev` (dev, port 3000) · `npx next build` · `npx tsc --noEmit` |
| Persistence today | **Browser `localStorage` only** — key `mailxp.profile.v1` |
| Network today | **Zero** — no API routes, no fetch, no auth, no database |
| Money today | "DraftCoin" is a simulated local number — no wallet, no chain, no payments (keep it that way) |
| Tests | No test framework (frontend phases ran honest manual/DOM verification) |

---

## 2. Annotated file tree (only load-bearing entries)

```
MailXP/
├─ app/
│  ├─ layout.tsx              Root layout (fonts, metadata)
│  ├─ page.tsx                The game page → renders <AppShell/>
│  ├─ globals.css             Design tokens (walnut/teal/cream CSS vars)
│  └─ preview/page.tsx        Asset-preview harness route (/preview)
│
├─ components/                ── React UI (owns all DOM a11y) ──
│  ├─ AppShell.tsx            Full-screen shell: title overlay, HUD cluster
│  │                          (Full screen + ☰ Menu), pause wiring, focus
│  │                          return, audio lifecycle, body class. THE ROOT.
│  ├─ GameMenu.tsx            Side-panel dialog + ARIA tablist, 6 sections.
│  │                          Keeps all sections mounted (drafts survive nav).
│  ├─ GameHud.tsx             Top-left chips: Lv · XP · DraftCoin · Tasks.
│  ├─ GameAnnouncer.tsx       sr-only aria-live region (status/dialogue).
│  ├─ PhaserCanvas.tsx        Mounts the Phaser game ONCE (never unmounts),
│  │                          fills viewport.
│  ├─ TouchControls.tsx       Corner D-pad → bridge `touch-move` commands.
│  ├─ useGameState.ts         React hooks: useGameSnapshot(), useProfile()
│  │                          (useSyncExternalStore over bridge/profile).
│  ├─ QuestPanels.tsx         Tasks section (quest list + totals).
│  ├─ ShopThumb.tsx           CSS-sprite product thumbnails.
│  └─ screens/                Menu sections:
│     ├─ ShopScreen.tsx       Buy (purchaseItem), Wear, Place-in-office.
│     ├─ CharacterScreen.tsx  Outfit equip → patchProfile.
│     ├─ InventoryScreen.tsx  Owned decor, Place/Move/Remove → patchProfile.
│     ├─ RewardsScreen.tsx    Balance + stats (read-only today).
│     ├─ SettingsScreen.tsx   Prefs → patchProfile, reset → resetProfile.
│     └─ (QuestPanels serves Tasks)
│
├─ game/                      ── Phaser core + shared logic (framework-free) ──
│  ├─ profile.ts              ★★ PERSISTENCE CHOKE POINT (see §4) ★★
│  ├─ bridge.ts               ★ TYPED React⇄Phaser channel (see §5) ★
│  ├─ createGame.ts           Game factory (scene list, Scale.RESIZE)
│  ├─ config.ts               Phaser config (background, pixel rounding)
│  ├─ flow.ts                 Office scene default (preview override)
│  ├─ agents.ts               The two local AI workers (classify/draft)
│  ├─ effects.ts              Mail-bird send animation helpers
│  ├─ audio/                  audioManager (unlock, buses) + soundLibrary
│  ├─ data/
│  │  ├─ shopConfig.ts        ★ Catalog: OUTFITS + DECOR_ITEMS with prices
│  │  ├─ questConfig.ts       ★ Quests + ECONOMY (rewards, sendCost=5,
│  │  │                        sendReward=20, xpPerLevel=100,
│  │  │                        QUEST_START_BALANCE=0)
│  │  ├─ officeMap.ts         Map/tiles/collision (MAP 1280×960)
│  │  └─ agentsConfig.ts      Agent routes/dialogue
│  └─ scenes/
│     ├─ BootScene.ts         Splash → Preload
│     ├─ PreloadScene.ts      Loads spritesheets/atlases/JSON
│     ├─ OfficeScene.ts       THE game: player, NPCs, quests, economy
│     │                       calls, decor placement, pause gates, HUD text
│     └─ AssetPreviewScene.ts Used only by /preview
│
├─ docs/                      Phase specs + reports (pattern to copy)
├─ public/assets/mailxp/      Generated art — NEVER EDIT
├─ scripts/                   Asset validation scripts (not backend-related)
├─ package.json               Deps frozen since Phase 1 (backend may add)
├─ context.md                 Recovery file — current project state
└─ frontend_file_structure.md This document
```

---

## 3. Runtime architecture (how the pieces talk)

```
┌────────────────────────── React (DOM) ──────────────────────────┐
│  AppShell ── GameMenu/screens ── GameHud ── GameAnnouncer       │
│       │            │                                              │
│       │     useProfile()                useGameSnapshot()        │
└───────┼────────────┼─────────────────────────┼───────────────────┘
        │            ▼                          ▼
        │     game/profile.ts            game/bridge.ts
        │     (localStorage sync)        (typed pub/sub)
        │            ▲                          ▲ │
        │            │ patchProfile /            │ │ sendCommand
        │            │ getProfile / subscribe    │ │
┌───────┼────────────┼───────────────────────────┼─┼───────────────┐
│       │      Phaser 3 — OfficeScene            ▼ │               │
│       └── reads profile (outfit/decor) ── publishes GameSnapshot  │
│           writes profile (decor, coins) ── listens to GameCommand │
└───────────────────────────────────────────────────────────────────┘
```

Hard rules of this architecture (do not redesign them):

1. **The Phaser canvas mounts exactly once and never unmounts** — menus/title sit on top.
2. **One event system:** React⇄game traffic goes through `game/bridge.ts` only
   (Phase 5 spec: "extend the existing typed bridge rather than creating a second
   event system"). Backend events must not become a third channel — funnel them
   through `profile.ts` subscribers or new commands on the same bridge.
3. **The game loop is synchronous and must never await the network** — `OfficeScene.update()`
   runs every frame. Network work lives outside it (local-first, §4).
4. **SSR safety:** `profile.ts` and `bridge.ts` import cleanly on the server
   (they guard `typeof window === "undefined"` and expose frozen defaults for
   hydration). Any backend module you add must keep that property — the game page
   is statically prerendered.

---

## 4. ★ The persistence seam — `game/profile.ts`

Everything that survives a reload goes through this module. Its exact public API:

```ts
getProfile(): Profile                      // cached read from localStorage
getDefaultProfile(): Profile               // frozen defaults (SSR snapshot)
subscribeProfile(fn: (p: Profile) => void): () => void
patchProfile(patch: ProfilePatch): Profile // merge + persist + notify
addDraftCoin(delta: number): Profile       // clamp ≥ 0
spendDraftCoin(amount: number): boolean    // false if insufficient
ownsItem(itemId: string): boolean          // "worker" always owned
purchaseItem(itemId, price): "ok" | "owned" | "insufficient"
resetProfile(): Profile                    // Settings → reset demo data
```

**Storage:** `localStorage["mailxp.profile.v1"]`, JSON, schema `version: 1`.
Every read passes through `sanitize()` — unknown/broken data falls back to
defaults field-by-field (so server payloads with extra fields are safe to feed in).

### Data contract (verbatim from source)

```ts
interface Profile {
  version: 1;
  draftCoin: number;                 // simulated balance, ≥ 0, integer
  ownedItems: string[];              // shop item ids (shopConfig.ts)
  equippedOutfit: "worker" | "courier" | "tech" | "forest";
  placedDecor: { itemId: string; x: number; y: number }[];  // world px
  prefs: {
    masterVolume: number; uiVolume: number; gameVolume: number; // 0..1
    muted: boolean;
    motion: "full" | "reduced";
    touchControls: "auto" | "on" | "off";
  };
}
```

### Who mutates what (the complete list — nothing else writes)

| Mutation | Call site(s) |
|---|---|
| `purchaseItem(itemId, price)` | `ShopScreen` (Buy) |
| `spendDraftCoin` / `addDraftCoin` | `OfficeScene` (send cost 5, send reward 20, quest rewards 25/20/20/20) |
| `patchProfile({ equippedOutfit })` | `CharacterScreen`, `ShopScreen` (Wear) |
| `patchProfile({ placedDecor })` | `OfficeScene` (place/move), `InventoryScreen` (remove) |
| `patchProfile({ prefs })` | `SettingsScreen` |
| `resetProfile()` | `SettingsScreen` |

### What is NOT persisted today (decide in B0/B7)

`xp`, `level`, `mailCount`, quest progress live only in the bridge snapshot
(`GameSnapshot`) and reset on reload — while `draftCoin` survives. If the backend
should save *progress*, extend `Profile` (e.g. `stats: { xp, level, mailCount, quests }`)
**or** keep stats ephemeral server-side. This is an open decision — do not
silently change it.

---

## 5. The state seam — `game/bridge.ts`

React reads game state via `getSnapshot()/subscribeState()` and sends intents via
`sendCommand()`; `OfficeScene` does the reverse (`publishState`, `subscribeCommands`).
The snapshot (`GameSnapshot`) carries: screen, objective, status, draftCoin,
carrying, mailCount, xp, level, xpInLevel, xpPerLevel, questIndex/questCount,
activeQuestTitle, quests[], classification, draft, reviewOpen, canOpenReview,
sendCost, sendReward, canSend, sending, allComplete, stage, decorMode.

Commands: `start | interact | confirm-send | cancel-review | open-review |
set-paused | touch-move | decorate`.

**Backend rule:** server responses arrive asynchronously on the React side; you
convert them into `patchProfile`/`publishState` updates — never call `fetch`
from inside Phaser scenes or from `update()`.

---

## 6. Operation → backend mapping (the actual work)

| # | Frontend operation today | Hook point | Backend endpoint to design |
|---|---|---|---|
| 1 | App load reads localStorage | `getProfile()` | `GET /api/profile` — hydrate after login, then keep local cache |
| 2 | Buy shop item (client checks price) | `purchaseItem()` in `ShopScreen` | `POST /api/shop/purchase {itemId}` — **server** validates price from its own `shopConfig`, atomic balance check |
| 3 | Equip outfit | `patchProfile({equippedOutfit})` | `PATCH /api/profile` (cosmetic field) |
| 4 | Place / move / remove decor | `patchProfile({placedDecor})` | `PATCH /api/profile` (or dedicated `/api/decor`) |
| 5 | Settings change | `patchProfile({prefs})` | `PATCH /api/profile` (prefs field) |
| 6 | Quest reward / send cost+reward | `addDraftCoin`/`spendDraftCoin` in `OfficeScene` | `POST /api/quest/complete`, `POST /api/mail/send` — server-authoritative economy (B6) |
| 7 | Reset demo data | `resetProfile()` | `POST /api/profile/reset` (authenticated) |
| 8 | XP/level/mailCount (ephemeral now) | `publishState` only | optional `stats` persistence (decision) |
| 9 | No login exists | — | `POST /api/auth/register`, `/login`, `/logout`, session cookie |
| 10 | No leaderboard exists | — | optional `GET /api/leaderboard` (decision) |

Suggested auth model (unless the owner picks otherwise): **email + password**
(hashed server-side, e.g. bcrypt/argon2) + **httpOnly session cookie**; server
tables: `users`, `sessions`, `profiles` (one JSON doc + `version`/`updatedAt`
mirroring `Profile`), `transactions` (append-only log of every coin change —
audit trail for the economy).

---

## 7. Sync model requirement — local-first, server-reconciled

The game must keep feeling instant and keep working offline. Required behaviour:

1. **Reads stay synchronous** — `getProfile()` never blocks on network.
2. **Writes are optimistic** — apply to localStorage immediately, enqueue a
   background push (debounced ~1s, flush on `visibilitychange`/`pagehide`).
3. **Offline queue** — failed pushes retry with backoff; UI shows sync status
   (a new hook, e.g. `useSyncStatus(): "synced" | "syncing" | "offline" | "error"`,
   exported by the backend-owned module — the frontend chat consumes it, never
   edits `profile.ts` internals).
4. **Conflict rule** — server is truth: every save carries a monotonically
   increasing `rev` (or `updatedAt`); stale pushes get a 409 and the client
   rehydrates. Simple last-write-wins is acceptable for round 1.
5. **Login migration** — never destroy an existing local save: on first login,
   offer "claim this device's save" (upload local profile) vs "use cloud save".
6. **Economy actions (B6+)** go through authoritative endpoints; if the server
   rejects (insufficient funds, unknown item), roll the optimistic UI back and
   announce the error (reuse `GameAnnouncer` / status line patterns).

---

## 8. Hard rules (from Phases 1–7 — still in force)

1. **Never edit art** under `public/assets/mailxp/` (and don't touch the
   `scripts/*.ps1` generators unless assets change — they don't).
2. **No second event system** — extend `bridge.ts`, don't add parallel emitters.
3. **Canvas never unmounts / game never resets** when navigating or logging in
   (a login overlay must behave like the title overlay: pause, don't remount).
4. **Hydration-safe React** — server HTML must match first client render; read
   server-varying state through `getDefaultProfile()`-style frozen snapshots or
   `useSyncExternalStore` patterns already used in `useGameState.ts`.
5. **Honest verification** — every phase reports only checks actually run
   (`tsc --noEmit`, `next build`, curl/API calls, browser walkthrough), written
   to `docs/` as a report, same style as `PHASE_*_REPORT.md`.
6. **Sound/a11y/touch must keep working** — purchases/rewards play sounds via
   `game/audio`, errors announce to the aria-live announcer.
7. `package.json` was frozen for Phases 1–7; **backend work may add dependencies**
   (Prisma/better-sqlite3/bcrypt/…), but list each one and why in the phase report.
8. Keep `/preview` and `next build` green at every phase boundary.

---

## 9. Backend phase plan (proposed — copy into `docs/BACKEND_PHASE_PLAN.md`)

Each phase: **spec → implement → verify → report** (the frontend discipline).

| Phase | Deliverable | Acceptance criteria |
|---|---|---|
| **B0 — Decisions** | Record owner's choices: stack (recommended: Next.js API routes + SQLite via Prisma, same folder), auth (recommended: email+password), whether stats persist, external APIs (LLM/leaderboard) or none | Written into the plan doc; owner confirms |
| **B1 — API contract** | `docs/BACKEND_API_CONTRACT.md`: every endpoint, request/response JSON, error codes, auth flow, sync/conflict semantics | Both chats (frontend + backend) agree by reading it; no code yet |
| **B2 — Storage adapter (frontend seam)** | Refactor `game/profile.ts` behind an internal `StorageAdapter` interface (`local` impl only) + add `useSyncStatus` stub | **Zero behaviour change**: tsc 0, build 0, manual walkthrough identical to today |
| **B3 — Server skeleton** | `app/api/health/route.ts`, Prisma schema + SQLite file, seed script, `.env.example` | `curl /api/health` → 200 JSON; DB file created; build green |
| **B4 — Auth + profile CRUD** | register/login/logout, hashed passwords, httpOnly session, `GET/PATCH /api/profile` | curl-verified register→login→get→patch→logout; no plaintext passwords anywhere |
| **B5 — Sync wiring** | Adapter talks to API: hydrate on login, debounced push, offline queue, 409 rehydrate, "claim local save" flow | Walkthrough: play offline → back online → save syncs; second device pulls same profile |
| **B6 — Authoritative economy** | `POST /api/shop/purchase`, `POST /api/mail/send`, `POST /api/quest/complete` with atomic balance + `transactions` log; client rollback path | Server rejects tampered price/insufficient balance (curl negative tests); UI shows honest error; coins reconcile |
| **B7 — Progress persistence (if decided)** | Persist xp/level/mailCount/quest progress into the save | Reload keeps both coins **and** progress; or explicit "not doing this" note |
| **B8 — Frontend states (may be the frontend chat)** | Login/register UI overlay, sync indicator, offline/error toasts, per B1 contract only | Menu/Tasks/etc. untouched except new auth section; canvas never remounts |

**Verification toolkit per phase:** `npx tsc --noEmit` · `npx next build` ·
`curl` scripts for every endpoint (positive **and** negative) · browser walkthrough
recording what was actually run · report in `docs/BACKEND_B*_REPORT.md`.

---

## 10. Two-chat workflow (avoid collisions)

The project owner runs **two AI chats in this same folder**: one for frontend UI,
one for backend (you).

1. **Contract first.** `docs/BACKEND_API_CONTRACT.md` (B1) is the single source
   of truth for endpoint shapes. Neither chat invents fields.
2. **File ownership:**
   - Backend chat owns: `game/profile.ts` (adapter), new `game/backend/`,
     `app/api/**`, Prisma/DB files, `.env.example`, `docs/BACKEND_*`.
   - Frontend chat owns: `components/**` (login screen, sync badge, toasts,
     Settings → account section) — consuming only exported hooks (`useSyncStatus`).
   - **Shared, edit only with the contract in hand:** `game/bridge.ts`,
     `components/useGameState.ts`.
   - Nobody touches: `public/assets/**`, existing art scripts, scene logic
     except where B6 hooks `addDraftCoin`/`spendDraftCoin` call sites.
3. **Handoff ritual per phase:** backend chat finishes phase → writes report →
   frontend chat reads contract+report → builds UI → both re-run `tsc` + `next build`.

---

## 11. Open questions for the project owner (B0)

1. **Stack:** Next.js API routes + SQLite in this folder (recommended) vs Supabase vs separate Express?
2. **Auth:** email+password (recommended) vs guest-first vs Google?
3. **Scope round 1:** save sync only, or also server-authoritative economy (recommended)?
4. **Stats:** should xp/level/mailCount/quests persist to the server too?
5. **External APIs:** any (e.g. LLM-generated NPC dialogue/replies)? None is fine for round 1.
6. **Hosting:** local dev only for now, or target a host early (Vercel needs Postgres, not SQLite)?
