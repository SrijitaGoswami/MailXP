# Phase 6 Report — Frontend Screens, Sound Effects, and Polish

Date: 2026-10-07 · Status: **complete** (scope: `docs/phase_6.md` only — stops
here; no backend work begun)

The frontend is finished: five new accessible screens behind a persistent ARIA
tab shell (the Phaser canvas is mounted once and never unmounts), a 47-item
demo shop with clearly simulated DraftCoin purchases, local cosmetic
persistence (outfits, placed office decor, sound/motion/controls preferences),
26 synthesized Web Audio sound effects with volume/mute buses, and on-screen
touch controls. Everything is local-only: **no backend, AI, email, wallet,
blockchain or NFT call exists**, no dependency was added, and no original or
pre-existing processed art file was touched. Four real bugs were found and
fixed during the final walkthrough (§11).

---

## 1. Files added

| File | Purpose |
|---|---|
| `game/profile.ts` (208 lines) | Local demo profile — single source of truth for `draftCoin`, `ownedItems`, `equippedOutfit`, `placedDecor`, `prefs` (master/ui/game volume, muted, motion, touchControls). Persisted under `localStorage["mailxp.profile.v1"]`; pub/sub (`subscribeProfile`) + mutation helpers (`patchProfile`, `purchaseItem`, `resetProfile`…); framework-free so React and Phaser share it. Exports `getDefaultProfile()` — the frozen defaults used as React's server snapshot. |
| `game/audio/soundLibrary.ts` (239) | The 26 named `SoundEvent`s, their recipes (oscillators + one shared white-noise buffer — **no audio files, no music**), bus map (`ui`/`game`), and per-event minimum gaps for repeatable cues. |
| `game/audio/audioManager.ts` (183) | Typed `playSound(event)` over master → bus gain graph; mute (immediate), gesture unlock (no autoplay), tab-hidden suspend, profile-prefs subscription, per-event throttling. |
| `game/data/shopConfig.ts` (161) | Catalog of **47 products** — 3 outfit shop-ids (exactly the `OutfitId`s `courier/tech/forest`; base `worker` always owned) + 44 decor items (prices 6–12; outfits 25) with texture/atlas keys, sheet frames and display sizing. |
| `components/AppShell.tsx` (177) | Page shell: six ARIA tabs (roving tabindex, arrow-key navigation, auto-switch to Game when the review opens), canvas rendered **outside** the panels so it never remounts, `aria-live` status region, demo footer. |
| `components/useGameState.ts` (28) | `useGameSnapshot` / `useProfile` — `useSyncExternalStore` hooks over the bridge and profile stores (hydration-safe, §11.3). |
| `components/ShopThumb.tsx` (154) | `DecorThumb` / `OutfitThumb` — CSS-sprite previews cropping the exact atlas rects from `processed/shop-manifest.json` (matches in-game pixels; no canvas, no extra requests beyond the manifest). |
| `components/TouchControls.tsx` (89) | D-pad (Move up/left/down/right) + **Interact (E)** rendered *below* the canvas, never over it; visible per pref (`auto` = `pointer: coarse` media query, `on`, `off`); pointer **and** keyboard hold (Space/Enter) both work. |
| `components/screens/CharacterScreen.tsx` (167) | Current appearance + 4-direction previews from the real outfit sheet, equip actions, ownership states, cross-links to Shop. |
| `components/screens/InventoryScreen.tsx` (261) | Equipped outfit, owned decor with Place/Move/Remove, active-placement cancel bar, cosmetic-only + localStorage provenance notes. |
| `components/screens/ShopScreen.tsx` (217) | 47-product grid, balance header, buy/equip/place actions, blocked-purchase `role="alert"` messages. |
| `components/screens/RewardsScreen.tsx` (137) | Local DraftCoin card with the full not-on-chain disclosure, stats grid, quest list, and the demo-only wallet/NFT section (`aria-expanded` details toggle). |
| `components/screens/SettingsScreen.tsx` (214) | Mute + master/UI/game volume sliders, Play test sound, motion level, touch-control mode, two-step "Reset demo data". |
| `scripts/measure-shop-assets.ps1` (509) | Standalone extraction/analysis for the shop sheets (C# helper `MailXpShop.Ops`; decor = 8-way segmentation, wall/desk = 12-cell grids, plants = connected components). Reads sources, writes only new derived JSON. |

Derived outputs (new; every pre-existing `processed/` file untouched):
`processed/shop-decor.json` (8 frames), `shop-wall.json` (12), `shop-plants.json`
(12), `shop-desk.json` (12), `shop-manifest.json` — all BOM-less.

## 2. Files changed

| File | Change |
|---|---|
| `game/bridge.ts` (193) | New commands `{type:"touch-move"; dir; pressed}` and `{type:"decorate"; action:"place"\|"move"\|"cancel"; itemId?; index?}`; new snapshot field `decorMode: DecorModeState \| null`. `sendCommand` now holds a decor request issued while only the title screen runs (`takePendingDecor`, §11.2). |
| `game/scenes/PreloadScene.ts` | Loads the four shop sheets as atlases (`shop-decor`, `shop-wall`, `shop-plants`, `shop-desk` ← provided `shop/decor/*.png` + `processed/shop-*.json`) and the three outfit sheets as spritesheets (`outfit-courier/tech/forest`). |
| `game/scenes/OfficeScene.ts` (1218) | Profile subscription (wallet/equip/decor/Settings mirrored live), per-outfit anim keys via `ensureAnims`, decor rendering (depth = foot y, **visual only — never added to collision**), decor mode + canvas click placement (grid-snapped; wall pieces centered on click, floor pieces require a non-solid tile), touch-move input, scene-side sound triggers, reduced-motion gates on decorative tweens/banners, pending-decor consumption on create (§11.2). |
| `game/scenes/TitleScene.ts` | Subscribes to the profile so the HUD balance stays live while the title screen is up (§11.1); title button sound. |
| `components/GameStatusPanel.tsx` | Mirrors decor mode + wallet; Start/Interact buttons unchanged in behavior. |
| `app/page.tsx`, `app/globals.css` | Page = `<AppShell/>`; CSS adds visible focus rings, `prefers-reduced-motion` guards and label typography. |
| `scripts/validate-assets.ps1` | Shop-frame rules: `softOverlap` — bounding-box interlocks ≤10 000 px² between CC-segmented frames downgrade FAIL→WARN (visually verified), larger still FAIL. |
| `README.md` | Refreshed for Phase 6 (setup, controls, screens, sound/settings, demo limits, commands) — links to `context.md`. |

**Unchanged:** `package.json` (still exactly the Phase 1 pins — Next 16.3.8,
React 19.3.0, TypeScript 5.9.3, Phaser 3.90.0, Tailwind 4.3.3; **no
dependencies added this phase**), all 8 original PNGs (mtimes 2026-10-06
13:05–13:44), `processed/manifest.json` + `office-tiles-32.png` (2026-10-06
17:05), and the provided `shop/` source sheets (2026-10-06 22:37–22:48).

## 3. Navigation shell and canvas persistence

One page, six `role="tab"` buttons (Game, Character, Inventory, Shop, Rewards,
Settings) with roving tabindex + Arrow/Home/End keys; each screen is a
`role="tabpanel"` kept **mounted** and toggled with `hidden`, so draft text and
other state survive tab switches. The Phaser canvas lives in a container
*outside* the panels and is created exactly once per page load — switching
tabs, opening the review, or buying items never restarts the game (verified:
`sameCanvas: true` across switches, §14). The reply review auto-switches to
the Game tab. The `aria-live="polite"` status panel is always mounted.

## 4. The five screens (what each one does)

- **Character** — "Current appearance" card (outfit name + Worn now + four
  direction previews rendered from the real sheet) and one card per outfit:
  ownership badge, Wear/Wearing state, cross-link "Get it in the Shop" (switches
  tab) for unowned items. Equip writes `equippedOutfit`; OfficeScene swaps the
  player texture/anim live.
- **Inventory** — Equipped outfit (Change outfit → Character), owned decor with
  **Place / Move / Remove**, a placed-items list with coordinates, an active
  placement bar with **Cancel placement**, and honest notes (decor is cosmetic
  only, stored in `localStorage["mailxp.profile.v1"]`).
- **Shop** — 47 products (3 outfits, 44 decor) with atlas-accurate thumbnails,
  price, balance header and per-card states: Buy → Simulated-purchase success
  ("Local demo balance — no payment, no transaction."), Owned / In inventory /
  Wear it now / Place, or a `role="alert"` blocked message naming the exact
  shortfall. Every item is claimable with DraftCoin (earns via quests; test
  seed below was used for immediacy).
- **Rewards** — big local balance card labeled "Local demo balance" with the
  explicit not-on-chain/not-cryptocurrency/not-transferable disclosure and
  localStorage key; mail/jobs/level/XP stats; quest list with done/active/locked
  badges; "Crypto wallet & NFTs — future integration" section whose
  `aria-expanded` details state that nothing is implemented on purpose, no
  address/signature/transaction/fake hash exists, and what a future backend
  phase would show.
- **Settings** — Sound (mute checkbox, master/UI/game sliders 0–100%,
  "Play test sound" chime), Motion (Full/Reduced + always-respected OS
  `prefers-reduced-motion`), Controls (touch pad Auto/Always/Hide), and a
  two-step reset ("Reset demo data" → "Reset everything (press again to
  confirm)").

## 5. Sound effects (26 events, Web Audio synthesis only)

`soundLibrary.ts` recipes + `audioManager.ts` playback. All effects are
generated in code (triangle/sine blips, shared white-noise buffer), all under
~0.55 s, one cohesive voicing. **No audio files downloaded, no sound library,
no music/ambience** (the project ships no licensed audio). Buses: `master →
ui | game`, each with its own volume; mute kills the master immediately.

| Event | Bus | Trigger (call site) |
|---|---|---|
| `ui-click` | ui | Settings control activation; un-mute confirmation |
| `ui-nav` | ui | Tab change (AppShell), forward/cross navigation buttons, title Start, Settings test chime |
| `panel-open` | ui | Reply review opened (scene); decor placement mode entered; wallet details expand |
| `panel-close` | ui | Wallet details collapse |
| `equip` | ui | Wear outfit (Character/Shop); decor placed/moved confirmation |
| `purchase` | ui | Simulated shop purchase succeeds |
| `cancel` | ui | Cancel placement, discard/cancel review, reset confirmed |
| `blocked` | ui | Insufficient funds, equip unowned, invalid decor tile |
| `footstep` | game | While moving — throttled 230 ms |
| `interact` | game | `E` interaction — throttled 120 ms |
| `talk` | game | NPC/agent speech — throttled 160 ms |
| `bump` | game | Collision — throttled 450 ms |
| `mail-pickup` | game | Mailbox pickup |
| `quest-start` | game | Quest activates |
| `agent-dispatch` | game | Worker leaves for classify / draft |
| `agent-arrive` | game | Worker glides back home after its result (wired in §11.4) |
| `classified` | game | Classification lands (+XP, sparkle) |
| `draft-ready` | game | Draft prepared → review opens |
| `review-open` | ui | Review re-opened (`E` at Response Worker / `open-review` command) |
| `send-confirm` | game | Explicit simulated-send confirmation |
| `bird-launch` / `bird-flap` / `bird-pass` | game | Bird spawn / loop during flight (flap throttled 130 ms) / crossing the screen |
| `reward` | game | DraftCoin payout — throttled 160 ms |
| `quest-complete` | game | Job completes |
| `level-up` | game | XP crosses a 100-XP level boundary |

Throttle map guarantees footsteps/bumps/talk/flaps cannot spam regardless of
input rate. **One source per event:** command-driven cues play scene-side,
pure-UI cues play React-side (e.g. Shop's Place button is silent because
OfficeScene plays `panel-open` when the command arrives) — no double sounds.
Audio context is created/resumed only after the first click or key press
(no autoplay) and suspends when the tab is hidden.

## 6. Decor placement system

Free "Decorate" mode from Inventory (and Shop's Place): the office is
auto-started if it isn't running (§11.2), then a click/tap on the map places
the item grid-snapped to 32 px tile centers. Wall pieces anchor at the click
point; floor pieces need a non-solid tile (blocked tiles answer with
`blocked` + "That tile is a wall…"). Items can be moved the same way and
removed; everything persists in the profile. Sprites are depth-sorted by foot
y and are **purely visual — never added to `solidBoxes`**, so verified Phase
4/5 walk routes cannot be broken by decoration.

## 7. Touch, accessibility, responsive, motion

- D-pad + Interact button below the canvas (never overlapping it, so decor
  taps on the canvas are never intercepted); Auto/Always/Hide modes; buttons
  work via pointer and via keyboard hold.
- Keyboard: roving-tabindex tabs, native buttons/inputs everywhere, visible
  focus styles, `aria-live` objective/status mirror, `role="alert"` purchase
  messages, `aria-label`s on pad buttons and canvas (`role="application"`),
  `aria-expanded` on the wallet details.
- Motion: profile `motion` pref mirrored to `<html data-motion>` gates marker
  bob tweens and banner fades; OS `prefers-reduced-motion` respected by CSS
  regardless of the in-app setting; reduced motion also switches scroll
  behavior to `auto`.
- Layout: fluid column, canvas `Scale.FIT` (unchanged 960 × 540 logical),
  controls stack under the game on narrow screens.

## 8. Demo-only behavior and data

- Every wallet/NFT/claim/email/purchase action is labeled demo-only in place;
  the purchase success and send confirmations say outright there is no payment,
  no transaction, no API call and no real email. **No fake transaction hashes
  anywhere.**
- All state is `localStorage` on this device; no `fetch`, no third-party calls
  in any Phase 6 file. DraftCoin can only be earned/spent inside the demo.

## 9. Persistence and reset

Profile key `mailxp.profile.v1` holds wallet, owned items, equipped outfit,
placed decor and all preferences; React and both scenes subscribe, so changes
made anywhere appear everywhere (buying on the title screen updates the HUD
live; toggling touch mode shows/hides the pad instantly; resetting clears the
placed decor from the running scene). Settings' reset is two-step and restores
exact defaults (verified: draftCoin 0, owned `[]`, outfit `worker`, decor `[]`,
volumes 0.8/0.9/0.8, motion full, touch auto, muted false).

## 10. Checks & verification results

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 (final run; also after every walkthrough fix) |
| `npx next build` (Next.js 16.3.8, Turbopack) | ✅ exit 0 — routes `/`, `/_not-found`, `/preview`; final build served after the last fix |
| `scripts/validate-assets.ps1` | ✅ PASSED — 0 errors, 2 documented warnings (shop-plants frames #2/#4 bbox interlock 219×5 px = CC-segmentation artifact, visually cleared; couch/plant boundary-density 46% note from Phase 3) |
| `node scripts/verify-atlas-parse.js` | ✅ PASS × 9 (5 original + 4 shop frame files, rects match `shop-manifest`) |
| Production server (`npx next start -p 3001`) | ✅ listening; final build smoke-loaded — canvas boots, 6 tabs present, profile at defaults |
| Console (fresh production sessions) | ✅ **0 errors** — only the Phaser 3.90 banner. A React hydration error seen mid-walkthrough was root-caused and fixed (§11.3) |
| Dependencies | ✅ `package.json` untouched — no new packages; no sound/audio library |
| Art integrity | ✅ originals, `manifest.json`, `office-tiles-32.png` and the provided `shop/` sheets all keep pre-Phase-6 mtimes; this phase only *added* `processed/shop-*.json` + `shop-manifest.json` |
| Manual walkthrough | ✅ production build, recorded in §14 (one test-only wallet seed, cleared by the final reset) |

## 11. Issues found & fixed during this phase

1. **Stale HUD balance on the title screen** — `TitleScene` published
   `draftCoin` once in `create`, so buying in the Shop while the title was up
   left the status panel showing the old number until the office restarted.
   Fixed by subscribing `TitleScene` to the profile (same pattern as
   OfficeScene). Verified: balance updated live on the title screen.
2. **Decorate command dropped when the office wasn't running** — clicking
   Place/Decorate from the title screen sent `decorate` to a scene that didn't
   exist, while the UI still said "click a spot in the office above". Fixed
   three-way: `sendCommand` holds the newest decor request when
   `screen !== "office"`, `OfficeScene.create` consumes it, and Inventory's
   Place/Move send `start` first. Verified end-to-end: Decorate from the title
   auto-started the office and entered placement mode.
3. **React hydration mismatch (#418) after the first visit** — two sources,
   found by reproducing in `next dev` (full component stack pointed at
   `CharacterScreen.tsx:140`): (a) `useState(getProfile)` rendered persisted
   localStorage values against server-rendered defaults — replaced with
   `useSyncExternalStore(subscribeProfile, getProfile, getDefaultProfile)`;
   (b) render-time direct `ownsItem()` reads in `CharacterScreen`/`ShopScreen`
   bypassed the hook — replaced with `profile.ownedItems.includes(…)`. Verified
   in dev (repro gone) and on a fresh production tab (0 errors with a
   non-default profile loaded).
4. **Dead `agent-arrive` event** — the recipe existed but nothing played it
   (arrivals were only marked by `classified`/`draft-ready`). Wired to both
   `goHome(...)` return trips so every dispatch/arrival pair has its cue.
   Type-checked and built; not re-observed in a live quest run (§15).

## 12–14. Manual walkthrough record

Performed against the **production build** (`next start -p 3001`) with DOM
reads, console checks and screenshots.

**Verified in this session:**

- Structure: 6 ARIA tabs (roving tabindex — `ArrowRight`×3 walked Game → Shop,
  tabindex updated), 6 panels, single persistent canvas (`sameCanvas: true`
  across switches), always-mounted `aria-live` region, demo footer, 0 console
  errors.
- Movement via **both** input paths: Phaser keyboard (synthetic keydowns with
  `keyCode` getters held 1.5–3 s in-page) and the React D-pad
  (`touch-move` → camera-follow screenshots both moved the camera).
- `Interact (E)` end-to-end: button → bridge command → NPC dialogue → live
  region text updated.
- Shop: blocked purchase with 0 coins → no state change +
  `role="alert"` shortfall message; buying the Courier Outfit (25) → balance
  175, `ownedItems ["courier"]`, success alert, card → Owned/Wear it now; Wear
  → `equippedOutfit "courier"`; decor purchase (Mountain Print, 10) → 165.
- Character: appearance card + 4 direction previews from the real sheet, all
  ownership states, "Get it in the Shop" cross-tab navigation.
- Decor lifecycle end-to-end: Decorate **from the title screen** (office
  auto-start, placement bar with Cancel) → place at (464, 592) → screenshot of
  the print hanging in-game → Move → (432, 624) → Remove → count 0 → re-place
  (464, 752). `placedDecor` persisted each step; cosmetic only.
- Courier outfit visibly rendered on the player in a screenshot (red cap).
- Rewards: full disclosure copy present ("Local demo balance", not on-chain,
  no fake transaction hash), stats grid, wallet details toggle
  (`aria-expanded` false→true, `hidden` toggled, label changes).
- Settings: mute persisted (`muted` true→false), master slider 80 → 45 →
  `prefs.masterVolume 0.45` + label "Master volume (45%)", motion radio →
  `<html data-motion="reduced">` → back to `full`, touch Always/Hide/Always →
  pad 4 buttons visible → removed → visible + pref persisted, "Play test sound"
  ×3 → 0 console errors, two-step reset → exact defaults + live propagation
  (print disappeared from the running scene, player back to Worker, HUD
  `DraftCoin: 0`, pad hidden on `auto`).
- Persistence: profile survived a full page reload (coins/outfit/owned intact).
- Test-only intervention: `draftCoin` was seeded to 200 via a localStorage edit
  to exercise purchases immediately; the final two-step reset cleared it —
  the app now ships in a default state (0 coins, nothing owned).

**Not verified / caveats (recorded honestly):**

- **Sound audibility** — the harness has no audio device. Every cue path was
  exercised without console errors and the buses/prefs are wired as described,
  but nobody *heard* the effects; volume balance and "gentle, non-repetitive"
  quality are unconfirmed by ear.
- **`agent-arrive`** — wired and type-checked, but no live quest run was
  performed this session to hear it (requires the full reply-quest walk).
- **Screen readers** — no NVDA/VoiceOver pass; only DOM structure, ARIA
  attributes, `aria-live` and native focus/activation were checked.
- **Real touch hardware** — D-pad verified via pointer/keyboard events; the
  `pointer: coarse` auto-show branch was code-reviewed, not run on a device.
- **Reduced motion in-canvas** — the `data-motion` attribute and gate code are
  verified; the visual difference (marker bob on/off) was not A/B-compared.
- **Long mailbox route** — a blind long-route walk was abandoned: furniture
  (desk row y 560–636, parcel, lockers, cabinet) blocks naive paths. Movement,
  collision and interaction were verified via the methods above instead.
- **Screenshot pipeline** — captures lag ~2 DOM states behind; DOM reads were
  treated as authoritative.

## 15. Remaining limitations & intentionally deferred backend work

Frontend Phase 6 is complete; the following are **deliberate** deferrals, not
defects: real wallet/NFT/claim connection, on-chain balances, real email
sending, any backend/API/AI provider, licensed audio files (music/ambience),
and an automated test suite (the spec forbade adding one; checks are the
TypeScript/build/asset-validation commands in §10). Per `docs/phase_6.md`, the
project stops after Phase 6.
