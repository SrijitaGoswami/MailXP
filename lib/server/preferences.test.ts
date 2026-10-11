/**
 * Phase B5 — pure unit tests for lib/server/preferences.ts (allowlist
 * validation, coercion, merge). Mirrors game/profile.ts semantics.
 */

import { describe, expect, it } from "vitest";
import {
  coercePreferences,
  DEFAULT_PROFILE_PREFS,
  mergePreferences,
  PREFERENCE_KEYS,
  validatePreferencesPatch,
} from "@/lib/server/preferences";

describe("DEFAULT_PROFILE_PREFS", () => {
  it("matches the documented game/profile.ts DEFAULTS.prefs literal", () => {
    expect(DEFAULT_PROFILE_PREFS).toEqual({
      masterVolume: 0.8,
      uiVolume: 0.9,
      gameVolume: 0.8,
      muted: false,
      motion: "full",
      touchControls: "auto",
    });
    expect(Object.keys(DEFAULT_PROFILE_PREFS).sort()).toEqual([...PREFERENCE_KEYS].sort());
  });
});

describe("validatePreferencesPatch", () => {
  it("accepts a full valid set", () => {
    const result = validatePreferencesPatch({ ...DEFAULT_PROFILE_PREFS });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch).toEqual(DEFAULT_PROFILE_PREFS);
  });

  it("accepts a partial set (PATCH semantics)", () => {
    const result = validatePreferencesPatch({ muted: true, masterVolume: 0.25 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch).toEqual({ muted: true, masterVolume: 0.25 });
  });

  it("accepts volume boundaries 0 and 1", () => {
    expect(validatePreferencesPatch({ masterVolume: 0 }).ok).toBe(true);
    expect(validatePreferencesPatch({ gameVolume: 1 }).ok).toBe(true);
  });

  it.each([
    ["non-object", "loud"],
    ["null", null],
    ["array", [1, 2, 3]],
    ["number", 7],
  ])("rejects a non-object preferences value (%s)", (_name, input) => {
    const result = validatePreferencesPatch(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].field).toBe("preferences");
  });

  it("rejects unknown keys with a field-level detail", () => {
    const result = validatePreferencesPatch({ theme: "dark", volume: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.field).sort()).toEqual([
        "preferences.theme",
        "preferences.volume",
      ]);
      for (const error of result.errors) expect(error.message).toBe("Unknown preference.");
    }
  });

  it("rejects economy/ownership/identity fields (no authority widening)", () => {
    for (const smuggled of ["draftCoin", "ownedItems", "equippedOutfit", "playerId", "version", "xp"]) {
      const result = validatePreferencesPatch({ [smuggled]: "anything" });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects wrong types and out-of-bounds values", () => {
    const bad = validatePreferencesPatch({
      masterVolume: 1.5,
      uiVolume: -0.1,
      gameVolume: "0.5",
      muted: "true",
      motion: "hyper",
      touchControls: "maybe",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveLength(6);
  });

  it("rejects an empty patch (no-op writes can never churn the version)", () => {
    const result = validatePreferencesPatch({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].field).toBe("preferences");
      expect(result.errors[0].message).toContain("At least one");
    }
  });

  it("does not coerce: a valid patch only carries the validated keys", () => {
    const result = validatePreferencesPatch({ muted: false, junk: 1, motion: "reduced" });
    expect(result.ok).toBe(false); // junk present → whole patch rejected
  });
});

describe("coercePreferences", () => {
  it("returns the full six-key set for garbage input", () => {
    expect(coercePreferences(undefined)).toEqual(DEFAULT_PROFILE_PREFS);
    expect(coercePreferences("nope")).toEqual(DEFAULT_PROFILE_PREFS);
    expect(coercePreferences([1])).toEqual(DEFAULT_PROFILE_PREFS);
  });

  it("clamps/falls back per key (profile.ts sanitize semantics)", () => {
    const coerced = coercePreferences({
      masterVolume: 0.4,
      uiVolume: 9, // out of range → clamped to 1
      gameVolume: "loud", // wrong type → default
      muted: "yes", // wrong type → default
      motion: "reduced",
      touchControls: "on",
      unknownKey: true, // ignored
    });
    expect(coerced).toEqual({
      masterVolume: 0.4,
      uiVolume: 1,
      gameVolume: 0.8,
      muted: false,
      motion: "reduced",
      touchControls: "on",
    });
  });

  it("motion falls back to \"full\", touchControls to \"auto\"", () => {
    const coerced = coercePreferences({ motion: "hyper", touchControls: "sometimes" });
    expect(coerced.motion).toBe("full");
    expect(coerced.touchControls).toBe("auto");
  });
});

describe("mergePreferences", () => {
  it("applies a patch over a full base without dropping keys", () => {
    const merged = mergePreferences(DEFAULT_PROFILE_PREFS, { muted: true });
    expect(merged).toEqual({ ...DEFAULT_PROFILE_PREFS, muted: true });
    expect(Object.keys(merged)).toHaveLength(6);
  });
});
