# Phase 4 Report — Playable Office Core Loop

Date: 2026-10-06 · Status: **complete** (scope: `docs/phase_4.md` only — no Phase 5 systems)

The Phaser shell now boots `Boot → Preload → Title → Office` into a small
walkable office: four-direction movement with idle/walk animation, tile + prop
collision, four depth-sorted NPCs, an `E` interaction prompt, and one complete
local demo loop — pick up the sample mail, deliver it to the Officer, earn
**+25 DraftCoin** with a visible completion banner. All gameplay state is
local; no APIs, no network calls, no wallet/email implications. The pinned
toolchain and every art file (original **and** processed) are untouched.

---

## 1. Files added

| File | Purpose |
|---|---|
| `game/scenes/OfficeScene.ts` (658 lines) | The playable office: tilemap render, camera follow, player movement/collision/animation, props + NPCs with depth sorting, interaction prompt, speech bubbles, demo-quest state machine, in-canvas HUD, typed-bridge publishing, teardown cleanup. |
| `game/data/officeMap.ts` (252 lines) | Pure-data map module: `TILE` slot ids, `TILE_LEGEND` char→slot, `TILE_NAMES` (manifest names for validation), `SOLID_TILES`, `OFFICE_ROWS` (30 × 40 chars), `PLAYER_SPAWN`, `OFFICE_PROPS` (37 placements), `OFFICE_NPCS` (4), `MAIL_PICKUP`, `rowToTiles()`. No Phaser imports. |
| `game/data/questConfig.ts` (55 lines) | The single configuration module required by the spec: `QUEST` (startingBalance `0`, reward `25`, currency `DraftCoin`, deliveryNpcId `officer`, itemName `sample mail`), `INTERACT_RADIUS` (64 px), `OBJECTIVES`, `STATUSES`, `NPC_DIALOGUE`, `POST_DELIVERY_DIALOGUE`, `CONTROLS_TEXT`. |
| `game/bridge.ts` (81 lines) | Small typed React↔Phaser bridge: `GameSnapshot`, `GameCommand` (`"start" \| "interact"`), `getSnapshot/subscribeState/publishState/subscribeCommands/sendCommand`, `TITLE_OBJECTIVE`. Framework-free (no Phaser import), so React can consume it. Every `subscribe*` returns an idempotent unsubscribe; commands with zero listeners are dropped (never queued/thrown). |
| `components/GameStatusPanel.tsx` (78 lines) | React-owned accessible panel: `aria-live="polite"` region mirroring objective/status/`DraftCoin`/carrying, **Start office** and **Interact (E)** buttons (the usable non-keyboard alternative), controls text. Cleans up its bridge subscription on unmount. |

## 2. Files changed

| File | Change |
|---|---|
| `game/createGame.ts` | Imports `OfficeScene`; the non-preview scene list is now `[BootScene, PreloadScene, TitleScene, OfficeScene]` (preview list unchanged). |
| `game/scenes/TitleScene.ts` | Adds a clickable **▶ Start office** button (pointer + hover style), `Enter`/`Space` key bindings, a bridge `"start"` command subscription, and an initial `publishState({screen: "title", …})` so the React panel's button gating can never be stale. Listeners are removed on scene shutdown/destroy (plus Phaser's own `KeyboardPlugin.removeAllListeners()` on shutdown). |
| `app/page.tsx` | Mounts `<GameStatusPanel />` under `<PhaserCanvas />`; copy updated from Phase 1/2 wording to the Phase 4 playable loop; caption now documents `Boot → Preload → Title → Office` and the live region. |

**Unchanged:** `package.json` (no dependencies added; Next 16.3.8 / React
19.3.0 / TypeScript 5.9.3 / Phaser 3.90.0 / Tailwind 4.3.3 still exact-pinned),
`game/config.ts` (its default scene list is always overridden by `createGame`,
and adding `OfficeScene` there would create an import cycle — deliberately
avoided), `components/PhaserCanvas.tsx`, `game/flow.ts`, both scripts, all 8
original PNGs (final mtime check: 13:05–13:45, i.e. Phase 3 timestamps —
nothing under `public/assets/mailxp/` was written this phase) and every
`processed/` output.

## 3. Scene & flow structure

```
BootScene → PreloadScene → TitleScene ──(button / Enter / Space / bridge "start")──▶ OfficeScene
                │
                └── (preview route only: flow.afterPreload → AssetPreviewScene, outside the game flow)
```

- `createGame.ts` registers `OfficeScene` **only** in the normal list, so
  `/preview` behavior is byte-for-byte the Phase 3 behavior.
- `TitleScene` starts the office with `this.scene.start("Office")`.
- `OfficeScene.create()` builds the world, claims the bridge
  (`publishState(screen: "office")`), and registers its command listener;
  `SHUTDOWN`/`DESTROY` events unsubscribe it.

## 4. Map structure & collision data

**World:** 40 × 30 tiles × 32 px = **1280 × 960**, larger than the 960 × 540
logical screen → `cameras.main.startFollow(player, true, 0.12, 0.12)` with
bounds clamped to the world (this also keeps the player inside the office —
the wooden south door is walkable by design).

| Rows | Zone | Tiles (manifest slot name) |
|---|---|---|
| 0–1 | Top wall: window band + teal baseboard | `window-sill` (17), `wall-top-teal` (11), `wall-base-teal` (15) — **solid** |
| 2–9 | Mail room (left) / corridor / meeting room (right); partition at col 11 reopens at row 9, glass door at row 5 col 26 | `tile-grid` (7), `carpet-cream` (2), `wood-oak` (5), `door-glass` (19) |
| 10–13 | Open carpet | `carpet-cream` (2) |
| 14–19 | Workstation row with red rug (cols 17–22) | `carpet-sage` (1), `rug-red` (8) |
| 20–27 | Quiet corner (forest) / entrance path (walnut, cols 17–22) / lounge (check rug) | `carpet-forest` (0), `wood-walnut` (4), `rug-check` (9) |
| 28–29 | Baseboard strip + south wall with wooden door (cols 19–20) | `wall-base-teal` (15), `wall-top-plain` (14), `door-wood` (21) |

- **15 of 26 manifest slots** are used; `TILE`/`TILE_LEGEND` slot ids equal
  `manifest.tiles.tiles[].slot` (carpet-forest 0 … trim-teal 24).
- **Manifest cross-check at runtime:** `OfficeScene.validateMapAgainstManifest()`
  reads the `manifest` JSON loaded by PreloadScene and verifies the
  `tileSize`, every used slot's `name` (via `TILE_NAMES`) and the matching
  `office-tiles` spritesheet frame. Drift is logged as a console error, not a
  crash. `rowToTiles()` additionally throws on any unknown map character, and
  a one-off script verified the rows are exactly 30 × 40 with all-legend chars
  (script deleted after use).
- **Collision — manual AABB, no physics system** (`gameConfig` configures
  none, per the plan):
  - `SOLID_TILES` = walls, wall base, window sill (doors walkable).
  - Player box 16 × 8 px anchored at the feet; movement resolves **X then Y**
    separately so the player slides along walls/furniture; diagonals normalized.
  - Each solid prop contributes a box covering only the **bottom 45 %** of its
    displayed height × 90 % width — the player can walk *behind* tall furniture
    and be drawn under it (depth = foot y still applies).
  - Each NPC contributes a small base box (~50 % w × 30 % h), so the player
    can't walk through characters but can approach to within interaction range.

## 5. Player, NPCs, depth sorting

| Element | Detail |
|---|---|
| Player sheet | `worker` spritesheet, rows `down/left/right/up` × cols `idle-a, idle-b, walk-a, walk-b` (frame = `directionRow * 4 + poseColumn`, from the manifest `rowsOrder`). |
| Animations | `idle-{dir}` = frames 0–1 at 1.5 fps, `walk-{dir}` = frames 2–3 at 7 fps, both `repeat: -1`, created once (`anims.exists` guard). |
| Anchoring | `setOrigin(0.5, 1)` — every character/prop is feet-anchored; `PLAYER_SCALE = 0.2` (313 px frame → 62.6 px). |
| Movement | Arrows + WASD, 110 px/s, `delta` clamped to 50 ms (tab-switch jump guard). |
| Interact pose | On interaction: texture → `worker-interact` (frames `down/left/right/up`) at `INTERACT_SCALE` (same display height as the worker), held 700 ms; moving cancels it and **restores** the worker texture before walk/idle anims resume. |
| NPCs | All 4 placed (`officer` 1056,180 · `agent` 470,620 · `monkey` 1000,800 · `intern` 288,300), frame `{id}-{facing}`, `NPC_SCALE = 0.16`. |
| Depth sorting | `depth = foot y` every frame for the player; props/NPCs set once at placement; on-desk items (computer, envelope, papers, mug) carry `depth = supportingProp.y + 0.5` so they draw in front of their desk; prompt/bubble = 100 000+, HUD = 1 000 000 with `setScrollFactor(0)`. |

## 6. Controls & interactions

| Action | Input | Effect |
|---|---|---|
| Move | Arrow keys / WASD | 4-dir walk (idle/walk animation per facing), feet-anchored, collision-clamped. |
| Interact | `E` **or** the panel's **Interact (E)** button | Uses the nearest target within 64 px (feet-to-feet): talk, pick up, deliver, check mailbox. |
| Start office | Click **▶ Start office** / `Enter` / `Space` on the title **or** the panel's **Start office** button | `TitleScene → OfficeScene`. |
| Read objective | — | In-canvas HUD (objective top-left, DraftCoin/Mail top-right, status, controls hint) **and** the React `aria-live` panel below the canvas. |

Prompt labels: `[E] Pick up the sample mail` (mailbox, pickup stage) ·
`[E] Check the mailbox` (after) · `[E] Talk to {name}` ·
`[E] Deliver mail to Officer` (carrying + delivery target). The prompt is a
styled text object pinned above the nearest target's head; NPCs answer with a
word-wrapped speech bubble (~2.6 s fade).

## 7. Local demo behavior (one complete loop)

Stage machine `pickup → deliver → done`, all state in `OfficeScene`, all
tunables in `game/data/questConfig.ts`:

1. **Pick up** — interact with the mail-room mailbox: stage → `deliver`,
   `carrying = true`, bobbing `mail-closed` icon follows above the player's
   head, a bobbing **`!`** marker appears over the Officer, status/objective
   update, bubble "Take this to the Officer."
2. **Deliver** — interact with the Officer while carrying: `carrying = false`,
   stage → `done`, `draftCoin += QUEST.reward` (0 → 25).
3. **Complete + reward message** — status `Delivery complete! +25 DraftCoin.`,
   bubble `Thanks! +25 DraftCoin`, and a full-width animated **completion
   banner**; objective switches to the free-roam line.
4. **Afterwards** — mailbox reports empty, NPCs switch to
   `POST_DELIVERY_DIALOGUE`. Re-interaction at any point publishes the new
   snapshot to the React panel.

Starting balance 0, reward 25 — changeable in `questConfig.ts` alone.
**Local only:** the game code contains no `fetch`/API calls; the bridge is an
in-page pub/sub; `DraftCoin` is a plain number displayed as demo text.

## 8. Typed bridge & accessibility (React side)

| Channel | Direction | API |
|---|---|---|
| State | Phaser → React | `publishState(patch)` merges a `GameSnapshot` (`screen`, `objective`, `status`, `draftCoin`, `carrying`); `subscribeState` / `getSnapshot` for React. |
| Commands | React → Phaser | `sendCommand("start" \| "interact")`; `TitleScene` and `OfficeScene` subscribe. |

- `GameStatusPanel` renders the snapshot inside
  `aria-live="polite" aria-atomic="true"` (screen readers hear objective,
  status and balance changes without watching the canvas) and provides the
  spec's *usable alternative way to read/act on the objective*: **Start
  office** (enabled only on the title) and **Interact (E)** (enabled only in
  the office) buttons.
- **Cleanup:** the panel's `useEffect` returns the bridge unsubscribe
  (idempotent → Strict-Mode double-mount safe); `TitleScene` and
  `OfficeScene` unsubscribe on `SHUTDOWN` and `DESTROY`; Phaser's
  `KeyboardPlugin.shutdown()` removes keyboard listeners on scene shutdown
  (verified in `node_modules/phaser/src/input/keyboard/KeyboardPlugin.js`,
  line 883). Zero listeners ⇒ `sendCommand` is a silent no-op.

## 9. Build & verification results

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean (after fixing issue 1 in §10). |
| `npm run build` | ✅ Next.js 16.3.8 (Turbopack), compiled, TypeScript clean, 4 static pages: `/`, `/_not-found`, `/preview`. |
| HTTP (production server) | ✅ `/` **200** (8,439 B), `/preview` **200** (7,597 B); `aria-live` region and status panel present in the served HTML. Port 3000 was already occupied by an unrelated leftover server, so verification ran on `npx next start -p 3001`. |
| Bundle content | ✅ production chunks contain the Phase 4 quest text and the manifest-drift validator (3 matching chunks). |
| `node scripts/verify-atlas-parse.js` | ✅ PASS × 5, exit 0 — Phase 3 atlases still parse through Phaser 3.90's own parser (assets undisturbed). |
| Asset integrity | ✅ no writes under `public/assets/mailxp/` this phase (all originals keep Phase 3 mtimes 13:05–13:45; `processed/` untouched). |
| Map data | ✅ 30 rows × 40 chars, every character in `TILE_LEGEND`, spawn (624, 860) on walkable walnut path; slots match manifest names (also re-verified at runtime, §4). |
| Dependencies | ✅ `package.json` unchanged — no new packages. |

## 10. Issues found & fixed during this phase

1. **TypeScript literal-type leak:** `statusLine` was inferred as the literal
   type of `STATUSES.intro` (`as const`), so later `setStatus(...)` calls
   failed with `TS2322`. Fixed with an explicit `: string` annotation.
2. **Interact pose texture leak:** when movement cancelled the 700 ms pose,
   `poseUntil` was zeroed *before* the restore block, so walk/idle animations
   could play on the `worker-interact` texture at the wrong scale. Rewrote the
   condition so the worker texture is restored on **either** pose expiry
   **or** movement cancellation.
3. **Scene re-create staleness:** `solidBoxes`/`grid` accumulated on restart
   and `carryIcon`/markers kept references to destroyed objects. All are reset
   at the top of `create()`.
4. **Missed bridge publish:** the "Nothing to interact with here." branch
   returned without `syncBridge()`, leaving the React panel stale. Added.
5. **Stale panel gating after re-mount:** the bridge snapshot is module-level
   and survives game destruction; a re-created `TitleScene` now publishes
   `screen: "title"` (plus fresh balance/objective) so the React buttons can't
   stay stuck in the "office" state. The title objective string was hoisted to
   `TITLE_OBJECTIVE` in `bridge.ts` to avoid duplication.

*(Environment note, not a bug: port 3000 was occupied by an unrelated server;
all verification used port 3001.)*

## 11. Visual-inspection result

**Live in-browser inspection of the running game: attempted twice, NOT done.**
The desktop browser is not connected to this session — both
`browser.tabs.open(...)` and `browser.tabs.list(...)` returned
`[browser.disconnected] No desktop browser is connected to this session.`
The office, movement, collision, NPC interaction, pickup/delivery and reward
flow could therefore **not be visually confirmed**; this is recorded here as
required.

What was verified instead: TypeScript ✅, production build ✅, HTTP 200 on `/`
and `/preview` with the accessible panel in the served HTML ✅, Phase 4 code
present in the production bundle ✅, `verify-atlas-parse.js` PASS × 5 ✅, map
data + manifest slot/name cross-check ✅, assets untouched ✅.

**What to look at first, once a browser is connected** (suggested manual
checklist): tilemap renders with correct slots (no carpet/wall mix-ups);
camera follows and stops at world edges; player animates each direction and
cannot pass walls/desks/NPCs; characters sort by foot position (walk behind
the desks/couch); prompt appears within 64 px and `E` triggers
pose + bubble; mailbox → carry icon + `!` marker → Officer delivery → banner
`+25 DraftCoin` + panel live-region update; React buttons and `Enter`/`Space`
start the office; no console errors/warnings.

## 12. Notes & blockers for Phase 5

1. **Visual/motion pass first.** Nothing in Phase 4 was seen running (§11);
   before layering Phase 5 systems on top, do the checklist above — timings
   (`PLAYER_SPEED = 110`, idle 1.5 fps / walk 7 fps, 700 ms pose, camera lerp
   0.12) are sensible first guesses, not tuned values.
2. **Single-quest machine must be generalized.** `QuestStage = keyof typeof
   OBJECTIVES` and the `pickup → deliver → done` flow are hard-wired to one
   demo quest; a multi-quest system needs a quest list + per-quest stage data
   in `questConfig.ts` (good news: everything tunable already lives there).
3. **HUD duplication to reconcile.** The in-canvas HUD (objective/status/
   controls) and `GameStatusPanel` intentionally overlap for Phase 4's
   accessibility requirement. Phase 5's "real" HUD should absorb the canvas
   side while `GameStatusPanel` stays the accessible mirror fed by the bridge
   — extend `GameSnapshot` (e.g. `mailCount`, `questTitle`) rather than adding
   a second channel; the pub/sub already handles new fields.
4. **Bridge is intentionally minimal** (2 channels, fixed snapshot shape, no
   queueing). Commands sent with no listeners are dropped — fine for buttons
   gated by `screen`, but Phase 5 features relying on queued commands would
   need deliberate design.
5. **Out of scope, untouched as required:** AI workers (8 frames ready),
   mail bird (8 frames + flap ready), effects atlas (14 frames ready —
   `sparkle`, `pickup-burst`, `coin-burst`, `quest-burst`, `levelup-burst`
   are loaded but unused), multi-quest, full HUD, wallet/shop, audio, backend.
   `/preview` and `validate-assets.ps1` behavior unchanged.
