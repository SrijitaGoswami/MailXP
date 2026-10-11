# Phase 2 — Phaser Game Shell

Read `docs/FRONTEND_PHASE_PLAN.md` and `docs/PHASE_1_REPORT.md` first. Implement **Phase 2 only**: mount a minimal Phaser game inside the existing Next.js app.

## Requirements

- Keep the existing Next.js, React, TypeScript, and pinned Phaser versions. Do not upgrade dependencies.
- Add a client-only Phaser host. Load Phaser dynamically after the browser component mounts so it is never initialized during server rendering.
- Create the scene flow: `Boot` → `Preload` → `Title`.
- Keep the scenes minimal. The Title scene should show a simple MailXP title or placeholder so we can tell the canvas is running.
- Use Phaser pixel-art settings (`pixelArt` and `roundPixels`) and a fixed logical game size with responsive scale-to-fit behavior.
- Clean up the Phaser game instance and event listeners on React unmount. Avoid duplicate canvases when React Strict Mode mounts components more than once.
- Add an accessible label or nearby text so the canvas has context for assistive technology.

## Boundaries

- Do not load or slice the MailXP art yet; asset integration is Phase 3.
- Do not add character movement, office maps, quests, HUD, gameplay, menus, or backend behavior.
- Preserve every existing asset and unrelated file.

## Finish and report

Run the production build and fix issues caused by this phase. Update `docs/FRONTEND_PHASE_PLAN.md` to mark Phase 1 complete and record the Phase 2 result.

Create `docs/PHASE_2_REPORT.md` with the files changed, scene flow, Phaser sizing approach, commands run, build result, and any blockers or decisions Phase 3 needs. Stop after Phase 2.