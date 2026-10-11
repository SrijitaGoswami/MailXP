# MailXP Frontend — Phase 7: Full-Screen Game Redesign

## Objective

Transform the existing MailXP frontend from a game displayed inside a webpage into an immersive, full-browser-viewport game experience. Follow the user's six Agentation annotations and confirmed choices below. This phase is a visual and interaction-layout change; preserve existing frontend gameplay and local demo behavior.

## Confirmed product choices

- Show a minimal title screen first, with MailXP branding, one short tagline, and a clear Play button.
- After Play, show the office game across the browser viewport.
- Replace the external tab strip with one in-game Menu button. It opens a side panel containing Tasks, Character, Inventory, Shop, Rewards, and Settings.
- Keep a compact HUD visible during play for key stats such as level, XP, and coins, plus a task shortcut.
- Keep pixel art crisp and show more of the office on larger screens. Adapt the camera viewport to the available space instead of enlarging characters and objects. Use nearest-neighbor/integer scaling where practical, never stretch artwork unevenly, and keep the player and essential interactable areas visible.
- Opening a menu pauses player movement and job actions; closing it resumes play.

## Required changes

1. **Full-viewport experience**
   - Use the full available browser viewport for the title screen and active game (including mobile viewport units where supported).
   - Remove the centered max-width page frame, document-like content stack, and unnecessary page margins.
   - Prevent page-level scrolling during the game experience. Any long menu content must scroll inside its own panel.
   - Do not invoke browser fullscreen APIs or hide browser controls; fill the page viewport only.

2. **Title screen and branding**
   - Create a restrained title screen with “MailXP”, one concise tagline, and a prominent Play button.
   - Use polished typography and a premium, cohesive treatment that still matches the established top-down pixel-art world.
   - Avoid extra explanatory paragraphs, tutorial copy, and repeated MailXP branding.
   - If the project already has a tagline, reuse it. Otherwise use a concise line such as “Deliver. Grow. Level Up.”

3. **In-game navigation and overlays**
   - Remove the page-level Game / Character / Inventory / Shop / Rewards / Settings tab strip.
   - Add a clearly discoverable in-game Menu control. Its side panel overlays the game instead of pushing or resizing the canvas.
   - Provide Tasks, Character, Inventory, Shop, Rewards, and Settings inside that panel, reusing the existing frontend screens and behavior where possible.
   - Move the Jobs list and all job totals into the Tasks panel. Do not leave a jobs/status section below or beside the game as page content.
   - Move outfit selection into Character. Keep shop decor browsing and placement behavior in Shop, preserving current local demo persistence.
   - Keep the Phaser canvas mounted while navigating menus so returning to play does not reset the game.
   - Support closing the panel with its close control and Escape. Preserve keyboard focus behavior, clear accessible names, and the existing ARIA/accessibility intent.

4. **Compact in-game HUD**
   - Keep only useful at-a-glance stats (level, XP, coins) and a task shortcut visible over the game.
   - Style the HUD as an unobtrusive overlay that does not cover the player, important objects, or touch controls.
   - The task shortcut opens the same Tasks panel; avoid duplicating the jobs list in the HUD.

5. **Remove the external instruction/status panel**
   - Remove the “Ready to play / Start office / Move: Arrow keys · Interact: E” page panel and any equivalent below-canvas instructional block.
   - Do not replace it with another external content section. Keep only necessary controls discoverable through in-game UI or concise accessible labels.

6. **Responsive and accessible behavior**
   - Keep the title screen, canvas, HUD, menu button, and side panel usable at desktop, tablet, and phone viewport sizes.
   - On small screens, make the panel fit within the viewport and scroll internally; ensure it does not make the page scroll.
   - Preserve existing touch controls and audio/settings preferences. Prevent an open panel from also receiving unintended game movement/interact input.
   - Preserve reduced-motion support, visible focus, semantic controls, and keyboard operation.
   - Maintain readable contrast and text sizes over the game art.

## Scope boundaries

- Frontend only. Do not add backend services, real AI/email sending, wallet/blockchain integration, or external APIs.
- Do not refactor unrelated systems or replace the established asset library.
- Reuse current assets, localStorage-backed profile data, sound effects, game jobs, and shop behavior unless a small adjustment is required for this layout.
- Do not add unrelated features, new monetization, or new game content in this phase.

## Implementation workflow

1. Read the current project instructions and inspect the existing Phase 6 implementation, especially the app shell, Phaser sizing/camera, navigation, HUD, job panels, character/outfit screen, touch controls, and responsive styles.
2. Make a short implementation plan tied to the current files and components. Preserve working functionality and asset paths.
3. Implement the full-screen title-to-game flow and overlay structure in small, coherent changes.
4. Check the app at wide desktop and narrow mobile viewport sizes. Verify title-to-game transition, menu open/close, each menu section, task shortcut, pause/resume, keyboard/touch input, and that the Phaser scene remains mounted.
5. Run the project's existing build and type checks. Do not add a new test framework for this phase.
6. Fix issues caused by this phase, then write `docs/PHASE_7_REPORT.md` with a concise summary, changed files, checks performed and results, and any known limitations.

## Acceptance criteria

- The title screen and active game occupy the available browser viewport without a centered document frame or page-level scroll.
- The player first sees a minimal MailXP title screen with tagline and Play, then enters the office.
- No page-level tab strip, instruction/status card, Jobs list, or outfit section remains outside the game overlay system.
- The in-game Menu opens a side panel with all six requested sections without shifting or unmounting the game canvas.
- Tasks contains the jobs and totals; Character contains outfit selection; the task shortcut opens Tasks.
- The compact HUD remains visible during play, and its controls do not obscure essential gameplay.
- Opening a panel prevents movement and job actions; closing it resumes play.
- Pixel art remains crisp and proportionally scaled; larger screens reveal more of the office, with essential gameplay visible across supported viewport sizes.
- Existing frontend-only behavior, local persistence, sound, accessibility, and touch controls continue to work.
- `docs/PHASE_7_REPORT.md` records actual verification results without claiming checks that were not run.
