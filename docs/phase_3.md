# Phase 3 — Asset Pipeline

Read `docs/FRONTEND_PHASE_PLAN.md`, `docs/PHASE_1_REPORT.md`, `docs/PHASE_2_REPORT.md`, and `public/assets/mailxp/ASSET_GUIDE.md` first. Implement **Phase 3 only**.

## Goal

Load, organize, and visibly preview the existing MailXP art in Phaser. Do not add player movement, office gameplay, quests, or backend behavior.

## Requirements

- Keep the existing Next.js, React, TypeScript, and pinned Phaser versions.
- Preserve the original PNGs under `public/assets/mailxp/`. Never overwrite or rename them. Put any processed or cropped images in a separate `public/assets/mailxp/processed/` folder.
- Add asset loading to the existing `PreloadScene`.
- Integrate the player sheets using the frame layouts in `ASSET_GUIDE.md`:
  - `worker.png`: 313 × 313 frames, 4 columns × 4 rows
  - `interact-directions.png`: 543 × 724 frames, one row of 4 directions
- Define and document frame layouts for the NPCs, AI workers, and mail bird. The guide lists approximate frame sizes; inspect the images before deciding crop bounds. Do not silently assume a grid is exact where it is not.
- Create a regular 32 × 32 office tilesheet from selected floor, wall, door, and transition tiles. Use nearest-neighbor scaling. Record which source cells were used.
- Extract named frames or individual PNGs from the irregular office prop and mail/effect atlases. Record every source rectangle and output name in a machine-readable manifest.
- Keep character feet consistently anchored. Set texture and image filtering for crisp pixel-art rendering.
- Add a temporary asset preview scene or equivalent development-only view that visibly shows the loaded player directions, NPCs, AI workers, mail bird, selected props, effects, and normalized tiles. Keep this preview out of the normal gameplay flow.
- If any frame cannot be cropped reliably from the supplied art, leave its original untouched, document the specific issue, and do not claim that asset is integrated.

## Finish and report

- Build the app and fix issues caused by this phase.
- If possible, open the running app and visually inspect the asset preview. Record whether this was done.
- Update `docs/FRONTEND_PHASE_PLAN.md`: mark Phases 1–2 complete, record Phase 3’s result, and correct any stale “current state” or “missing” sections.
- Create `docs/PHASE_3_REPORT.md` with the files added or changed, asset names and frame layouts, source-to-output crop information, build result, visual-inspection result, and remaining asset issues.
- Stop after Phase 3. Do not add gameplay.

Preserve unrelated files and user changes.