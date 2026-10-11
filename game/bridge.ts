/**
 * Tiny typed bridge between the React-owned accessible UI and the Phaser game
 * (Phase 4 requirement: "Use a small typed bridge for any React-owned accessible
 * prompts or status messages. Clean up bridge listeners on scene/game teardown."
 * Phase 5 requirement: "extend the existing typed bridge rather than creating a
 * second event system").
 *
 * Two channels, both framework-free so React can import this module without
 * pulling Phaser into the bundle:
 *
 * - State:  OfficeScene publishes snapshots; React renders them in the
 *           screen-reader announcer (GameAnnouncer), the in-game HUD and the
 *           menu panels (QuestPanels / screens).
 * - Commands: React sends user gestures (Play/Interact, confirming a
 *           simulated send, opening/closing the reply review, pausing while a
 *           menu is open); scenes subscribe and MUST unsubscribe on
 *           shutdown/destroy.
 *
 * Every subscribe* call returns an unsubscribe function that is safe to call
 * more than once. Dispatching to zero listeners is a no-op (commands sent
 * before the scene mounts are simply dropped, never queued or thrown).
 */

import type { QuestStatus, QuestStage } from "./data/questConfig";

export type GameScreen = "title" | "office";

/** Editable reply fields — React edits a local copy, the game gets it on confirm. */
export interface ReplyDraft {
  recipient: string;
  subject: string;
  body: string;
}

/** One quest as mirrored into React (id/title/status only). */
export interface QuestSummary {
  id: string;
  title: string;
  status: QuestStatus;
}

/** Direction of the on-screen touch D-pad. */
export type TouchDir = "up" | "down" | "left" | "right";

/** Decorate-mode state published while the player is placing/moving an item. */
export interface DecorModeState {
  mode: "place" | "move";
  /** Shop item id being placed (always known — move keeps it from the slot). */
  itemId: string;
  /** Index into `profile.placedDecor` for move mode. */
  index?: number;
}

export interface GameSnapshot {
  /** Which scene owns the accessible panel right now. */
  screen: GameScreen;
  /** Current objective, always readable (the "alternative way to read it"). */
  objective: string;
  /** Last status/dialogue line. */
  status: string;
  /** Local demo balance. */
  draftCoin: number;
  /** Whether the player carries the sample mail. */
  carrying: boolean;

  // --- Phase 5: HUD data ---
  /** Handled mail items (delivered letters + confirmed simulated sends). */
  mailCount: number;
  /** Total XP earned. */
  xp: number;
  /** Current level (1 XP threshold per level, see ECONOMY.xpPerLevel). */
  level: number;
  /** XP needed for the next level (mirrored so React never hard-codes it). */
  xpPerLevel: number;
  /** XP progress inside the current level (0 … xpPerLevel-1). */
  xpInLevel: number;
  /** 1-based index of the active quest. */
  questIndex: number;
  /** Total number of quests. */
  questCount: number;
  /** Title of the active quest ("" when every quest is done). */
  activeQuestTitle: string;
  /** Every quest, in play order, with its status. */
  quests: QuestSummary[];
  /** Deterministic local classification produced by the Understanding Worker. */
  classification: string | null;
  /** Prepared sample reply (null until the Response Worker has drafted it). */
  draft: ReplyDraft | null;
  /** Whether the reply-review panel should be open. */
  reviewOpen: boolean;
  /** Whether a finished draft exists that can be reopened. */
  canOpenReview: boolean;
  /** DraftCoin charged for one simulated send (config). */
  sendCost: number;
  /** DraftCoin paid on a confirmed simulated send (config). */
  sendReward: number;
  /** Whether the player can afford the configured send cost right now. */
  canSend: boolean;
  /** True while the mail-bird is flying the reply out. */
  sending: boolean;
  /** True once every quest has been completed. */
  allComplete: boolean;
  /** Current quest stage (exposed for accessible labels/tests). */
  stage: QuestStage | "idle";
  /** Non-null while the player is placing/moving office decor (Phase 6). */
  decorMode: DecorModeState | null;
}

/** React → game commands (discriminated union — one event system, no strings). */
export type GameCommand =
  | { type: "start" }
  | { type: "interact" }
  | { type: "confirm-send"; draft: ReplyDraft }
  | { type: "cancel-review" }
  | { type: "open-review" }
  /**
   * Phase 7 — pause/resume while the in-game menu (or the title overlay) is
   * open. OfficeScene freezes player movement, interact and agent updates on
   * `paused: true` and clears held touch directions, so an open panel can
   * never receive stray game input.
   */
  | { type: "set-paused"; paused: boolean }
  /** On-screen touch D-pad: press/release one direction. */
  | { type: "touch-move"; dir: TouchDir; pressed: boolean }
  /** Office decorate mode: begin placing/moving an owned decor item or cancel. */
  | {
      type: "decorate";
      action: "place" | "move" | "cancel";
      /** Shop item id (required for "place"). */
      itemId?: string;
      /** Index into `profile.placedDecor` (required for "move"). */
      index?: number;
    };

type StateListener = (snapshot: GameSnapshot) => void;
type CommandListener = (command: GameCommand) => void;
type DecorCommand = Extract<GameCommand, { type: "decorate" }>;

let snapshot: GameSnapshot = {
  screen: "title",
  objective: "", // no objective until the office scene publishes its first state
  status: "",
  draftCoin: 0,
  carrying: false,
  mailCount: 0,
  xp: 0,
  level: 1,
  xpPerLevel: 100,
  xpInLevel: 0,
  questIndex: 1,
  questCount: 0,
  activeQuestTitle: "",
  quests: [],
  classification: null,
  draft: null,
  reviewOpen: false,
  canOpenReview: false,
  sendCost: 5,
  sendReward: 20,
  canSend: false,
  sending: false,
  allComplete: false,
  stage: "idle",
  decorMode: null,
};

const stateListeners = new Set<StateListener>();
const commandListeners = new Set<CommandListener>();

/** Current immutable snapshot (reference changes only when something publishes). */
export function getSnapshot(): GameSnapshot {
  return snapshot;
}

/** Subscribe to state updates. Returns an idempotent unsubscribe function. */
export function subscribeState(listener: StateListener): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** Merge a patch into the snapshot and notify every subscriber. */
export function publishState(patch: Partial<GameSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of stateListeners) listener(snapshot);
}

/** Subscribe to React→game commands. Returns an idempotent unsubscribe function. */
export function subscribeCommands(listener: CommandListener): () => void {
  commandListeners.add(listener);
  return () => {
    commandListeners.delete(listener);
  };
}

/**
 * Decor placement needs the live office scene. A request sent while only the
 * title screen is running would reach no listener, so the bridge holds the
 * newest one here until OfficeScene subscribes in `create`.
 */
let pendingDecor: DecorCommand | null = null;

/** OfficeScene only: returns and clears a decor request made before it existed. */
export function takePendingDecor(): DecorCommand | null {
  const request = pendingDecor;
  pendingDecor = null;
  return request;
}

/** Send a command from the accessible UI into the game (no-op with no listeners). */
export function sendCommand(command: GameCommand): void {
  if (command.type === "decorate" && snapshot.screen !== "office") {
    pendingDecor = command.action === "cancel" ? null : command;
    return;
  }
  for (const listener of commandListeners) listener(command);
}
