# Phase 7 Report — Full-Screen Game Redesign

Date: 2026-10-10 · Status: **complete** · Frontend-only · No new dependencies ·
Art untouched · `tsc --noEmit` exit 0 · `next build` exit 0 · dev-server
browser verification performed (details and honest caveats in §5).

## 1. Summary

MailXP is now a full-browser-viewport game instead of a game embedded in a
webpage. The page frame, header, tab strip, instruction/status panel, Jobs
section and footer are gone. The flow is: minimal title overlay (MailXP +
"Deliver. Grow. Level Up." + Play) over the live office backdrop → compact
in-game HUD (Lv / XP / DraftCoin + Tasks shortcut, top-left) with one Menu
button (top-right) → Menu side panel overlaying the game with all six sections
(Tasks, Character, Inventory, Shop, Rewards, Settings). Opening the title
overlay or the menu **pauses** the game; closing resumes it. The Phaser canvas
is still mounted exactly once and never unmounts.

Per the six Agentation annotations and the confirmed choices: office scene as
title backdrop; tagline "Deliver. Grow. Level Up."; HUD = Level·XP·Coins +
Tasks shortcut; Menu top-right; panel frame restyled while the screen interiors
were reused unchanged.

## 2. Architecture decisions

- **The office is the always-live scene.** Phaser boots
  `Boot → Preload → Office` (`game/createGame.ts`, `game/flow.ts`); the React
  title overlay sits on top of the live (paused) office, which gives the chosen
  "office as title backdrop" for free. `game/scenes/TitleScene.ts` was deleted
  (its start-button duty moved to the React Play button → `set-paused`
  command). The `start` bridge command is kept but ignored by OfficeScene
  (legacy callers such as the old Inventory flow).
- **One pause switch.** New typed bridge command
  `{ type: "set-paused", paused }` (`game/bridge.ts`). OfficeScene boots with
  `paused = true`; `update()` early-returns while paused (draining the E-key
  `JustDown` edge each frame so a keypress inside a menu never fires an
  interact on resume), `interact()` and the decor pointerdown handler are
  gated, and held touch directions are cleared on pause. AppShell sends
  `set-paused: !started || menuOpen` — both overlays share one switch.
- **Adaptive viewport without stretching.** `game/config.ts` now uses
  `Scale.RESIZE` (canvas always fills its container); the camera stays at
  zoom 1 with `pixelArt`/`roundPixels`, so pixels are 1:1 crisp and bigger
  screens simply reveal more of the office (the whole 1280×960 office fits on
  a 1296×890 viewport; a 390×844 phone gets a follow-cam at native scale —
  larger art than the old FIT-in-a-box rendering). Viewport-anchored canvas
  overlays reposition on `Scale.Events.RESIZE` (`layoutScreenOverlays`).
  `/preview` keeps `Scale.FIT` in its 16:9 box (set per-instance in
  `createGame`).
- **React overlay system** (`components/AppShell.tsx`, full rewrite):
  `h-[100dvh]` root with `overflow-hidden`; `body.mailxp-game-active`
  (scoped in `app/globals.css`) blocks page scroll only on the game route;
  title overlay (z-30), HUD + Menu button + touch pad (z-20), menu backdrop +
  panel (z-30/40). Canvas container `#mailxp-stage` is `absolute inset-0`.
- **Menu** (`components/GameMenu.tsx`, new): `role="dialog" aria-modal`
  side panel (440px max, full width on phones, internal scroll) with a
  vertical ARIA tablist (roving tabindex, Arrow/Home/End) and the six
  sections. All six stay mounted (`hidden` toggle) so in-progress state — e.g.
  a half-edited reply — survives navigation. Escape (document listener) and
  backdrop click close; focus moves into the dialog on open and returns to the
  Menu button on close. Reused interiors: `QuestPanels` (Tasks: jobs list +
  reply review), the five existing screens via their existing `onGo*` callbacks.
- **HUD** (`components/GameHud.tsx`, new): `pointer-events-none` wrapper
  (chips + Tasks button re-enable it) so taps between controls still reach the
  canvas for decor placement; Menu button lives in AppShell.
- **Accessibility duty moved, not dropped.** The old GameStatusPanel was
  removed (spec); its `aria-live` announcement role lives in
  `components/GameAnnouncer.tsx` (sr-only, inactive until Play). Its mouse
  "Start office" button was replaced by the Play button; its "Interact"
  button is replaced by the on-screen Interact (E) button (Settings → Controls
  → Always) plus the in-canvas prompt and the `E` key. In-canvas HUD slimmed to
  the transient status line (bottom-center, resize-aware); objective/stats/
  controls strips removed (React HUD + Tasks panel own them now).
- **Decor flow adjustment** (`components/screens/InventoryScreen.tsx`):
  Place/Move now closes the menu panel (`onStartPlacement` callback) so the
  map is visible/clickable; the old `scrollIntoView` helper was removed
  (nothing scrolls anymore).

## 3. Changed files

| File | Change |
|---|---|
| `components/AppShell.tsx` | **Rewritten**: title overlay, HUD, Menu button, GameMenu wiring, pause/review/sending effects, body class, focus return |
| `components/GameMenu.tsx` | **New**: dialog + vertical tablist + six sections (QuestPanels + the five screens) |
| `components/GameHud.tsx` | **New**: Lv/XP/DraftCoin chips + Tasks shortcut overlay |
| `components/GameAnnouncer.tsx` | **New**: sr-only `aria-live` region (replaces GameStatusPanel's announcements) |
| `components/GameStatusPanel.tsx` | **Deleted** (spec §5) |
| `components/PhaserCanvas.tsx` | Game mode = `absolute inset-0` fill; `/preview` keeps the boxed 16:9 stage |
| `components/TouchControls.tsx` | Corner overlay (pad bottom-left, E bottom-right), `pointer-events-none` wrapper, new `hidden` prop (menu open / pre-Play) |
| `components/screens/InventoryScreen.tsx` | `onStartPlacement` callback (closes menu); drop `scrollIntoView`; comment updates |
| `components/QuestPanels.tsx` | Panel-context width (`w-full`) + docstring (lives in Tasks section now) |
| `game/bridge.ts` | `set-paused` command; `TITLE_OBJECTIVE` removed (initial objective `""`); comments |
| `game/config.ts` | `Scale.RESIZE`; `GAME_WIDTH/HEIGHT` kept as design baseline; comments |
| `game/createGame.ts` | Scene list without TitleScene; `flow.afterPreload = "Office"`; preview keeps FIT scale |
| `game/flow.ts` | `afterPreload: "Office"` + comment |
| `game/scenes/OfficeScene.ts` | Boot-paused + `set-paused`/`setPaused`; pause gates in `update`/`interact`/decor input; HUD slimmed to status line (bottom-center) with `RESIZE` repositioning; banner/bird use `this.scale.width/height`; `GAME_WIDTH/HEIGHT`/`CONTROLS_TEXT` imports removed |
| `game/scenes/TitleScene.ts` | **Deleted** (office is the always-live scene; branding is the React overlay) |
| `game/data/questConfig.ts` | `CONTROLS_TEXT` removed (last consumer gone) |
| `app/globals.css` | `body.mailxp-game-active { overflow: hidden; overscroll-behavior: none }` (route-scoped) |
| `app/page.tsx` | Comment update only |
| `docs/` + `context.md` + `README.md` | This report; plan/status/docs refreshed |

## 4. What was intentionally preserved

Persistence (`localStorage["mailxp.profile.v1"]`), the 26 synthesized sounds +
buses/mute/unlock, reduced-motion (`data-motion` + OS query), touch controls
pref (auto/on/off), the quest loop/agents/mail-bird/review economy, decor
grid-snap rules, `/preview`, Agentation dev toolbar, and the no-backend /
no-new-deps / no-test-framework / never-edit-art rules.

## 5. Verification record (actual runs, 2026-10-10)

Dev server (`npm run dev`, localhost:3000), desktop browser tooling, plus DOM
probes via `evaluate`.

**Automated:** `npx tsc --noEmit` → 0 · `npx next build` → 0 (static routes
`/`, `/preview`). Asset scripts not re-run (no asset changes; Phase 6 result
stands).

**Title → game:** boot shows title over the live office backdrop (screenshot);
tagline + Play present; Play → title gone, HUD (Lv 1 · 0/100 XP · 0 DC) and
Menu button render, focus moves to the Menu button, page scroll locked
(`body` overflow hidden; doc height == viewport).

**Adaptive viewport:** canvas = full viewport at 1296×890 (whole office
visible, 1:1 pixels); at the live 484×889 window the canvas fills 484×889 and
everything still works; at 390×844 (same-origin iframe harness) canvas filled
390×844, HUD rendered, D-pad overlay rendered, no page scroll.

**Movement/input:** held synthetic Arrow keys walk the player (≈110 px/s, 4-dir
facing verified via screenshots); collision blocks furniture; `E` with no
target → "Nothing to interact with here." via status line + announcer;
near the Monkey → `[E] Talk to Monkey` prompt, dialogue bubble + status +
announcer all synced.

**Menu/pause:** Menu button opens the dialog (backdrop dims game, focus in
dialog, 6 tabs, Tasks preselected with the Jobs list); held ArrowUp for 700 ms
while open moved nothing (pause verified); game resumes after close; Escape
closes and returns focus to the Menu button (`aria-expanded` toggles); section
switches by click (Character/Inventory/Settings content verified) and by
keyboard (ArrowDown moved Character → Inventory with focus follow); Tasks
shortcut opens the menu on Tasks.

**Decor:** with a seeded profile (50 DC + Mountain Print), Inventory →
Decorate **closed the menu** and the announcer asked for a spot; a real
`mousedown` on the map placed the print at snapped (688,112) — persisted in
`localStorage`, sprite visible on the wall (screenshot), status confirmed.

**Responsive:** menu panel at 390px viewport = 386px full-width, right-aligned,
all six tabs, internally scrollable; at 484px = 436px; HUD chips wrap.

**Cleanliness:** dev console checked at `warning`+ level after the full
sequence — 0 messages. Profile reset to defaults and re-verified (fresh boot,
default stats, office objective published). `/preview` regression: canvas
boots in 16:9 box (921×518), page scroll normal there (game body class does
not leak).

**Not run (honest gaps):** the four-job quest chain was not re-played
end-to-end in Phase 7 (the quest code paths are unchanged; job 1 pickup was
not re-collected because the mailbox is unreachable by blind synthetic
navigation — the same limitation Phase 6 recorded); the reply-review
auto-open → menu-Tasks wiring was code-verified (same bridge effect pattern
as the proven Phase 6 auto-switch) but not re-triggered live; no audio heard
(no audio device in harness); no screen-reader pass (announcer reuses the
Phase 6 live-region pattern); screenshots became unavailable mid-session
(desktop window not visible), so the mobile-iframe and late checks are
DOM-verified only.

## 6. Known limitations / notes for the next agent

- **Phaser listens to `mousedown`/`mouseup`** on the canvas in this
  build (Phaser 3.90 `MouseManager`), not `pointerdown` — synthetic
  `PointerEvent`s do nothing. If you script decor tests, dispatch
  `MouseEvent`s.
- The **same-origin iframe harness trick** (parent tab on localhost embedding a
  390×844 iframe) works for layout checks but its nested app never booted the
  office scene (Phaser appears to stall pre-Office under the nested context;
  a hydration warning also appears in that tab). Not reproducible in a normal
  tab — normal boot is clean.
- OfficeScene boots paused; anything that expects the game to be live
  immediately must send `set-paused false` (AppShell's Play does).
- `GAME_WIDTH/GAME_HEIGHT` (`game/config.ts`) are now design-baseline
  constants only — gameplay code must use `this.scale.width/height`.
- The in-canvas status line sits bottom-center to clear the HUD (top-left) and
  the touch pad corners; long messages wrap within `scale.width − 360`.
- Body scroll lock is scoped: `body.mailxp-game-active` added/removed by
  AppShell's mount effect; `/preview` keeps normal scrolling.
- The old `start` command and `screen === "office"` checks still exist and are
  harmless; they could be retired in a future cleanup.

## 7. Verification of spec acceptance criteria

Viewport fills browser ✓ · minimal title → office ✓ · no page-level tab strip /
status card / jobs section outside the overlay system ✓ · menu opens with all
six sections without shifting/unmounting the canvas ✓ · Tasks holds jobs +
totals, Character holds outfits, Tasks shortcut opens Tasks ✓ · compact HUD
during play, non-obscuring ✓ · panel blocks movement/job actions, closing
resumes ✓ · crisp 1:1 art, larger screens reveal more office ✓ · persistence/
sound/a11y/touch preserved ✓ · report records only checks actually run (§5).

## 8. Post-report fixes — annotation round 1 (2026-10-10)

Two live-review annotations were filed against the shipped Phase 7 build and
fixed after §1–§7 were written:

| Annotation | Complaint | Root cause | Fix |
| --- | --- | --- | --- |
| `mv1enpjs-jmv0rx` (on canvas) | "not full screen … fix it properly" | The office world (1280 × 960) is finite, so any viewport wider/taller than the world left bare `#f7f1e3` background strips around the map | `OfficeScene.createSurround()`: one huge TileSprite (map + 4096 px pad, depth −1) tiled from the shipped `woodWalnut` tile fills every margin at any window size; camera stays zoom 1 (characters never enlarged). A `setTint` variant was dropped — tint on TileSprite did not visibly apply; the natively-dark walnut reads correctly without it |
| `mv1enpjs-jmv0rx` (same) | browser fullscreen wanted | — | AppShell gained a user-invoked **"Full screen"** button beside ☰ Menu (`requestFullscreen` on `<html>`, `aria-pressed`, support-detected after mount so SSR/hydration match; Esc exits via the browser) |
| `mv1eos7n-wr6xut` (Shop list item) | "texts are overlapping … fix the proper UI" | `ShopScreen` grid used viewport breakpoints (`sm:grid-cols-2 xl:grid-cols-3`) inside the fixed **440 px** menu panel — at any window ≥ 640 px the cards squeezed to ~198 px while `min-w-48` text columns kept 192 px, overflowing onto neighbours | Grids are now panel-scoped: Shop = single column (all 5 grids), Rewards `dl` = 2 × 2 (also dropped `sm:grid-cols-4`) |
| (found while fixing) | Shop "Place in office" left the menu open with the office hidden | Phase 7 wired `onStartPlacement` into Inventory but not Shop; Shop also still called the dead `scrollIntoView("mailxp-stage")` / "office above" copy | `ShopScreen.onStartPlacement` added, passed from `GameMenu` — Place switches the panel to Inventory (its cancel bar) **and closes the menu**; dead scroll/copy removed |

Verification actually run for this round: `tsc --noEmit` 0 · live DOM
measurement — all five Shop grids `grid-template-columns: 353px` (1 column),
0 child/text overflows, 0 sibling overlaps; Rewards `dl` 2 × 170.5 px, 0
overflows · Place flow end-to-end — menu auto-closes, synthetic `mousedown`
places `art-mountain` at snapped (592, 368), persists to `placedDecor`,
announced "Mountain Print placed…" · edge pixel samples of a live screenshot:
canvas margins now walnut planks (≈ `RGB 190,140,80` + dark plank gaps) where
they were bare `RGB 247,241,227` background before · console 0 errors /
0 warnings · seeded test profile removed afterwards (localStorage back to
defaults).

**Honest gap:** Fullscreen *engagement* could not be observed — in the
automated browser `requestFullscreen()` never settles (no permission-granting
tool exists), so the button was verified to render, wire its handler, and
cause no errors; the standard API with a real user gesture is untested here.
