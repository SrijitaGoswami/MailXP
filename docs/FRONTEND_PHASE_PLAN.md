# MailXP Frontend — Phase Plan

Status: Phase 1 complete (scaffold) · Phase 2 complete (game shell) · Phase 3 complete (asset pipeline) · Phase 4 complete (playable office core loop) · Phase 5 complete (quests, agents, HUD, mail-bird flow) · Phase 6 complete (screens, sound, polish) · **Phase 7 complete (full-screen game redesign — the frontend ends here)** — see `docs/PHASE_1_REPORT.md` … `docs/PHASE_7_REPORT.md`.

## 1. Current state (verified 2026-10-10, after Phase 7)

Scaffold, game shell, asset pipeline, playable office core loop, the four-job
quest system (two local deterministic "AI" workers, reply-review panels, HUD,
mail-bird send flow, all six effects), the **complete frontend**, and the
**full-screen game shell** are in place: a minimal title overlay (MailXP +
tagline + Play) over the live paused office, a compact in-game HUD
(Lv/XP/DraftCoin + Tasks shortcut), and one Menu button whose side-panel dialog
holds Tasks / Character / Inventory / Shop / Rewards / Settings (all six
mounted, ARIA tablist, Escape/backdrop close, focus return) — while the Phaser
canvas (Scale.RESIZE, fills the viewport, camera zoom 1) mounts once and never
remounts. Opening the title/menu pauses the game via a typed `set-paused`
bridge command. 47 demo-shop products with simulated DraftCoin purchases,
local cosmetic persistence (outfits, placed office decor, preferences), 26
synthesized Web Audio sound effects with master/UI/game buses + mute, and
on-screen touch controls (corner overlay). Not a git repo. Exact-pinned
toolchain via npm (Next.js 16.3.8, React 19.3.0, TypeScript 5.9.3,
Phaser 3.90.0, Tailwind 4.3.3 — 0 vulnerabilities; **no dependencies added
since Phase 1**). Final `tsc --noEmit` and `next build` exit 0;
`validate-assets.ps1` passes (0 errors / 2 documented warnings);
`verify-atlas-parse.js` PASS ×9; browser walkthroughs end with 0 console
errors. No backend/AI/email/wallet/blockchain calls exist anywhere.

```
MailXP/
├── context.md                 ~120-line recovery file for a fresh agent (read this first)
├── app/                       page.tsx (AppShell full-screen shell), preview/page.tsx, layout.tsx, globals.css (focus/reduced-motion/game-body class)
├── components/                AppShell.tsx (title overlay + HUD + Menu button + GameMenu; canvas mounted once, never unmounted)
│                              GameMenu.tsx (dialog + vertical ARIA tablist, six sections), GameHud.tsx (Lv/XP/coins + Tasks),
│                              GameAnnouncer.tsx (sr-only aria-live), useGameState.ts, TouchControls.tsx (D-pad + E corner overlay)
│                              ShopThumb.tsx (atlas-accurate CSS-sprite previews), QuestPanels.tsx (Tasks: jobs + reply review)
│                              screens/  CharacterScreen, InventoryScreen, ShopScreen, RewardsScreen, SettingsScreen
├── game/                      config.ts (Scale.RESIZE), createGame.ts (Boot→Preload→Office; preview keeps FIT), flow.ts,
│                              bridge.ts (typed commands incl. set-paused/touch-move/decorate),
│                              profile.ts (localStorage profile: wallet/outfits/decor/prefs, pub/sub)
│   ├── audio/                 soundLibrary.ts (26 synthesized events), audioManager.ts (buses, mute, unlock, throttles)
│   ├── data/                  officeMap.ts, questConfig.ts, agentsConfig.ts, shopConfig.ts (47 products)
│   ├── agents.ts              AiWorkerAgent (restrained glide, existing frames only)
│   ├── effects.ts             playEffect() — shared sparkle/ring/quest/pickup/coin/level-up tweens
│   └── scenes/                BootScene, PreloadScene (incl. shop atlases), AssetPreviewScene, OfficeScene (boots paused)
├── scripts/                   generate-assets.ps1, validate-assets.ps1, verify-atlas-parse.js, measure-shop-assets.ps1
├── docs/                      this plan, phase_0…6 .md, PHASE_1…6_REPORT.md, FRONTEND_PHASE_PLAN.md
└── public/assets/mailxp/
    ├── ASSET_GUIDE.md
    ├── characters/player/worker.png (1254 × 1254) · interact-directions.png (2172 × 724)
    ├── characters/npcs/office-npcs.png (1278 × 1230) · agents/ai-workers.png (1774 × 887)
    ├── office/office-props.png (1536 × 1024) · items/mail-effects.png (1536 × 1024)
    ├── effects/mail-bird.png (1774 × 887) · tilesets/office/office-tileset.png (1774 × 887)
    ├── shop/outfits/ worker-courier|worker-tech|worker-forest.png   (provided Phase 6 sources)
    ├── shop/decor/   shop-decor|shop-wall-decor|shop-plants-rugs|shop-desk-lounge.png
    └── processed/                                (derived outputs only; originals untouched)
        ├── office-props.json (21) · mail-effects.json (14) · office-npcs.json (16)
        ├── ai-workers.json (8) · mail-bird.json (8) · office-tiles-32.png (26 slots) · manifest.json
        └── shop-decor.json (8) · shop-wall.json (12) · shop-plants.json (12)
           shop-desk.json (12) · shop-manifest.json        (Phase 6, measured — BOM-less)
```

All 8 original PNG dimensions were measured locally and **match
`ASSET_GUIDE.md` exactly**; originals verified untouched (mtimes/sizes) after
every pipeline run. `ASSET_GUIDE.md` remains the authoritative prose guide; the
machine-readable record of all frame crops is `processed/manifest.json`.

## 2. Present vs. missing

Everything in `docs/phase_6.md` is implemented; nothing is missing.

| Present (Phases 1–6) | Deferred by design (not Phase 6 scope) |
|---|---|
| Next.js + TypeScript + Tailwind scaffold, lockfile, passing build | Real wallet / NFT / claim connection, on-chain balances (labeled demo-only in Rewards) |
| Phaser shell `Boot → Preload → Office` (office is the always-live scene), Scale.RESIZE full-viewport (960 × 540 design baseline; FIT on `/preview`), `pixelArt`, accessible host | Backend / API / AI provider / real email sending (explicitly future) |
| Asset loading + measured atlases/tiles (NEAREST), `/preview`, frame-level verification | Licensed audio files / music / ambience (none exist; effects are synthesized) |
| Office map, 4-dir movement, collision, 4 NPCs, `E` interaction, pickup → deliver → +25 loop | Automated test suite (forbidden by the phase spec; use `tsc`/`build`/asset scripts) |
| Typed 4-job quest loop: locked/active/completed, two local "AI" workers, editable reply review with explicit costed confirm, simulated send → mail-bird flight | |
| Full HUD + `aria-live` React mirror, all six effects | |
| **Full-screen shell (Phase 7): title overlay → compact HUD + Menu side panel with all six sections, pause-on-menu via typed `set-paused`, canvas mounted once and never unmounts** | |
| **Character / Inventory / Shop / Rewards / Settings screens — every control live, no dead buttons** | |
| **47-product demo shop (3 outfits + 44 decor), simulated DraftCoin purchases with honest alerts** | |
| **Local persistence: balance, owned items, equipped outfit, placed decor, sound/motion/touch prefs** | |
| **26 synthesized Web Audio effects, master/UI/game buses, mute, gesture unlock, throttles** | |
| **Touch D-pad + Interact as a corner overlay on the game (Auto/Always/Hide), keyboard-operable** | |
| **Reduced-motion: `<html data-motion>` + OS `prefers-reduced-motion`, hydration-safe UI** | |

## 3. Implementation phases

- **Phase 1 — Scaffold.** ✅ Complete (2026-10-06). Next.js 16.3.8 + React 19.3.0 +
  TypeScript 5.9.3 + Tailwind 4.3.3 + Phaser 3.90.0 (exact-pinned, npm lockfile),
  manual scaffold, minimal home page, README. Production build passes; assets
  verified intact. See `docs/PHASE_1_REPORT.md`.
- **Phase 2 — Game shell.** ✅ Complete (2026-10-06). Client-only host
  (`components/PhaserCanvas.tsx`, `'use client'` + dynamic `import()` after mount,
  Strict-Mode-safe cleanup with `game.destroy(true)`), fixed logical size
  **960 × 540** with `Scale.FIT` + `CENTER_BOTH`, `pixelArt` + `roundPixels`,
  `Boot` → `Preload` → `Title` scene flow, canvas `role="application"` +
  `aria-label`. Production build passes; page verified HTTP 200. See
  `docs/PHASE_2_REPORT.md`.
- **Phase 3 — Asset pipeline.** ✅ Complete (2026-10-06). Original PNGs never
  modified; derived outputs only under `public/assets/mailxp/processed/`.
  Measured (not assumed) frame layouts: worker exact 4 × 4 of 313 × 313,
  interact exact 4 × 543 × 724, NPCs content-packed rows (y 0/360/670/958/1230,
  x 0/336/639/958/1278), AI workers / mail bird snapped ≈ 444 cells;
  irregular atlases segmented into **21 prop** and **14 effect** named frames
  (incl. an auto-repaired couch/plant split at the density minimum x = 673);
  regular **32 × 32 tilesheet** (26 tiles, nearest-neighbor, source cells
  recorded); machine-readable `manifest.json` (every source rect → output name);
  `PreloadScene` loads all of it with **NEAREST** filtering; feet-anchored
  characters; `/preview` → `AssetPreviewScene` kept out of the game flow.
  Build ✅, `validate-assets.ps1` ✅ (0 errors / 1 warning, warning visually
  cleared), HTTP 200 ✅, every frame visually verified via contact sheets
  (live browser inspection attempted but the desktop browser was not connected
  — recorded in the report). See `docs/PHASE_3_REPORT.md`.
- **Phase 4 — Core loop.** ✅ Complete (2026-10-06). `OfficeScene` added to the
  `Boot → Preload → Title → Office` flow (Title starts via clickable button,
  `Enter`/`Space`, or the React bridge). Typed map data in
  `game/data/officeMap.ts` (40 × 30 tiles = 1280 × 960 world with camera
  follow, 15 manifest slots, `TILE_NAMES` runtime cross-check against
  `manifest.json`); manual AABB collision (axis-separated, feet box; solid
  props block only their base so the player walks behind furniture — no
  physics system, per plan). Player: arrows + WASD, per-direction idle/walk
  anims, feet-anchored, 700 ms interact pose. 4 NPCs, depth = foot y,
  `E` prompt within 64 px + speech bubbles. Full local loop
  pickup → deliver → **+25 DraftCoin** (balance 0, all tunables in
  `game/data/questConfig.ts`; local state only — no APIs). Typed bridge
  (`game/bridge.ts`) feeds the React `aria-live` panel
  (`GameStatusPanel.tsx`) with objective/status/balance plus **Start office**
  / **Interact** buttons; all bridge/keyboard listeners cleaned up on
  teardown. Build ✅, `tsc --noEmit` ✅, HTTP 200 ✅ (aria-live in HTML),
  `verify-atlas-parse.js` ✅ × 5, assets untouched ✅; live browser inspection
  attempted twice but the desktop browser was not connected — recorded as
  *not visually inspected* in the report. See `docs/PHASE_4_REPORT.md`.
- **Phase 5 — Systems.** ✅ Complete (2026-10-06). Typed, configurable
  four-job quest list (`game/data/questConfig.ts`: `QUESTS`, `ECONOMY`,
  `OBJECTIVES`/`STATUSES`, dialogue) with `locked/active/completed` statuses,
  **one active job at a time** (job 1 = the preserved Phase 4 delivery, jobs
  2–4 = reply jobs: send cost 5, reward 20, net +15; XP +5 classify / +10 send
  / +15 quest, level every 100 XP). Understanding + Response Workers added as
  `AiWorkerAgent` glides on L-shaped routes through the open carpet rows
  (existing atlas frames + gentle bob only — **no invented walk frames**;
  agents respect collision data but deliberately don't block the player),
  returning deterministic local classification/reply from config. React
  `QuestPanels.tsx`: always-visible quest list plus an auto-opening,
  keyboard-accessible reply review with editable To/Subject/Reply, cost /
  reward / balance shown **before** an explicit confirm (confirm disabled with
  a visible reason when the balance can't cover it), no API/email/wallet code.
  Confirmed send → local state update → **mail-bird flight** with correct
  directional frames, looping flap, exiting the screen edge. Full in-canvas HUD
  (mail count, job/status, DraftCoin, XP/level) + React mirrors via the
  **extended** `game/bridge.ts` (same channels, richer snapshot, object
  commands). All six effects wired through `game/effects.ts`. Verified by 3
  full dev playthroughs + 1 full production-build playthrough (each ending
  70 DraftCoin / 4 mail / 105 XP / Level 2), live screenshots, a 40 ms effect
  watcher and 0 console errors; `tsc` ✅, atlas script ✅ ×5, asset validation
  ✅ (0 errors), production build ✅. Temp debug probe removed. See
  `docs/PHASE_5_REPORT.md` (incl. the honest visual-inspection caveats).
- **Phase 6 — Frontend completion, sound, polish.** ✅ Complete (2026-10-07).
  Five screens (`components/screens/…`) behind `AppShell`'s ARIA tab shell —
  the Phaser canvas renders **once, outside the panels**, and never unmounts.
  Character (honest previews from the real sheets), Inventory (equip +
  Place/Move/Remove decor), Shop (47 products — 3 outfits + 44 decor — all
  claimable with local DraftCoin, purchases clearly simulated), Rewards
  (local-vs-on-chain disclosure, demo-only wallet section, no fake hashes),
  Settings (mute + master/UI/game volume, motion, touch mode, two-step reset).
  New `game/profile.ts` persists balance/owned/equipped/placed/prefs in
  `localStorage` with pub/sub consumed by React and both scenes.
  `scripts/measure-shop-assets.ps1` measured the provided shop sheets →
  44 frames + `shop-manifest.json` (BOM-less; originals untouched). Sound:
  26 synthesized Web Audio events (`game/audio/soundLibrary.ts` recipes +
  `audioManager.ts` buses/throttle/unlock/tab-hide; no files, no music).
  Touch: D-pad + Interact below the canvas, Auto/Always/Hide, pointer +
  keyboard. Reduced-motion via `<html data-motion>` + OS preference;
  hydration-safe stores (`useSyncExternalStore`). Four walkthrough-found bugs
  fixed (stale title balance, decor command dropped before the office starts,
  React #418 hydration mismatch ×2 sources, dead `agent-arrive` cue).
  Verified: `tsc` ✅, `next build` ✅, `validate-assets.ps1` ✅ (0 errors /
  2 documented warnings), `verify-atlas-parse.js` ✅ ×9, production
  walkthrough with 0 console errors (record incl. honest caveats). README
  refreshed; recovery file `context.md` added. See `docs/PHASE_6_REPORT.md`.
- **Phase 7 — Full-screen game redesign.** ✅ Complete (2026-10-10). The page
  frame/tab strip/instruction panel/footer are gone: MailXP is a full-viewport
  game. Title overlay (MailXP + "Deliver. Grow. Level Up." + Play) renders
  over the live **paused** office — Phaser now boots `Boot → Preload →
  Office` (TitleScene deleted; `Scale.RESIZE` fills the container, camera
  zoom 1 = crisp 1:1 pixels, larger screens reveal more office). One Menu
  button (top-right) opens a `role="dialog"` side panel (vertical ARIA
  tablist: Tasks/Character/Inventory/Shop/Rewards/Settings — screens reused,
  all mounted, Escape/backdrop close, focus return) overlaying the canvas;
  Tasks holds the jobs list + reply review (auto-opens on review; a confirmed
  send closes the panel so the mail-bird is visible). Compact HUD (Lv/XP/
  DraftCoin chips + Tasks shortcut) top-left; touch pad/E button became corner
  overlays (hidden while menus/pre-Play); in-canvas HUD slimmed to the
  resize-aware status line; the old GameStatusPanel's announcement duty moved
  to sr-only `GameAnnouncer`. New typed `set-paused` bridge command freezes
  movement/interact/agents (and drains the E-key edge) while the title or a
  menu is open; Decorate placement closes the panel so the map is clickable.
  Verified live: title→play, pause/resume + Escape + focus, all sections +
  keyboard tab nav, movement + interact (Monkey dialogue), full decor
  placement with persistence, adaptive viewport at 1296/484/390 px, clean
  console, `/preview` regression, `tsc` ✅ 0, `next build` ✅ 0. Honest gaps
  recorded in the report (quest chain not re-run end-to-end; review auto-open
  code-verified only; no audio/screen-reader pass). See `docs/PHASE_7_REPORT.md`.
  **The frontend ends here — no backend work.**

## 4. Run commands (after Phase 1)

```bash
npm install       # once package.json exists
npm run dev       # http://localhost:3000
npm run build     # production build
npm run start     # serve production build
```

Runnable since Phase 1: `npm run dev` → http://localhost:3000 (game canvas mounts
since Phase 2; asset preview at `/preview` since Phase 3; playable office since
Phase 4 — since Phase 7 via the full-screen title overlay's Play button; the
four-job quest loop — walk, let the two local workers classify/draft, review
and confirm a simulated send — since Phase 5; the Character/Inventory/Shop/
Rewards/Settings screens in the in-game Menu panel, sound settings, decor
placement and touch controls since Phase 6 — note `npm run start` needs a free
port, e.g. `npx next start -p 3001`, if 3000 is taken).

Phase-check commands used by every report: `npx tsc --noEmit`,
`npx next build`, `powershell -ExecutionPolicy Bypass -File
scripts/validate-assets.ps1`, `node scripts/verify-atlas-parse.js`.

## 5. Constraints

- Preserve every existing file; never overwrite `public/assets/mailxp/`
  (originals and pre-existing `processed/` outputs verified untouched each
  phase; Phase 6 only *added* `processed/shop-*.json` + `shop-manifest.json`).
- No new dependencies at any point (holds: `package.json` unchanged since
  Phase 1); no automated test suite added (phase spec).
- The frontend ends with Phase 7 — no backend, AI, email, wallet or
  blockchain work.
