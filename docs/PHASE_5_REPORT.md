# Phase 5 Report — Quests, Agents, HUD, and Mail-Bird Flow

Date: 2026-10-06 · Status: **complete** (scope: `docs/phase_5.md` only — no Phase 6 polish)

The office now runs a typed four-job quest loop around the preserved Phase 4
delivery loop. Two local, deterministic "AI" workers glide out to classify and
draft each reply, the React side gained keyboard-accessible quest and
reply-review panels with an explicit, costed confirmation, and a confirmed
(simulated) send updates local state, plays a directional mail-bird flight and
wires all six screen effects. Everything is sample data in configuration
modules: **no AI provider, backend, email delivery, wallet, blockchain, or NFT
involved**, no dependencies added, and no art file touched.

---

## 1. Files added

| File | Purpose |
|---|---|
| `game/data/agentsConfig.ts` (75 lines) | Agent data module: home positions for the two workers, per-quest L-shaped waypoint routes, glide speed/bob tuning, idle lines. Pure data, no Phaser import. |
| `game/agents.ts` (148 lines) | `AiWorkerAgent` — the restrained glide treatment: moves along waypoint legs with a facing frame (front/back/left/right of the *existing* `ai-workers` atlas) plus a gentle vertical bob. **No invented walk frames.** Respects the Phase 4 collision grid/solid boxes on each leg; deliberately does **not** collide with the player (avoids a mutual-block trap), so the agent never strands itself or the player. |
| `game/effects.ts` (64 lines) | `playEffect(scene, frame, x, y, opts)` — single helper that spawns a `mail-effects` atlas frame as a scaled, depth-corrected tween (rise + fade), used by every effect below. |
| `components/QuestPanels.tsx` (195 lines) | React-owned quest list + reply-review panel (see §5). |

## 2. Files changed

| File | Change |
|---|---|
| `game/data/questConfig.ts` (201 lines) | Rewritten as the single gameplay config module: `QUESTS` (4 typed jobs), `QuestKind`/`QuestStatus`, `ECONOMY` (sendCost 5, sendReward 20, xpClassify 5, xpSend 10, xpPerLevel 100), `OBJECTIVES` per stage, `STATUSES`, dialogue (incl. `POST_DELIVERY_DIALOGUE` for free roam), and a small legacy `QUEST` object so Phase 4 call sites keep compiling. |
| `game/bridge.ts` (152 lines) | **Extended, not duplicated** — same `subscribeState`/`subscribeCommands` channels. `GameSnapshot` grew to 28 fields (mail/quest/XP/level/classification/draft/cost fields, see §7); `GameCommand` changed from a string union to an object union: `{type:"start"} \| {type:"interact"} \| {type:"confirm-send"; draft} \| {type:"cancel-review"} \| {type:"open-review"}`. |
| `game/scenes/OfficeScene.ts` (927 lines) | Rewritten around a `QuestStage` state machine (`pickup → deliver → classify → draft → review → send → allComplete`), agent lifecycle (dispatch/return per quest), mail-bird flight, extended in-canvas HUD, XP/level rules, effect wiring, and bridge publishing. Phase 4 map, props, NPCs, collision and pickup/delivery logic preserved. |
| `game/scenes/TitleScene.ts` | `"start"` command → `{ type: "start" }`; Phase 4 title copy/button unchanged. |
| `components/GameStatusPanel.tsx` (85 lines) | Sends object commands; aria-live panel now also mirrors **Mail handled / Job n·m + title / Level (xpInLevel·xp)** while in the office. |
| `app/page.tsx` | Mounts `<QuestPanels />` under the status panel; copy updated to the four-job loop. |

**Unchanged:** `package.json` (still exactly the Phase 1 pins — Next 16.3.8,
React 19.3.0, TypeScript 5.9.3, Phaser 3.90.0, Tailwind 4.3.3; `npm ls
--depth=0` shows no additions), `game/createGame.ts` (a temporary
`window.__mailxp` debug probe was added for playtesting and **removed** before
final verification, so the file is back to its Phase 4 content), both scripts,
all 8 original PNGs (mtimes still 13:05–13:44) and every `processed/` output
(newest write 17:05 — before the Phase 4 report at 19:39 and the Phase 5 spec
at 19:59, i.e. nothing under `public/assets/mailxp/` was written this phase).

## 3. Quest list, states, and economy

One job is active at a time; completing one auto-starts the next (decision
recorded in the plan). Statuses are `locked | active | completed`.

| # | id | kind | Title | Reward | Mail | Classification / sample |
|---|---|---|---|---|---|---|
| 1 | `deliver-letter` | delivery | Deliver today's letter | +25 | 1 | the Phase 4 physical loop (unchanged) |
| 2 | `reply-invoice` | reply | Reply: invoice dispute | +20 | 1 | "Billing question" |
| 3 | `reply-demo` | reply | Reply: reschedule the demo | +20 | 1 | "Scheduling request" |
| 4 | `reply-export` | reply | Reply: broken CSV export | +20 | 1 | "Bug report" |

Economy (all in `ECONOMY`): send cost **5**, send reward **20** (reply quests
net **+15**), XP `+5` classify / `+10` send / `+15` quest complete, a level
every **100 XP** (starting balance 0, starting level 1). A full four-job run
therefore lands on exactly **70 DraftCoin · 4 mail · 105 XP · Level 2** — the
number reproduced on both the dev and the production build (§12).

Stages and their objective strings are keyed off `OBJECTIVES`, so the canvas
HUD and the React mirror always read the same text.

## 4. Agent behavior (Understanding Worker, Response Worker)

- **Dispatch:** entering `classify` sends the Understanding Worker from home
  (150, 400) along an L-shaped route to the quest's reader spot, e.g.
  (380, 500) for job 2; entering `draft` sends the Response Worker from
  (1130, 400) to its drafting spot, e.g. (760, 400). Long legs run along the
  open carpet row (y = 400) so routes stay inside walkable space; each leg is
  validated against the Phase 4 collision data.
- **Movement treatment:** a glide (position tween along waypoints) with a
  facing frame selected from the four frames the atlas actually has, plus a
  slow bob. No walking frames were invented, per the spec.
- **Return home** after each step, so the office composition stays tidy.
- **Deterministic local results:** the classification and reply body come from
  the quest config (no model, no network). Sparkle plays at the reader's
  position when the classification lands (XP +5).
- **Idle lines** exist for talking to an idle worker; agents neither block the
  player nor are blocked by it (deliberate decision — a mutual-block trap
  would be possible with static obstacle boxes and moving agents).

## 5. Reply review panel and simulated send

`components/QuestPanels.tsx` renders two sections below the canvas, both with
native, keyboard-operable controls:

- **Quest list** — always visible; every job with its status badge (DONE /
  IN PROGRESS / LOCKED), the active job's classification once known, and an
  **Open reply review** button that is only shown when `canOpenReview` is true
  (finished draft, review closed, not sending, not all-complete).
- **Reply review** — auto-opens when the draft is ready (also reopenable in
  game with `E` at the Response Worker, or from the button). Editable
  **To**, **Subject** and **Reply** fields (local React state; the game only
  receives the final draft on confirm), then the cost line **before**
  confirmation: *"Send cost: 5 DraftCoin · Reward: 20 DraftCoin · Balance: …"*.

Confirmation is explicit: a `Confirm send (−5 DraftCoin)` button plus a
`Discard` button. The confirm button is **disabled** when `canSend` is false,
with the visible reason *"Not enough DraftCoin — you need 5, you have 0.
Deliver more mail to earn some."* The scene re-checks the balance before
charging, so a stale click cannot overspend. Confirming costs 5, starts the
bird, and on landing pays the reward, XP, mail count and the next quest. The
status line states plainly: *"Simulated send confirmed — no API call, no real
email, no wallet transaction."* No `fetch`/SMTP/wallet code exists anywhere in
this phase.

## 6. Mail-bird flight

On confirm, the bird spawns at the player, chooses `left`/`right` from the
player's screen-half (world x vs. camera center + half width), plays the
matching `bird-left`/`bird-right` animation on **loop** (flap never freezes),
and tweens past the screen edge (target `cam.scrollX ∓ 140`, duration scaled
from distance at 320 px/s) before being destroyed. On arrival the reward chain
runs (§3). Frames sampled during a real flight: `right-0 → right-1 → right-2 →
right-3`, anim key `bird-right`, x 251 → 328; a leftward flight was also
captured in a screenshot mid-screen.

## 7. HUD and typed bridge changes

In-canvas HUD (all values from config, depth-sorted above the map): top-left
`Job n/4: <title>` + current objective; top-right `DraftCoin: n · Mail: n` and
`Lv n · x/100 XP`; transient banner for completions and level-ups.

`GameSnapshot` additions (same channel, no second event system):
`mailCount, xp, level, xpPerLevel, xpInLevel, questIndex, questCount,
activeQuestTitle, quests[], classification, draft, reviewOpen, canOpenReview,
sendCost, sendReward, canSend, sending, allComplete, stage`.

React mirrors: `GameStatusPanel` extends its `aria-live="polite"` region with
the mail/job/level line; `QuestPanels` is a labelled section list
(`aria-label="Quest list"` / `"Reply review"`, `aria-current="step"` on the
active job, `role="status"` on the send/insufficient messages).

## 8. Effects wiring

| Effect frame | Trigger |
|---|---|
| `interaction-ring` | every `E` interaction (target's feet) |
| `pickup-burst` | mailbox pickup |
| `coin-burst` | Officer delivery (+25) |
| `quest-burst` | quest completion (agent/generic reward position) |
| `sparkle` | Understanding Worker's classification lands |
| `levelup-burst` | level-up (`addXp` crossing a 100 XP boundary) |

All six were observed **alive in the scene** during a single full run by a
page-side 40 ms watcher sampling `mail-effects` children: `pickup-burst,
interaction-ring, coin-burst, quest-burst, sparkle, levelup-burst` (§12 lists
which also made it into pixels).

## 9. Configuration/data modules

All sample values live in data modules, not scene code: `questConfig.ts`
(quests, statuses, objectives, economy, dialogue), `agentsConfig.ts` (homes,
routes, tuning), `officeMap.ts` (unchanged Phase 4 map/collision),
`bridge.ts` (typed snapshot/command shapes).

## 10. Checks & verification results

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean (also run again after the final cleanup). |
| `next build` (Next.js 16.3.8, Turbopack) | ✅ compiled, TypeScript clean, static pages `/`, `/_not-found`, `/preview`. |
| `node scripts/verify-atlas-parse.js` | ✅ PASS × 5 (props, effects, NPCs, ai-workers, mail-bird). |
| `scripts/validate-assets.ps1` | ✅ PASSED — 0 errors, 1 warning (the pre-existing couch/plant split boundary note from Phase 3, unrelated to this phase). |
| Production serve (`npx next start -p 3001`) | ✅ `GET /` **200** (9,218 B) and `GET /preview` **200** (7,609 B); `aria-live` present in the served HTML. |
| Console during production playthrough | ✅ 0 errors, 0 warnings. |
| Dependencies | ✅ `package.json` untouched — no new packages (no lint script/config exists in the project, unchanged since Phase 1). |
| Art integrity | ✅ no writes under `public/assets/mailxp/` this phase (originals keep 13:05–13:44 mtimes; `processed/` newest 17:05, all predating Phase 5 work). |
| Playtest runs | ✅ 3 full four-job runs on the dev server + 1 full automated run on the production build, each ending `all complete` with the exact expected totals (70 / 4 / 105 / Level 2). |

## 11. Issues found & fixed during this phase

1. **String commands left behind by the bridge rewrite** — `TitleScene` still
   matched `command === "start"` and `GameStatusPanel` still *sent* the old
   string commands after `GameCommand` became an object union. Fixed before
   the first type-check (the union now enforces this at compile time).
2. **Stale "Open reply review" button after completion** — the button was
   gated only on `draft && !reviewOpen`, so it lingered with job 4's draft once
   every job was done. Now gated on the scene-computed `canOpenReview`
   (verified: hidden on the completed run).
3. **Redundant cost label** in the review panel (a ternary that printed the
   same word twice) — simplified to a plain cost/reward/balance line.
4. **Dead/temporary code removed before final verification** — an unused
   private `agentBox()` helper and the temporary `window.__mailxp` debug probe
   used by the scripted playtests.
5. **Interaction radius miss during scripted testing** (not a product bug): at
   one landing spot the player stood 70 px from the Officer (radius 64) and got
   *"Nothing to interact with here."* — a variance artifact of synthetic,
   wall-clock-timed key events; nudging into range worked. Legitimate NPC
   dialog, not a defect.

## 12. Visual-inspection result

**Live in-browser inspection was performed** (the desktop browser was
connected this phase; the game window had to stay visible — Phaser pauses and
captures fail while the tab is hidden).

Inspected on the **dev server** (`next dev -p 3001`), with screenshots and
DOM reads:

- Boot → Title → Office; office renders with props/NPCs/camera; HUD shows
  `Job 1/4`, objective, `DraftCoin`, mail, level/XP.
- **Preserved Phase 4 loop re-verified end to end:** walk route → mailbox
  blocked by collision → `E` pickup (stage `deliver`, carrying) → Officer
  delivery (blocked by desk, `E` at 45 px) → banner *"Delivery complete! +25
  DraftCoin"* caught mid-fade in a screenshot, DraftCoin 25, mail 1, XP 15.
- **Quest list panel** statuses: job 1 DONE, job 2 IN PROGRESS *"classified
  as: Billing question"*, jobs 3–4 LOCKED — matching scene state.
- **Both workers gliding** (positions sampled as they left home, reached their
  targets and returned home; they appear in screenshots at their waypoints).
- **Review panel screenshot** showing editable To/Subject/Reply plus
  *"Send cost: 5 DraftCoin · Reward: 20 DraftCoin · Balance: 40 DraftCoin"*,
  `Confirm send (−5 DraftCoin)` and `Discard`.
- **Field editing** through the real React inputs, then confirm: balance
  25 → 20 (cost charged), XP +10, *"Simulated send confirmed — the mail-bird
  is carrying your reply out of the office."*
- **Bird flight:** mid-flight screenshot flying toward the left screen edge
  with the player on the right half; frame/anim samples for the right
  direction (`right-0…3`, `bird-right`, x increasing) when the player stood on
  the left half.
- **Insufficient balance:** reached with a test-only runtime mutation
  (`draftCoin = 0`) → confirm **disabled**, message *"Not enough DraftCoin —
  you need 5, you have 0."*, cost line `Balance: 0` — screenshot.
- **Keyboard activation:** focused the confirm button and pressed `Enter` →
  send started (native button semantics).
- **Effects:** all six frames observed alive via a 40 ms page-side watcher
  during one full run; `pickup-burst` + `interaction-ring` also seen in a
  screenshot; the completion banner and the level-up *status text* were seen
  on screen.
- **Full completion ×2:** `all complete`, DraftCoin 70, mail 4, XP 105,
  Level 2, all four jobs DONE; free roam afterwards — Intern's
  `POST_DELIVERY_DIALOGUE` line shown and movement still works.

Inspected on the **production build** (`next start -p 3001`): boot, start,
pickup, delivery (+25), classify → draft → review, confirm send
(25 → 20, +10 XP → quest 3 with DraftCoin 40, XP 45), then an automated run to
`Job: all complete · Level: 2 (5/100 XP, 105 total)` with all four jobs DONE
and **0 console errors/warnings**.

**Not inspected / caveats (recorded honestly):**

- **Screenshot lag:** late in the session the capture pipeline returned frames
  up to ~2 states behind the DOM; DOM reads were treated as authoritative and
  captures were re-taken until they matched. Some individual screenshots
  attached to a test call therefore show the *previous* state.
- **Effect pixels:** `sparkle`, `coin-burst`, `quest-burst` and
  `levelup-burst` were verified by live frame-name sampling (and by the status
  text that accompanies them) rather than by a captured frame — their tweens
  are 520–720 ms and expired before the delayed captures. `pickup-burst` and
  `interaction-ring` did appear in screenshots.
- **Bird left-frames:** the leftward flight was seen visually, but only the
  right-frames' names/anim keys were sampled programmatically.
- **Screen readers:** no AT (NVDA/VoiceOver) run — only DOM structure,
  `aria-live` and native focus/activation behavior were checked.
- **Input during playtests** was driven by a page-load test helper (synthetic
  `KeyboardEvent`s with `keyCode` getters) plus two test-only runtime
  mutations noted above; product code was not modified for testing, and the
  debug probe was removed before the final build.

## 13. Remaining work / blockers for Phase 6

**No Phase 5 blockers.** Phase 6 (audio, tuning, README/tests, final polish)
remains: audio, difficulty/UI tuning, a final production-build pass, README
update, and — as noted in the plan — deciding whether any automated test
coverage is wanted (the phase spec forbade adding a test suite now).
