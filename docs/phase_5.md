# Phase 5 — Quests, Agents, HUD, and Mail-Bird Flow

Read `docs/FRONTEND_PHASE_PLAN.md` and the Phase 1–4 reports first. Implement **Phase 5 only**.

## Before expanding

Run the existing app and check the Phase 4 office loop if a browser is available: movement, collision, mailbox pickup, Officer delivery, and reward. Fix any blocking defect that prevents the core loop from working. Record if visual inspection is unavailable; do not claim it passed.

## Goal

Add the local, frontend-only quest and agent systems around the existing playable office. Keep the Phase 4 delivery loop working.

## Requirements

- Keep the existing pinned dependencies and preserve all original and processed art.
- Replace the single hard-coded quest stage with a typed, configurable quest list and clear statuses. Use sample data only.
- Add the Understanding Worker and Response Worker to the office:
  - The Understanding Worker moves to an available quest and returns a deterministic local classification.
  - The Response Worker follows the active quest and prepares a deterministic sample reply.
  - Use the existing collision/map data for movement. Do not claim the agents use real AI or add network calls.
- Add React-owned, keyboard-accessible quest and reply-review panels. Let the player edit the recipient, subject, and reply before approval.
- Show the configured DraftCoin send cost before confirmation. Require explicit confirmation. The simulated send must not call an API, send real email, or trigger a wallet transaction.
- On confirmed simulated success, update local quest and DraftCoin state and play the mail-bird flight and appropriate completion effects. The bird should fly toward the screen edge with the correct directional frames and a looping flap animation.
- Add the planned HUD for mail count, current quest/status, DraftCoin, and XP/level. Keep an accessible React status mirror and extend the existing typed bridge rather than creating a second event system.
- Wire the interaction sparkle/ring and quest, pickup, coin, and level-up effects where they meaningfully communicate game state.
- Keep all sample quests, fees, rewards, statuses, and mock reply rules in clearly organized configuration/data modules.
- Respect the available sprite frames: do not invent walking animation frames for AI workers. Use a restrained movement treatment based on their actual assets.

## Boundaries

- No real AI provider, backend, email delivery, wallet, blockchain, or NFT integration.
- Do not remove or break the existing office map, NPC interactions, or Phase 4 physical mail loop.
- Do not add unrelated dependencies or rewrite completed phases.

## Finish and report

- Run the existing asset validation and Phaser atlas verification scripts, TypeScript check, and production build. Fix issues caused by this phase; do not add a new test suite.
- If possible, visually inspect agent movement, quest/reply flow, confirmation, bird flight, HUD, and the preserved Phase 4 loop. Record what was and was not inspected.
- Update `docs/FRONTEND_PHASE_PLAN.md` with Phase 5’s status and remaining Phase 6 work.
- Create `docs/PHASE_5_REPORT.md` with files changed, quest states, agent behavior, bridge/HUD changes, simulated-send behavior, checks and visual-inspection results, and remaining blockers.
- Stop after Phase 5.