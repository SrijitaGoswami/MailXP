# Phase 1 — Scaffold

Read `docs/FRONTEND_PHASE_PLAN.md` and follow its constraints. The project is `C:\Users\manik\Desktop\MailXP`.

## Goal

Set up the project foundation only. Do not start the Phaser game shell, asset integration, gameplay, or full app UI in this phase.

## Work

- Create a Next.js App Router project with TypeScript in the existing project root. Do not scaffold into a nested `MailXP` folder.
- Preserve every existing file under `public/assets/mailxp/`. Do not rename, move, edit, or overwrite any art files.
- Pin the Phaser version consistently with the project plan. Do not silently change the chosen major version.
- Add the minimum project configuration needed to run the app, including `package.json`, TypeScript and Next.js configuration, and a lockfile using the chosen package manager.
- Add a minimal home page that confirms the app runs. Do not build the game screen yet.
- Add a concise `README.md` with install, development, and production build commands.
- Keep the existing asset guide available. If you move it to `docs/ASSET_GUIDE.md`, update references and leave all PNG files untouched.

## Finish and report

Run the available production build and fix errors caused by this phase. Do not add gameplay or extra screens.

Create `docs/PHASE_1_REPORT.md` with:
- What files and configuration you added
- The Next.js, React, TypeScript, Phaser, and package manager versions
- Commands to install, run, and build the project
- Confirmation that the original asset files remain intact
- Any blockers or decisions Phase 2 needs

Stop after Phase 1. Preserve unrelated files and user changes.