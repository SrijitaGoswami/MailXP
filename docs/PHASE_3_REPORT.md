# Phase 3 Report — MailXP Asset Pipeline

Date: 2026-10-06 · Status: **complete** (scope: `docs/phase_3.md` only — no gameplay added)

All 8 original PNGs are loaded and organized in Phaser through the existing
`PreloadScene`, with named atlas frames, a regular 32 × 32 tilesheet, a
machine-readable manifest, and a dedicated preview scene on a separate
`/preview` route. Originals were never modified.

---

## 1. Files added

| File | Purpose |
|---|---|
| `scripts/generate-assets.ps1` | Asset pipeline (`-Mode analyze` / `-Mode build`). PowerShell + System.Drawing — **zero new npm dependencies**. Does row-band + per-row segmentation for irregular atlases, measured grid bounds for grid sheets, nearest-neighbor tile extraction, atlas/manifest emission, contact sheets. |
| `scripts/validate-assets.ps1` | Programmatic verification of every build output (counts, unique names, bounds, overlaps, alpha coverage, semantic split checks, manifest ↔ atlas consistency, sheet dimensions). |
| `public/assets/mailxp/processed/office-props.json` | Phaser atlas JSON, 21 named frames |
| `public/assets/mailxp/processed/mail-effects.json` | Phaser atlas JSON, 14 named frames |
| `public/assets/mailxp/processed/office-npcs.json` | Phaser atlas JSON, 16 named frames |
| `public/assets/mailxp/processed/ai-workers.json` | Phaser atlas JSON, 8 named frames |
| `public/assets/mailxp/processed/mail-bird.json` | Phaser atlas JSON, 8 named frames |
| `public/assets/mailxp/processed/office-tiles-32.png` | Regular 256 × 128 sheet = 8 × 4 slots of 32 × 32 (26 used) |
| `public/assets/mailxp/processed/manifest.json` | Machine-readable source-rect → output-name record (70,020 bytes) |
| `scripts/verify-atlas-parse.js` | Offline test: feeds each processed atlas JSON through **Phaser 3.90's own parser source** (`node scripts/verify-atlas-parse.js`, exit 0 = pass) — asserts the `TextureManager.addAtlas()` dispatch, frame counts, spot-checked names, and manifest ↔ parsed-rect equality without a browser. |
| `game/flow.ts` | `flow.afterPreload` flag: `"Title"` (game) vs `"AssetPreview"` (preview route) |
| `game/scenes/AssetPreviewScene.ts` | Preview scene: player, interact, NPCs, AI workers, bird, props, effects, tiles; scrollable; built from the manifest |
| `app/preview/page.tsx` | `/preview` route hosting the preview canvas |

## 2. Files changed

| File | Change |
|---|---|
| `game/scenes/PreloadScene.ts` | All `this.load.*` calls for Phase 3 assets; forces `FilterMode.NEAREST` on every texture after load; `verifyAtlases()` logs a console error if any atlas registers 0 named frames; hands off to `flow.afterPreload`. |
| `game/createGame.ts` | `CreateGameOptions { preview?: boolean }`; registers `[Boot, Preload, AssetPreview]` when previewing, otherwise `[Boot, Preload, Title]`. |
| `components/PhaserCanvas.tsx` | `preview` prop forwarded to `createGame`; `aria-label` switches to "MailXP asset preview". |
| `game/scenes/AssetPreviewScene.ts` (guards) | Animations are only created when their texture exists **and** resolves every requested frame; `.play()` only fires when the animation exists — a 0-frame animation would otherwise crash `sprite.play()` on the first update and kill the render loop. |

**Unchanged:** the 8 original PNGs (final mtime check: 13:05–13:44, all predating
the pipeline runs; byte sizes identical), `ASSET_GUIDE.md`, `BootScene`,
`TitleScene`, `config.ts`, `app/page.tsx`, `package.json` (no dependencies added).

## 3. Asset names and frame layouts

### 3.1 Player sheets (exact guide grids)

| Texture key | Source | Layout |
|---|---|---|
| `worker` | `characters/player/worker.png` (1254 × 1254) | spritesheet 313 × 313 → **exact 4 × 4** (2 px unused per axis, floor grid). Rows `down, left, right, up` × cols `idle-a, idle-b, walk-a, walk-b`; frame index = `directionRow * 4 + poseColumn`. |
| `worker-interact` | `characters/player/interact-directions.png` (2172 × 724) | spritesheet 543 × 724 → **exact 4 × 1** (2172 = 4 × 543): `down, left, right, up`. |

### 3.2 Grid sheets — measured, not assumed

| Texture key | Source | Measured bounds | Frames |
|---|---|---|---|
| `office-npcs` | `characters/npcs/office-npcs.png` (1278 × 1230) | **Content-packed rows** — y bands `0, 360, 670, 958, 1230` (heights 360/310/288/272); x columns `0, 336, 639, 958, 1278` (widths 336/303/319/320). Not a uniform grid. | 16: `{officer,agent,monkey,intern}-{down,left,right,up}` |
| `ai-workers` | `characters/agents/ai-workers.png` (1774 × 887) | Snapped grid x `0, 444, 887, 1330, 1774`; y `0, 444, 887` → ≈444 × 444 cells (guide: "approx 443, 2 px remainder") | 8: `{understanding,response}-{front,left,right,back}` |
| `mail-bird` | `effects/mail-bird.png` (1774 × 887) | Same bounds as ai-workers. Top row flies right, bottom row left; columns are flap frames. | 8: `{right,left}-0..3` |

Every frame's exact `{x, y, w, h}` is in the atlas JSONs and `manifest.json` —
nothing is cropped from a nominal grid.

### 3.3 Irregular atlases (segmented, not assumed)

Method: alpha ≥ 80 → row-band projection → per-row x-segmentation (column gap
≥ 4 px, row gap ≥ 6 px) → generic auto-repair compared against expected counts
derived from visual inspection.

| Texture key | Source | Rows (raw → final) | Frames |
|---|---|---|---|
| `office-props` | `office/office-props.png` (1536 × 1024) | y-bands ≈ 71–384 / 404–737 / 757–971: **6, (5 → 6), 9** | 21: `desk, chair, computer, printer, phone, cabinet, bookshelf, couch, plant, water-cooler, notice-board, mailbox, lockers, clock, lamp, wastebasket, mug, parcel, envelope, papers, draftcoin` |
| `mail-effects` | `items/mail-effects.png` (1536 × 1024) | **6, 3, 5** (no repair needed) | 14: `mail-closed, mail-open, letter, mail-sealed, parcel, package, draftcoin, reward-token, sparkle, pickup-burst, interaction-ring, coin-burst, quest-burst, levelup-burst` |

- Props row 1 segmented as one merged blob (couch + plant, raw = 5); the
  auto-repair split it at the **minimum column-density x = 673** (true visual
  gap — verified below).
- The ASSET_GUIDE prose enumerates mail effects loosely (~13 items); the image
  itself segments into **14 distinct objects** (6 + 3 + 5). All 14 are named and
  integrated; the guide file was not edited (original preserved).

### 3.4 Tilesheet

`processed/office-tiles-32.png` — 256 × 128 = 8 × 4 slots of 32 × 32, produced
with **nearest-neighbor** scaling from content-bbox crops (full-cell fallback) of
`tilesets/office/office-tileset.png` (1774 × 887; grid 16 × 8 cells of 110.875²).

| slot | tile | source cell (row, col) | source rect (x, y, w, h) |
|---:|---|---|---|
| 0 | carpet-forest | r0 c0 | 21, 19, 90, 92 |
| 1 | carpet-sage | r0 c1 | 111, 19, 111, 92 |
| 2 | carpet-cream | r0 c4 | 458, 18, 95, 93 |
| 3 | carpet-sand | r0 c5 | 567, 18, 96, 93 |
| 4 | wood-walnut | r0 c7 | 788, 18, 94, 93 |
| 5 | wood-oak | r0 c8 | 898, 18, 95, 93 |
| 6 | tile-white | r0 c10 | 1114, 18, 97, 93 |
| 7 | tile-grid | r0 c11 | 1224, 18, 96, 93 |
| 8 | rug-red | r1 c0 | 21, 111, 90, 111 |
| 9 | rug-check | r1 c2 | 222, 111, 111, 111 |
| 10 | rug-green | r1 c6 | 677, 111, 96, 111 |
| 11 | wall-top-teal | r2 c0 | 21, 222, 90, 111 |
| 12 | wall-top-cream | r2 c1 | 111, 222, 111, 111 |
| 13 | wall-top-panel | r2 c2 | 222, 222, 111, 111 |
| 14 | wall-top-plain | r2 c3 | 333, 222, 110, 111 |
| 15 | wall-base-teal | r3 c0 | 21, 333, 90, 111 |
| 16 | wall-base-cream | r3 c1 | 111, 333, 111, 111 |
| 17 | window-sill | r3 c7 | 776, 333, 108, 111 |
| 18 | door-teal | r3 c9 | 998, 333, 105, 111 |
| 19 | door-glass | r3 c10 | 1116, 333, 104, 111 |
| 20 | door-dark | r3 c11 | 1220, 333, 100, 111 |
| 21 | door-wood | r3 c12 | 1333, 333, 108, 111 |
| 22 | transition-teal | r5 c0 | 21, 554, 90, 108 |
| 23 | transition-wood | r5 c2 | 222, 554, 111, 108 |
| 24 | trim-teal | r6 c0 | 21, 675, 90, 101 |
| 25 | trim-tile | r6 c2 | 222, 675, 111, 101 |

(Same data lives in `manifest.json → tiles.tiles[]` as
`{ name, slot, sourceCell{col,row}, sourceRect, outputRect }`.)

## 4. Runtime loading (PreloadScene)

| Texture key | Loader | Path |
|---|---|---|
| `worker` | `spritesheet` (313 × 313) | `characters/player/worker.png` |
| `worker-interact` | `spritesheet` (543 × 724) | `characters/player/interact-directions.png` |
| `office-npcs` | `atlas` | `characters/npcs/office-npcs.png` + `processed/office-npcs.json` |
| `ai-workers` | `atlas` | `characters/agents/ai-workers.png` + `processed/ai-workers.json` |
| `mail-bird` | `atlas` | `effects/mail-bird.png` + `processed/mail-bird.json` |
| `office-props` | `atlas` | `office/office-props.png` + `processed/office-props.json` |
| `mail-effects` | `atlas` | `items/mail-effects.png` + `processed/mail-effects.json` |
| `office-tiles` | `spritesheet` (32 × 32) | `processed/office-tiles-32.png` |
| `manifest` | `json` | `processed/manifest.json` |

After load, every texture is set to **`FilterMode.NEAREST`** (plus the global
`pixelArt` / `roundPixels` config). Characters are rendered bottom-anchored
(`setOrigin(0.5, 1)` — feet aligned) in the preview scene.

### Atlas JSON format (important — Phaser 3.90 dispatch)

Each `processed/*.json` is **`{ "frames": [ { "filename", "frame", "rotated",
"trimmed", "spriteSourceSize", "sourceSize" }, … ] }`** — the JSON-Array shape
under a top-level `frames` key. Phaser 3.90's `TextureManager.addAtlas()` picks
its parser with `Array.isArray(data.textures) || Array.isArray(data.frames)`:

- `{"frames": [ … ]}` → `addAtlasJSONArray` → every named frame is registered ✅
- a **bare top-level `[ … ]`** (the format originally emitted) fails the test →
  it falls through to the JSON-Hash parser, which warns
  `Invalid Texture Atlas JSON Hash given, missing 'frames' Object` and
  registers **zero frames** — reported by the user's browser console after
  Phase 3 (bug 6, §5).

All JSON outputs are written as **BOM-less UTF-8** (RFC 8259; strict parsers
reject a leading BOM) via `Write-JsonFile` in the generator.
`PreloadScene.verifyAtlases()` re-checks at runtime and logs a console error
should any atlas ever load with 0 named frames.

### Manifest contents (machine-readable)

`processed/manifest.json` keys: `generatedBy, generatedAt, originals,
atlasFrames, spritesheets, tiles`:
- `atlasFrames.<name>` → `{ source, atlas, [grid], frames: [{name,x,y,w,h}] }`
  for all five atlases (61 frames total: 21 + 14 + 16 + 8 + 8);
- `spritesheets.worker` → `{ frameWidth: 313, frameHeight: 313, columns: 4,
  rows: 4, rowsOrder: [down,left,right,up], columnsOrder:
  [idle-a,idle-b,walk-a,walk-b], frameIndex: "directionRow * 4 + poseColumn" }`;
- `spritesheets.worker-interact` → `{ frameWidth: 543, frameHeight: 724,
  frames: [down,left,right,up] }`;
- `tiles` → `{ tileSize: 32, columns: 8, sourceGrid: {cols: 16, rows: 8,
  cellWidth/Height: 110.875}, tiles: [...] }` (table above);
- `originals` → `"public/assets/mailxp/** (untouched; this folder holds derived
  outputs only)"`.

The preview scene reads its labels and frame sets **from the manifest at
runtime**, which proves the manifest is machine-readable in practice.

## 5. Build and verification results

| Step | Result |
|---|---|
| `generate-assets.ps1 -Mode analyze` | ✅ props rows 6/(5→6)/9 all OK; effects 6/3/5 OK; grid bounds emitted; contact sheets generated (hash-checked distinct). |
| `generate-assets.ps1 -Mode build` | ✅ 7 outputs written (5 atlas JSONs, manifest, tilesheet). |
| `validate-assets.ps1` | ✅ **PASSED — 0 errors, 1 warning**: counts 21/14/16/8/8, unique names, all rects in bounds, no overlaps, all frames ≥ 2 % alpha coverage (empty-frame check), couch/plant semantic check (plant 72.7 % green, couch 18.3 % warm-red), all 26 tile slots non-empty, sheet 256 × 128, manifest ↔ atlas JSON exact match, worker 1254 = 4 × 313 + 2, interact 2172 = 4 × 543. Warning = couch/plant boundary density 46 % (see §6, remaining issue 2). |
| `node scripts/verify-atlas-parse.js` | ✅ **PASS × 5** — each atlas dispatches to `JSONArray` in Phaser 3.90's own logic, parses all expected frames (21/14/16/8/8), spot-checked names present, every parsed rect equals the manifest record. |
| `npm run build` | ✅ Next.js 16.3.8 (Turbopack), TypeScript clean, 4 static pages; routes `/`, `/preview`, `/_not-found`. |
| `npm run start` + HTTP checks | ✅ all **200**: `/`, `/preview` (aria-label present), `processed/manifest.json` (70,020 B), `processed/office-props.json`, `processed/mail-bird.json`, `processed/office-tiles-32.png`, original `office/office-props.png`. Atlas JSON verified byte-level: starts `{"frames": [`, **no BOM**. Server log clean. |

### Pipeline bugs found and fixed during this phase

1. Windows PowerShell 5.1 `@(ConvertFrom-Json …)` keeps a JSON array nested
   (one pipeline object) while `@($var)` flattens it — validation initially read
   all frames as one array. Fixed by assigning first, then flattening.
2. PowerShell's case-insensitive variables: an overlap-check loop's `$A`
   silently overwrote the atlas entry `$a`. Renamed.
3. **Off-by-one in the atlas split:** `Proj`'s `to` bound is exclusive but the
   minimum-scan loop used `-le`, so `p[hi]` was always an uninitialized 0 and
   every auto-split landed at the search-range edge (x = 784). Fixed to `-lt`;
   the split now lands on the true density minimum (**x = 673**).
4. **Banker's rounding:** manifest `outputRect` used `[int]($i / 8)` —
   `[int]1.5 = 2` — so slot rows were misreported (the PNG itself, written with
   integer division, was already correct; three slots appeared "empty" only in
   the manifest). Fixed with `Floor`.
5. Expected mail-effects count corrected 13 → 14 (guide prose is loose; the
   image has 14 objects — §3.3).
6. **Atlas JSON shape rejected by Phaser (runtime, found via the user's browser
   console):** the generator emitted a bare top-level array `[{ "filename": … }]`.
   Phaser 3.90's `TextureManager.addAtlas()` dispatches on
   `Array.isArray(data.textures) || Array.isArray(data.frames)` — a bare array
   has neither property, so all five atlases were routed to the JSON-**Hash**
   parser, which warned `Invalid Texture Atlas JSON Hash given, missing
   'frames' Object` and registered **zero frames** (the preview showed no art;
   a 0-frame `pv-bird-flap` animation then crashed `sprite.play()` on the first
   update, taking the render loop down → blank canvas). Fixed by wrapping the
   array under a `frames` key (`{ "frames": [ … ] }`), plus guards so an
   animation is only created/played when its frames actually resolve. Verified
   by `scripts/verify-atlas-parse.js` running Phaser's own parser source.
7. **UTF-8 BOM in JSON outputs:** PS 5.1 `Set-Content -Encoding UTF8` writes a
   leading BOM, which strict parsers reject (RFC 8259: a JSON text must not
   start with a BOM). Replaced both write sites with a `Write-JsonFile` helper
   using `[System.IO.File]::WriteAllText(…, UTF8Encoding($false))`; the
   verification script additionally strips a BOM defensively.

## 6. Visual-inspection result

**Live in-browser inspection of the running preview: attempted twice, NOT
done.** The desktop browser is not connected to this session
(`browser.disconnected` on every attempt, including one after the format fix),
so the canvas rendering could not be observed. This is recorded here as
required. Instead, the atlas loading path is covered offline by
`scripts/verify-atlas-parse.js`, which executes Phaser 3.90's actual parser
source against the shipped JSONs.

**Frame-level visual verification: DONE — every extracted frame was viewed and
confirmed** via labeled contact sheets
(`C:\Users\manik\AppData\Local\Temp\mailxp-asset-debug\`) and labeled composites:

- `comp-grids.png` — worker (16), interact (4), AI workers (8), mail bird (8):
  all frames correct, labels correct.
- NPC contact — 16/16 frames intact.
- `verify-atlases-880.png` — four labeled sections:
  A) couch/plant split check (red line at x = 673 falls exactly between the
  couch and the fully intact plant), B) props contact: all 21 frames correctly
  named and unsliced, C) effects contact: all 14 frames correctly named and
  unsliced, D) tile contact: all 26 tiles render, including `door-wood`,
  `transition-teal`, `transition-wood` (which the manifest rounding bug had
  reported as empty before the fix).

**Remaining asset issues:**

1. **Worker frame slivers:** some worker frames show ~1–3 px of shadow at their
   top edge, inherited from the source sheet's exact 4 × 4 grid (guide-confirmed
   layout). Not re-cropped — the guide grid is respected; negligible at game
   scale. Integrated, but noted.
2. **Couch/plant boundary warning (validation's only warning):** this gap
   carries overlapping glow/leaf pixels, so column density bottoms out at 46 %
   of couch interior rather than ~0. The split uses the true minimum column
   (x = 673) and the visual check shows a clean separation. Integrated.
3. **Mail-effects naming vs guide prose:** 14 segmented objects vs the guide's
   loose ~13-item enumeration; all 14 named and integrated, guide left unedited
   (§3.3). Integrated.
4. **Live canvas preview not visually inspected** (browser disconnected, above).
   Everything else was verified both programmatically and visually.
5. No frame was found unreliable — **nothing is excluded from integration.**

## 7. Preview route (deviation-free vs `phase_3.md`)

- `/preview` mounts `PhaserCanvas preview` → `createGame(parent, { preview: true })`
  → scenes `[Boot, Preload, AssetPreview]`; the normal game flow
  (`Boot → Preload → Title`) never registers or starts `AssetPreviewScene`, so
  the preview is kept out of normal gameplay flow.
- Sections shown (scroll via arrows / WASD / drag / wheel): player 4 × 4 grid +
  animated walk, interact poses, 16 NPCs, 8 AI workers, 8 bird frames +
  animated flap, 21 props, 14 effects, 26 tiles at 2 ×.

### What you should see in the browser (after `npm run build && npm run start`)

**`/` (home)** — the Phase 2 game shell: a 960 × 540 canvas (cream
`#f7f1e3`) with the MailXP title screen; no preview content ever leaks in.

**`/preview`** — one 960 × 540 canvas, dark `#24242b`, containing eight
stacked, labeled sections, all pixel-crisp (NEAREST):

1. Player worker — 16 frames in a 4 × 4 grid labeled `down-idle-a` …
   `up-walk-b`, plus a **looping animated walk-down** sprite; feet anchored.
2. Interact — `down / left / right / up` envelope poses (543 × 724 each).
3. AI workers — 8 frames (`understanding/response` × `front/left/right/back`).
4. NPCs — 16 frames (`officer/agent/monkey/intern` × `down/left/right/up`).
5. Mail bird — 8 frames (`right-0..3`, `left-0..3`) + **looping flap**
   animation.
6. Office props — all 21 named objects (`desk`, `couch`, `plant`, …).
7. Mail effects — all 14 named items/effects (`mail-closed`, `levelup-burst`, …).
8. Tiles — all 26 tiles at 2× with names (`carpet-forest`, `door-wood`, …).

Navigation: mouse wheel / arrow keys / WASD / drag scrolls; **Home/End jump to
top/bottom**. The HUD line at the top states frame counts per section.

Console should be free of warnings — in particular **no**
`Invalid Texture Atlas JSON Hash given, missing 'frames' Object`, and no
`[MailXP] atlas … registered 0 named frames` error. A clean console means every
named frame registered.

## 8. Repro commands

```powershell
powershell -File scripts/generate-assets.ps1 -Mode analyze   # segmentation report + contact sheets
powershell -File scripts/generate-assets.ps1 -Mode build      # writes public/assets/mailxp/processed/
powershell -File scripts/validate-assets.ps1                  # validates outputs (exit 0 = pass)
node scripts/verify-atlas-parse.js                            # Phaser-parser test (exit 0 = pass)
npm run build && npm run start                                # http://localhost:3000/preview
```
