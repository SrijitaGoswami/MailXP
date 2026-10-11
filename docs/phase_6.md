# Phase 6 — Frontend Completion, Sound Effects, and Polish

Read `docs/FRONTEND_PHASE_PLAN.md` and the Phase 1–5 reports before editing. Complete the remaining frontend work only. Do not add backend integrations.

## Finish the frontend screens

Add accessible, responsive React screens or panels for:

- Character selection and appearance, using only available character assets and honest previews
- Inventory and equipped cosmetic items
- A demo shop with local sample cosmetics and clearly simulated purchases
- Rewards and wallet preview, clearly distinguishing local DraftCoin from a real on-chain balance
- Settings for sound, motion, and controls

Keep the existing gameplay, quests, reply review, agents, HUD, and mail-bird behavior working. Make navigation and controls functional; don’t leave decorative dead buttons. Persist harmless demo preferences and loadout locally if appropriate.

Clearly label wallet connection, purchases, claims, email sending, and NFT actions as demo-only or future integrations. Do not create fake transaction hashes, imply real email delivery, or call backend, AI, email, wallet, or blockchain services.

## Sound effects

Add short, cohesive pixel-game sound effects for meaningful UI and gameplay actions, including:

- UI: button activation, navigation/tab change, opening/closing a panel, selection/equip, purchase confirmation, cancel, and insufficient-funds or blocked actions
- Office: footsteps at a restrained interval while moving, interaction prompt/action, NPC conversation, and collision feedback
- Mail and quests: mail pickup, quest activation, agent dispatch/arrival, classification result, draft ready, reply review, simulated-send confirmation, bird launch/flap/pass, delivery/reward, quest completion, and level-up

Use the supplied sounds if the project already contains suitable licensed files. Otherwise, make simple local synthesized sounds with the Web Audio API; do not download audio or add a sound library just for this. Keep effects brief and gentle, avoid repetitive or startling sounds, and throttle footsteps, collisions, and other repeatable effects so they cannot spam.

Centralize sound playback behind a small typed audio manager with named events and configurable volume. Add settings for master volume, UI volume, game volume, and mute; persist those preferences locally. Do not autoplay: create or resume audio only after the player’s first explicit interaction. Respect reduced-motion settings, pause optional ambience when the tab is hidden, and ensure muting takes effect immediately. Do not add background music unless suitable licensed audio already exists.

## Polish

- Refine responsive layout and usability on desktop and mobile. Add touch movement and interaction controls if needed so the game works without a keyboard.
- Check keyboard navigation, visible focus, readable labels, reduced-motion behavior, and accessible React alternatives to canvas-only information.
- Tune gameplay speed, interaction feedback, sound levels, and UI where earlier reports identify rough or unverified behavior.
- Update `README.md` with setup, controls, screens, sound/settings, demo limitations, and run commands.

## Finish and report

- Preserve original and processed artwork and all unrelated user files.
- Run the available TypeScript check and production build; fix issues caused by this phase. Do not add an automated test suite.
- Manually walk through the main frontend flows if the browser is available. Record exactly what was checked and what could not be checked.
- Update `docs/FRONTEND_PHASE_PLAN.md` to reflect the finished frontend and any Phase 6 scope added for the remaining screens.
- Create `docs/PHASE_6_REPORT.md` listing completed screens, sound effects and triggers, audio controls, demo-only behavior, accessibility/responsive work, commands and manual checks, remaining limitations, and backend integrations intentionally deferred.
- Stop after Phase 6. Do not begin backend work.