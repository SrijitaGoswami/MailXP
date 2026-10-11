# Phase 2 Report — Phaser Game Shell

Date: 2026-10-06 · Status: **Complete** — production build passes, page verified over HTTP, scene flow mounted.

## 1. Files changed

**New files:**

| File | Purpose |
|---|---|
| `game/config.ts` | Shared `Phaser.Types.Core.GameConfig`: 960×540, `pixelArt` + `roundPixels`, `Scale.FIT` + `CENTER_BOTH`, cream background, scene list |
| `game/createGame.ts` | `createGame(parent)` factory — the **only** module that statically imports Phaser; loaded client-side only |
| `game/scenes/BootScene.ts` | Scene `"Boot"` → starts `"Preload"` (no loading; assets are Phase 3) |
| `game/scenes/PreloadScene.ts` | Scene `"Preload"` — intentionally empty `preload()`, starts `"Title"` |
| `game/scenes/TitleScene.ts` | Scene `"Title"` — "MailXP" (teal, 72px mono) + "Phaser game shell running — Phase 2" subtitle |
| `components/PhaserCanvas.tsx` | `'use client'` host: dynamic `import()` after mount, Strict-Mode-safe cleanup |

**Modified files:**

| File | Change |
|---|---|
| `app/page.tsx` | Renders `<PhaserCanvas />` between the Phase 1 intro and a visible caption; keeps Phase 1 content |
| `docs/FRONTEND_PHASE_PLAN.md` | Phase 1 marked complete, Phase 2 result recorded (per phase instructions) |

No dependency, config, or asset changes.

## 2. Scene flow

```
Boot  ──create()──▶  Preload  ──create()──▶  Title  (renders title + subtitle, stays)
```

Started by the default scene (first in the array, `Boot`). No `this.load.*`
anywhere — no MailXP art is touched (Phase 3 boundary respected).

## 3. Phaser sizing approach

- **Fixed logical resolution: 960 × 540** (16:9, chosen in planning — Phase 3
  scales the 313×313 character source art down to fit this).
- `scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }` —
  the canvas always fits its container while preserving the logical size.
- The container (`components/PhaserCanvas.tsx`) is responsive CSS:
  `aspect-[16/9] w-full max-w-[960px]` with a walnut border + rounded corners.
- `pixelArt: true` and `roundPixels: true` in the game config (crisp
  nearest-neighbor rendering per `ASSET_GUIDE.md`).

## 4. Client-only loading & Strict Mode

- `components/PhaserCanvas.tsx` is a Client Component (`'use client'`).
- Phaser is fetched with a **dynamic `import()` inside `useEffect`**, so the
  module is never evaluated during SSR — confirmed: no `<canvas>` and no Phaser
  code in the server HTML.
- Cleanup calls `game.destroy(true)` (removes the canvas) and a `disposed` flag
  guards the async import, so React Strict Mode's mount → unmount → mount cycle
  cannot leak a game instance or produce duplicate canvases.
- Accessibility: container has `role="application"` +
  `aria-label="MailXP game window"`, plus a visible caption below the canvas.

## 5. Commands run and results

| Command | Result |
|---|---|
| `npm run build` (first attempt) | ❌ Failed — see blocker below |
| `npm run build` (after fix) | ✅ Passed — compiled, type-checked, 3 static pages |
| `npm run dev` + `GET /` | ✅ HTTP 200, clean log (`GET / 200 in 2.3s`), no warnings/errors |
| Asset re-scan | ✅ All 8 PNGs + guide intact (dimensions unchanged) |

SSR content verified: `aria-label="MailXP game window"`, `<h1>MailXP</h1>`,
scene-flow caption present; canvas correctly **absent** from SSR HTML.

**Visual canvas check not automated:** the desktop browser was not connected to
this session, so the rendered title screen was verified via build + SSR + logs
only. A manual `npm run dev` → open http://localhost:3000 confirms the canvas.

## 6. Blocker encountered (resolved)

`import Phaser from "phaser"` (default import) failed under Turbopack: Phaser
3.90's ESM build (`dist/phaser.esm.js`) exposes **named exports only** — no
default export — while `types/phaser.d.ts` uses `export = Phaser`. Fixed by
switching all Phaser imports to **`import * as Phaser from "phaser"`**.

## 7. Decisions Phase 3 needs

1. **Import style:** every new file that imports Phaser must use
   `import * as Phaser from "phaser"` (namespace import), never a default import.
2. **Asset loading goes in `game/scenes/PreloadScene.ts`** — its `preload()` is
   deliberately empty and waiting for `this.load.*` calls.
3. **Logical size is 960 × 540** — downscale the 313×313 worker frames to a
   world size that fits this (per `ASSET_GUIDE.md`, feet-anchored origin).
4. **No dependencies were changed** — Next 16.3.8 / React 19.3.0 / Phaser 3.90.0
   / Tailwind 4.3.3 remain pinned; keep them.
5. **Next.js agent files:** `next dev` auto-generates `AGENTS.md` /
   `CLAUDE.md` at the repo root (and re-adds them if removed). Keep them, or set
   `agentRules: false` in `next.config.ts` if unwanted.
6. **Canvas host is `components/PhaserCanvas.tsx`** — Phase 3+ scene wiring can
   pass events or scene classes through `game/createGame.ts` without touching SSR.

**Stop. Phase 2 is complete — no assets, movement, maps, HUD, or gameplay were added.**
