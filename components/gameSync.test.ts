/**
 * Phase B5 — pure sync-logic tests (migration/backup, hydration mapping,
 * preference import decisions, SSE fallback state machine). Framework-free by
 * design — the orchestrating hook wires these together in the browser.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { GameStateDto } from "@/game/backend/contract";
import {
  INITIAL_STREAM_STATE,
  LEGACY_BACKUP_KEY,
  LOCAL_PROFILE_KEY,
  MIGRATION_MARKER_KEY,
  preferencesEqual,
  runLegacyMigration,
  shouldImportPreferences,
  stateToProfilePatch,
  streamFailed,
  STREAM_FAILURE_THRESHOLD,
  streamOpened,
  type StorageLike,
} from "@/components/gameSync";

function makeStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const STATE: GameStateDto = {
  playerId: "user-1",
  draftCoin: 120,
  xp: 50,
  level: 1,
  stats: { mailCount: 3 },
  ownedItems: [
    { itemId: "tech", ownedSince: "2026-01-01T00:00:00.000Z" },
    { itemId: "courier", ownedSince: "2026-02-01T00:00:00.000Z" },
  ],
  equippedOutfit: "tech",
  placedDecor: [{ itemId: "plant-1", x: 40, y: 60 }],
  preferences: {
    masterVolume: 0.8,
    uiVolume: 0.9,
    gameVolume: 0.8,
    muted: false,
    motion: "full",
    touchControls: "auto",
  },
  version: 4,
};

describe("runLegacyMigration (backup first, never repeated)", () => {
  const LEGACY_RAW = '{"version":1,"draftCoin":77,"ownedItems":["courier"]}';

  it("backs up the raw local profile exactly once and sets the marker", () => {
    const storage = makeStorage({ [LOCAL_PROFILE_KEY]: LEGACY_RAW });

    const first = runLegacyMigration(storage);
    expect(first).toEqual({ ran: true, backedUp: true });
    expect(storage.getItem(LEGACY_BACKUP_KEY)).toBe(LEGACY_RAW); // byte-identical

    const second = runLegacyMigration(storage);
    expect(second).toEqual({ ran: false, backedUp: false });
    expect(storage.getItem(LEGACY_BACKUP_KEY)).toBe(LEGACY_RAW); // still pristine
  });

  it("never touches the live profile key itself", () => {
    const storage = makeStorage({ [LOCAL_PROFILE_KEY]: LEGACY_RAW });
    runLegacyMigration(storage);
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(LEGACY_RAW);
    expect(storage.getItem(MIGRATION_MARKER_KEY)).toBeTruthy();
  });

  it("does not overwrite an existing backup (marker or not)", () => {
    const storage = makeStorage({
      [LOCAL_PROFILE_KEY]: "newer-live-data",
      [LEGACY_BACKUP_KEY]: "original-legacy",
    });
    runLegacyMigration(storage);
    expect(storage.getItem(LEGACY_BACKUP_KEY)).toBe("original-legacy");
  });

  it("no local payload → marker only, nothing fabricated", () => {
    const storage = makeStorage();
    const result = runLegacyMigration(storage);
    expect(result).toEqual({ ran: true, backedUp: false });
    expect(storage.getItem(LEGACY_BACKUP_KEY)).toBeNull();
    expect(storage.getItem(MIGRATION_MARKER_KEY)).toBeTruthy();
  });

  it("is idempotent across many sync cycles (repeated migration prevented)", () => {
    const storage = makeStorage({ [LOCAL_PROFILE_KEY]: LEGACY_RAW });
    runLegacyMigration(storage);
    storage.data.delete(LEGACY_BACKUP_KEY); // simulate catastrophic client loss
    const again = runLegacyMigration(storage);
    expect(again.ran).toBe(false); // marker wins — no re-run, no re-write
    expect(storage.getItem(LEGACY_BACKUP_KEY)).toBeNull();
  });
});

describe("stateToProfilePatch (server → local cache only)", () => {
  it("maps every mirrored field", () => {
    expect(stateToProfilePatch(STATE as never)).toEqual({
      draftCoin: 120,
      ownedItems: ["tech", "courier"],
      equippedOutfit: "tech",
      placedDecor: [{ itemId: "plant-1", x: 40, y: 60 }],
      prefs: STATE.preferences,
    });
  });

  it("coerces unknown outfit ids to the default (never trusts the wire blindly)", () => {
    const patch = stateToProfilePatch({ ...STATE, equippedOutfit: "hacked-outfit" } as never);
    expect(patch.equippedOutfit).toBe("worker");
    const nulled = stateToProfilePatch({ ...STATE, equippedOutfit: null } as never);
    expect(nulled.equippedOutfit).toBe("worker");
  });

  it("never emits fields outside the Profile shape (no playerId/stats/version leakage)", () => {
    const patch = stateToProfilePatch(STATE as never);
    expect(Object.keys(patch).sort()).toEqual([
      "draftCoin",
      "equippedOutfit",
      "ownedItems",
      "placedDecor",
      "prefs",
    ]);
  });
});

describe("preference comparison / legacy import decision", () => {
  const base = STATE.preferences;

  it("preferencesEqual compares all six keys", () => {
    expect(preferencesEqual(base, { ...base })).toBe(true);
    expect(preferencesEqual(base, { ...base, muted: true })).toBe(false);
    expect(preferencesEqual(base, { ...base, masterVolume: 0.5 })).toBe(false);
    expect(preferencesEqual(base, { ...base, motion: "reduced" })).toBe(false);
    expect(preferencesEqual(base, { ...base, touchControls: "on" })).toBe(false);
    expect(preferencesEqual(base, { ...base, uiVolume: 0.1 })).toBe(false);
    expect(preferencesEqual(base, { ...base, gameVolume: 0.1 })).toBe(false);
  });

  it("import runs only when local actually differs (one-time in practice)", () => {
    expect(shouldImportPreferences(base, { ...base })).toBe(false);
    expect(shouldImportPreferences({ ...base, muted: true }, base)).toBe(true);
  });
});

describe("SSE fallback state machine (contract §5)", () => {
  it("starts with no failures and no polling", () => {
    expect(INITIAL_STREAM_STATE).toEqual({ consecutiveFailures: 0, polling: false });
  });

  it(`enters polling only after ${STREAM_FAILURE_THRESHOLD} consecutive failures`, () => {
    let state = { ...INITIAL_STREAM_STATE };
    state = streamFailed(state);
    expect(state).toEqual({ consecutiveFailures: 1, polling: false });
    state = streamFailed(state);
    expect(state).toEqual({ consecutiveFailures: 2, polling: false });
    state = streamFailed(state);
    expect(state).toEqual({ consecutiveFailures: 3, polling: true });
    state = streamFailed(state);
    expect(state).toEqual({ consecutiveFailures: 4, polling: true });
  });

  it("a successful open resets counters and stops polling (then refetch)", () => {
    let state = streamFailed(streamFailed(streamFailed(INITIAL_STREAM_STATE)));
    expect(state.polling).toBe(true);
    state = streamOpened(state);
    expect(state).toEqual({ consecutiveFailures: 0, polling: false });
  });

  it("failures below the threshold never trigger polling (bounded retries)", () => {
    const state = streamOpened(streamFailed(streamFailed(INITIAL_STREAM_STATE)));
    expect(state.polling).toBe(false);
    expect(state.consecutiveFailures).toBe(0); // success reset before threshold
  });
});
