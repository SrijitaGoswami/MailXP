# MailXP — context (read this first)

Recovery file for a fresh agent. One page: rules, state, file map, commands,
decisions, and where the detail lives. Project: Next.js 16 + Phaser 3
full-screen pixel-office game, four-job quest loop, demo shop, synthesized
sound. **All 7 phases are complete. The frontend ends here — no backend work.**

Read order if you need depth: this file → `docs/FRONTEND_PHASE_PLAN.md` →
`docs/PHASE_7_REPORT.md` (latest) → earlier `PHASE_n_REPORT.md` as needed.

## Hard rules (never break these)

1. **No backend ever**: no API/AI/email/wallet/blockchain/NFT calls, no fake
   transaction hashes. Wallet/purchase/claim/email actions must stay labeled
   demo-only.
2. **No new dependencies.** `package.json` frozen since Phase 1 (Next 16.3.8,
   React 19.3.0, TS 5.9.3, Phaser 3.90.0, Tailwind 4.3.3).
3. **Never edit art**: the 8 original PNGs, `shop/` source sheets, and all
   pre-existing `processed/` outputs are read-only. New derived files go to
   `processed/` (BOM-less JSON). Never invent sprite frames — use measured
   layouts only.
4. **No automated test suite** (spec). Verify with `tsc`, `next build`,
   `validate-assets.ps1`, `verify-atlas-parse.js` + a manual browser walk.
5. **No dead buttons**: every control does something real; every shop item is
   claimable with DraftCoin; purchased items are usable in-game.
6. Sound = **Web Audio synthesis in code only** (no files, no music/ambience —
   user may supply licensed audio later; `audioManager` can then play files
   per event without touching `soundLibrary`).
7. Decor is **visual only** — never add it to collision (protects verified
   Phase 4/5 walk routes).

## Phase status

| Phase | Status | Report |
|---|---|---|
| 1 Scaffold · 2 Game shell · 3 Asset pipeline · 4 Core loop · 5 Quests/agents/HUD/mail-bird · 6 Screens+sound+polish · **7 Full-screen redesign** | ✅ all complete (2026-10-10) | `docs/PHASE_1_REPORT.md` … `docs/PHASE_7_REPORT.md` |

Not a git repo. Frontend finished; backend integrations are deliberate
deferrals (see Phase 6 report §15).

## Architecture in 30 lines

- **Two state channels, one direction each** (never add a third):
  - `game/bridge.ts` — game→React snapshot (`publishState`, 30+ fields incl.
    `decorMode`) + React→game commands (`interact/confirm-send/cancel-review/
    open-review/set-paused/touch-move/decorate`; `start` kept but ignored —
    the office is always live). `sendCommand` holds a `decorate` request
    while `screen !== "office"` (`takePendingDecor`; OfficeScene consumes it
    in `create`).
  - `game/profile.ts` — persisted local profile (`localStorage`
    `mailxp.profile.v1`): `draftCoin, ownedItems, equippedOutfit, placedDecor,
    prefs{master/ui/game volume, muted, motion, touchControls}`; `patchProfile`
    persists + notifies; `getDefaultProfile()` = frozen defaults (React
    server snapshot).
- **React**: `AppShell.tsx` = full-viewport shell — title overlay (over the
  live paused office) → HUD (Lv/XP/DraftCoin + Tasks) + Menu button + touch
  pad, all above the always-mounted canvas (`absolute inset-0`, mounts once,
  never unmounts; panels stay mounted, toggled with `hidden`). `GameMenu` =
  dialog + vertical ARIA tablist with the six sections. `GameAnnouncer` =
  sr-only `aria-live` region. `useGameState.ts` = `useSyncExternalStore` hooks
  (hydration-safe — do NOT read localStorage/`ownsItem()` during render,
  caused React #418 once).
- **Phaser**: `Boot → Preload → Office` (TitleScene deleted in Phase 7).
  OfficeScene **boots paused** (React Play unpauses) and pauses again whenever
  a menu opens (`set-paused`): `update()` early-returns (draining the E-key
  JustDown edge), interact/decor-input gated, held pad dirs cleared. Camera
  zoom 1 + `Scale.RESIZE` = crisp 1:1 pixels, bigger screens show more office.
  Viewport-anchored canvas overlays reposition on `Scale.Events.RESIZE`.
- **Audio**: `soundLibrary.ts` (26 named recipes + bus map + throttle gaps) →
  `audioManager.ts` (`playSound`, master→ui/game buses, mute, gesture unlock,
  tab-hide suspend). **One source per event**: command-driven cues play
  scene-side, pure-UI cues play React-side (never both).
- **Layout**: body scroll lock scoped via `body.mailxp-game-active`
  (AppShell mount effect; `/preview` scrolls normally). Touch pad is a
  corner overlay (`pointer-events-none` wrapper) — hidden while a menu is
  open or before Play.

## File map (only the load-bearing entries)

```
context.md                     this file
README.md                      setup/controls/screens/sound/demo limits
app/page.tsx                   renders <AppShell/>
components/AppShell.tsx        title overlay + HUD + Menu button + GameMenu + pause wiring
components/GameMenu.tsx        dialog + vertical tablist (Tasks/Character/Inventory/Shop/Rewards/Settings)
components/GameHud.tsx         Lv/XP/DraftCoin chips + Tasks shortcut (overlay)
components/GameAnnouncer.tsx   sr-only aria-live (objective/status/balance)
components/screens/*.tsx       Character, Inventory, Shop, Rewards, Settings
components/TouchControls.tsx   D-pad + E corner overlay (pref: auto/on/off; hidden pre-Play/menu)
components/ShopThumb.tsx       atlas-accurate CSS-sprite previews
components/QuestPanels.tsx     Tasks section: jobs list + reply review
game/profile.ts                persisted profile (above)
game/bridge.ts                 typed snapshot/commands (above)
game/config.ts                 Scale.RESIZE (960×540 = design baseline only)
game/createGame.ts             Boot→Preload→Office; /preview keeps FIT + AssetPreview
game/audio/{soundLibrary,audioManager}.ts   26 SFX / playback buses
game/data/shopConfig.ts        47 products (3 outfits + 44 decor)
game/data/questConfig.ts       4 jobs, economy, objectives, dialogue
game/scenes/OfficeScene.ts     the game: movement, NPCs, quests, decor, status HUD, pause
game/scenes/PreloadScene.ts    loads atlases incl. 4 shop sheets + outfit sheets
scripts/measure-shop-assets.ps1  re-run when shop PNGs change → processed/shop-*.json
scripts/validate-assets.ps1    asset gate (expect 0 errors, 2 documented warnings)
scripts/verify-atlas-parse.js  parser test (expect PASS ×9)
docs/…                         phase specs phase_0..7.md + PHASE_n_REPORT.md
public/assets/mailxp/          ART — read-only (see Hard rules)
```

## Key decisions (already made — don't relitigate)

- **Roster**: only Worker is playable (4 appearances: base + courier/tech/
  forest outfit sheets). NPCs/AI workers stay non-playable.
- **Shop ids**: outfit shop id === `OutfitId` (`courier/tech/forest`); base
  `worker` always owned. Textures: `outfit-<id>` spritesheets; atlases
  `shop-decor|shop-wall|shop-plants|shop-desk` (provided sheets + measured
  `processed/shop-*.json`). Prices: outfits 25, decor 6–12.
- **Decor placement**: Inventory Place/Move **closes the menu panel**
  (`onStartPlacement`) → click/tap map, grid-snapped 32 px; wall pieces anchor
  at click, floor pieces need a non-solid tile; depth-sorted; persisted in
  profile; movable/removable.
- **Navigation**: the reply review auto-opens the menu on Tasks; a confirmed
  send closes the menu (mail-bird visible); state survives section flips
  because panels never unmount. Escape/backdrop/close button close the menu;
  focus returns to the Menu button.
- **Pause**: one switch — AppShell sends `set-paused: !started || menuOpen`.
  OfficeScene boots paused; `start` command is a no-op.
- **Title**: React overlay over the live paused office (user-confirmed
  "office as backdrop"); tagline "Deliver. Grow. Level Up.".
- **GAME_WIDTH/GAME_HEIGHT**: design baseline + /preview fallback only.
  Gameplay positioning must use `this.scale.width/height`.
- **Touch**: commands `touch-move`/`decorate`; pad auto-shown on
  `pointer: coarse`; buttons work with pointer AND keyboard hold. Note:
  Phaser 3.90 listens to `mousedown`/`mouseup` on the canvas (not
  `pointerdown`) — relevant when scripting input tests.
- **Reduced motion**: profile pref mirrored to `<html data-motion>` + OS
  `prefers-reduced-motion` CSS; gates marker bob/banner fade/scroll.
- **Shop extraction strategy**: build with assets as they exist; if shop PNGs
  are replaced, re-run `measure-shop-assets.ps1` (frame overlap ≤10000 px² is
  a documented WARN, larger is FAIL).
- **Sound events**: 26 named (UI: ui-click/nav/panel-open/panel-close/equip/
  purchase/cancel/blocked; game: footstep/interact/talk/bump/mail-pickup/
  quest-start/agent-dispatch/agent-arrive/classified/draft-ready/send-confirm/
  bird-launch/flap/pass/reward/quest-complete/level-up; review-open = ui).

## Commands

```bash
npm run dev                      # http://localhost:3000
npx tsc --noEmit                 # type check (expect exit 0)
npx next build                   # prod build (expect exit 0)
npx next start -p 3001            # serve; 3000 may be taken
powershell -ExecutionPolicy Bypass -File scripts/validate-assets.ps1
node scripts/verify-atlas-parse.js
```

## Current verification state (2026-10-10, Phase 7)

- `tsc` ✅ 0 · `next build` ✅ 0 (asset scripts not re-run — no asset changes;
  Phase 6 results stand: validate-assets 0 errors/2 warnings, atlas PASS ×9).
- Phase 7 live walkthrough: title→Play→office; pause verified (held ArrowUp
  while menu open moved nothing; resumes after close); Escape + focus return;
  all six menu sections + keyboard tab nav; Tasks shortcut; movement + NPC
  interact (Monkey dialogue synced across canvas/status/announcer); full decor
  placement (menu auto-closes, click places, persists, sprite visible);
  adaptive viewport at 1296×890, 484×889 (live window), 390×844 (iframe
  harness); dev console 0 warnings/errors; `/preview` regression OK; profile
  restored to defaults afterwards.
- **Known honest caveats**: four-job quest chain not re-run end-to-end in
  Phase 7 (code unchanged from the Phase 5-verified loop; mailbox route not
  reachable by blind synthetic navigation); reply-review auto-open → menu
  Tasks is code-verified only (same pattern as the proven Phase 6 switch);
  sound never *heard* (no audio device in harness); no screen-reader pass; no
  real touch device; a same-origin iframe harness boots the UI layout but its
  nested Phaser instance stalls before Office (harness artifact, not
  reproducible in a normal tab); browser screenshots were unavailable late
  in Phase 7 but worked again in the annotation round (used for the pixel
  checks below).

## Annotation round 1 (2026-10-10, after the Phase 7 report)

Two live-review annotations were fixed and acknowledged (0 pending):
`mv1enpjs-jmv0rx` "not full screen" and `mv1eos7n-wr6xut` "texts overlapping".
Fixes — office-edge **walnut TileSprite surround** (`OfficeScene.createSurround`,
depth −1, no tint — tint didn't visibly apply) so no window size ever shows bare
background around the world; a user-invoked **"Full screen"** button beside ☰
Menu (support-detected, `aria-pressed`; engagement not observable under
automation); **panel-scoped grids** — Shop single-column (viewport
`sm:/xl:` breakpoints inside the 440 px panel were squeezing cards until texts
overlapped), Rewards 2 × 2; **Shop Place now closes the menu**
(`onStartPlacement`, dead `scrollIntoView`/"office above" removed).
Verified: `tsc` 0 · all 5 Shop grids 353 px/1-col, 0 overflow/overlap · place
end-to-end (snapped 592,368, persisted, announced) · edge pixels walnut
(≈190,140,80) where background cream (247,241,227) was before · console
0 errors/warnings · seeded test profile removed. Details →
`docs/PHASE_7_REPORT.md` §8.

## Where detail lives

**Backend connection brief (for the backend chat)** → `frontend_file_structure.md` ·
Phase 7 full-screen architecture + verification → `docs/PHASE_7_REPORT.md` ·
Screens/sound/commands → `docs/PHASE_6_REPORT.md` ·
Phase 5 quest/agent/bird internals → `docs/PHASE_5_REPORT.md` ·
Map/collision/interaction facts → `docs/PHASE_4_REPORT.md` ·
Asset measurement method → `docs/PHASE_3_REPORT.md` ·
Full plan + run commands → `docs/FRONTEND_PHASE_PLAN.md` ·
Asset pack reference → `public/assets/mailxp/ASSET_GUIDE.md`
