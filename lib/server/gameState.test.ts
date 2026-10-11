/**
 * Phase B5 — pure unit tests for lib/server/gameState.ts (contract response
 * mapping + §1.5 cursor helpers). No routes, no database.
 */

import { describe, expect, it } from "vitest";
import {
  buildGameState,
  coerceDecor,
  coerceStats,
  decodeCursor,
  encodeCursor,
  LEDGER_DEFAULT_LIMIT,
  LEDGER_MAX_LIMIT,
  parseLimit,
} from "@/lib/server/gameState";

const DEFAULT_PREFS = {
  masterVolume: 0.8,
  uiVolume: 0.9,
  gameVolume: 0.8,
  muted: false,
  motion: "full",
  touchControls: "auto",
};

const USER_ID = "user-abc";

describe("buildGameState", () => {
  it("null profile → contract defaults with no invented data", () => {
    const state = buildGameState(USER_ID, null);
    expect(state).toEqual({
      playerId: USER_ID,
      draftCoin: 0,
      xp: 0,
      level: 1,
      stats: { mailCount: 0 },
      ownedItems: [],
      equippedOutfit: "worker",
      placedDecor: [],
      preferences: DEFAULT_PREFS,
      version: 1,
    });
  });

  it("maps a persisted profile and sorts inventory deterministically", () => {
    const profile = {
      userId: USER_ID,
      draftCoin: 120,
      xp: 350,
      level: 4,
      stats: { mailCount: 12 },
      equippedOutfit: "forest",
      placedDecor: [
        { itemId: "plant-1", x: 40, y: 60 },
        { itemId: "lamp-2", x: 10, y: 20 },
      ],
      prefs: { ...DEFAULT_PREFS, muted: true },
      version: 9,
      inventoryItems: [
        { itemId: "courier", ownedSince: new Date("2026-02-01T00:00:00.000Z") },
        { itemId: "tech", ownedSince: new Date("2026-01-01T00:00:00.000Z") },
      ],
    };
    const state = buildGameState(USER_ID, profile as never);
    expect(state.playerId).toBe(USER_ID);
    expect(state.draftCoin).toBe(120);
    expect(state.xp).toBe(350);
    expect(state.level).toBe(4);
    expect(state.stats).toEqual({ mailCount: 12 });
    expect(state.equippedOutfit).toBe("forest");
    expect(state.preferences.muted).toBe(true);
    expect(state.version).toBe(9);
    expect(state.ownedItems.map((item) => item.itemId)).toEqual(["tech", "courier"]);
    expect(state.ownedItems[0].ownedSince).toBe("2026-01-01T00:00:00.000Z");
    expect(state.placedDecor).toHaveLength(2);
  });

  it("falls back safely when optional fields are missing/invalid", () => {
    const state = buildGameState(USER_ID, {
      equippedOutfit: "",
      stats: { mailCount: -4 },
      prefs: "garbage",
      inventoryItems: [{ itemId: "x", ownedSince: new Date("2026-01-01T00:00:00.000Z") }],
    } as never);
    expect(state.equippedOutfit).toBe("worker");
    expect(state.stats).toEqual({ mailCount: 0 });
    expect(state.preferences).toEqual(DEFAULT_PREFS);
    expect(state.draftCoin).toBe(0);
    expect(state.level).toBe(1);
    expect(state.ownedItems).toHaveLength(1);
  });
});

describe("coerceDecor / coerceStats", () => {
  it("keeps only well-formed placements", () => {
    expect(
      coerceDecor([
        { itemId: "a", x: 1, y: 2 },
        { itemId: "b", x: Number.NaN, y: 2 },
        { itemId: 3, x: 1, y: 2 },
        null,
        "junk",
        { x: 1, y: 2 },
      ]),
    ).toEqual([{ itemId: "a", x: 1, y: 2 }]);
    expect(coerceDecor("nope")).toEqual([]);
    expect(coerceDecor({})).toEqual([]);
  });

  it("keeps only a non-negative integer-ish mailCount", () => {
    expect(coerceStats({ mailCount: 3 })).toEqual({ mailCount: 3 });
    expect(coerceStats({ mailCount: 3.7 })).toEqual({ mailCount: 3 });
    expect(coerceStats({ mailCount: -1 })).toEqual({ mailCount: 0 });
    expect(coerceStats({ mailCount: "5" })).toEqual({ mailCount: 0 });
    expect(coerceStats(null)).toEqual({ mailCount: 0 });
    expect(coerceStats([1, 2])).toEqual({ mailCount: 0 });
  });
});

describe("cursor helpers (§1.5)", () => {
  it("round-trips a cursor", () => {
    const createdAt = new Date("2026-07-04T12:34:56.789Z");
    const cursor = encodeCursor({ createdAt, id: "led-0042" });
    expect(cursor).not.toContain("{"); // opaque to clients
    expect(decodeCursor(cursor)).toEqual({ createdAt, id: "led-0042" });
  });

  it("rejects malformed cursors (caller answers 400)", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-json!!")).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"c":"nope","i":"x"}').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"c":"2026-01-01T00:00:00.000Z","i":""}').toString("base64url"))).toBeNull();
  });

  it("enforces the contract limit bounds", () => {
    expect(parseLimit(null)).toBe(LEDGER_DEFAULT_LIMIT);
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("100")).toBe(LEDGER_MAX_LIMIT);
    expect(parseLimit("101")).toBeNull();
    expect(parseLimit("0")).toBeNull();
    expect(parseLimit("-1")).toBeNull();
    expect(parseLimit("abc")).toBeNull();
    expect(parseLimit("1e2")).toBeNull();
    expect(parseLimit("")).toBeNull();
  });
});
