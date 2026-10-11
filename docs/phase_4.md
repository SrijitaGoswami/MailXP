# Phase 4 — Playable Office Core Loop

Read `docs/FRONTEND_PHASE_PLAN.md`, the Phase 1–3 reports, and `public/assets/mailxp/processed/manifest.json`. Implement **Phase 4 only**.

## Goal

Turn the existing Phaser shell into a small playable office where the player can move, interact with NPCs, pick up a mail item, deliver it, and earn a local DraftCoin reward.

## Requirements

- Keep the existing pinned Next.js, React, TypeScript, and Phaser versions.
- Preserve all original and processed art files.
- Add an `OfficeScene` and connect it to the existing `Boot → Preload → Title` flow. The Title screen must provide a working way to start the office.
- Build a small office map using the normalized 32 × 32 tiles and the names/indices in the asset manifest. Define the map and collision areas in organized, typed game data.
- Add the player with four-direction movement using arrow keys and WASD. Play the correct idle/walk animation for each direction, anchor sprites at their feet, and prevent walking through walls and furniture.
- Place the office NPCs in the room. Use depth sorting so characters appear in front of or behind objects based on their foot position.
- Add a nearby-object interaction prompt and use `E` to interact. Let the player speak to NPCs and interact with the mail pickup and delivery points.
- Implement one complete local demo loop:
  1. Pick up a sample mail item.
  2. Deliver it to the indicated NPC.
  3. Mark the delivery complete and award a configurable amount of DraftCoin.
  4. Show a clear completion/reward message.
- Keep the demo quest, reward amount, and starting balance in one configuration/data module. This is local game state only; do not call APIs or imply real email delivery or wallet transactions.
- Keep gameplay logic in Phaser. Use a small typed bridge for any React-owned accessible prompts or status messages. Clean up bridge listeners on scene/game teardown.
- Show the keyboard controls and a usable alternative way to read the current objective or interact with it.

## Boundaries

- Do not implement AI-worker behavior, the mail-bird send animation, a multi-quest system, a full HUD, wallet/shop flows, or backend integrations. Those belong to later phases.
- Do not reprocess assets unless a specific Phase 3 output is broken. Document any such issue instead of silently changing it.
- Do not add unrelated dependencies or overwrite existing user files.

## Finish and report

- Run the production build and fix issues caused by this phase.
- If possible, launch the app and manually inspect the office, movement, collision, NPC interactions, pickup, delivery, and reward flow.
- Update `docs/FRONTEND_PHASE_PLAN.md` with Phase 4’s status and any remaining work.
- Create `docs/PHASE_4_REPORT.md` listing the scene/map structure, controls, interactions, local demo behavior, files changed, build and visual-check results, and blockers for Phase 5.
- Stop after Phase 4.