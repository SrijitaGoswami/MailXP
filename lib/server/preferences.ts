/**
 * Server-side game preferences (Phase B5).
 *
 * The six-key allowlist is the B2/B4 `Preferences` shape from
 * game/profile.ts — it is the ONLY data PATCH /game/preferences accepts
 * (contract game.preferencesUpdate + phase_b5.md §7). `DEFAULT_PROFILE_PREFS`
 * is byte-identical to game/profile.ts DEFAULTS.prefs and was previously a
 * private constant in the B4 register route; it lives here so register,
 * game/state defaults and preference validation share one definition.
 *
 * Validation is strict: unknown keys are rejected (400), values are checked
 * for exact type/bounds (no coercion of wrong types), and an empty patch is
 * rejected so a no-op write can never churn the profile version.
 */

import type { FieldError } from "@/lib/server/http";
import type { GamePreferences } from "@/game/backend/contract";

/**
 * Re-exported so server callers keep one import site. The declaration itself
 * lives in game/backend/contract.ts (shared, types-only) — as a `type`
 * alias it keeps the implicit index signature Prisma's JSON inputs need.
 */
export type { GamePreferences };

/** Must stay identical to game/profile.ts DEFAULTS.prefs (merge safety). */
export const DEFAULT_PROFILE_PREFS: GamePreferences = {
  masterVolume: 0.8,
  uiVolume: 0.9,
  gameVolume: 0.8,
  muted: false,
  motion: "full",
  touchControls: "auto",
};

export const PREFERENCE_KEYS = [
  "masterVolume",
  "uiVolume",
  "gameVolume",
  "muted",
  "motion",
  "touchControls",
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Per-key value validation — no coercion, exact types/bounds (phase §7). */
function validateValue(key: PreferenceKey, value: unknown): string | null {
  switch (key) {
    case "masterVolume":
    case "uiVolume":
    case "gameVolume":
      return isNumber(value) && value >= 0 && value <= 1
        ? null
        : "Must be a number between 0 and 1.";
    case "muted":
      return typeof value === "boolean" ? null : "Must be a boolean.";
    case "motion":
      return value === "full" || value === "reduced" ? null : 'Must be "full" or "reduced".';
    case "touchControls":
      return value === "auto" || value === "on" || value === "off"
        ? null
        : 'Must be "auto", "on" or "off".';
  }
}

export type PatchResult =
  | { ok: true; patch: Partial<GamePreferences> }
  | { ok: false; errors: FieldError[] };

/**
 * Validate the `preferences` object of a PATCH body.
 * Rejects: non-objects, unknown keys, wrong types/bounds, empty patches.
 */
export function validatePreferencesPatch(input: unknown): PatchResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ field: "preferences", message: "Preferences must be a JSON object." }] };
  }
  const record = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const patch: Partial<GamePreferences> = {};

  for (const key of Object.keys(record)) {
    if (!(PREFERENCE_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: `preferences.${key}`, message: "Unknown preference." });
    }
  }

  for (const key of PREFERENCE_KEYS) {
    if (!(key in record)) continue;
    const message = validateValue(key, record[key]);
    if (message) {
      errors.push({ field: `preferences.${key}`, message });
    } else {
      (patch as Record<string, unknown>)[key] = record[key];
    }
  }

  if (errors.length === 0 && Object.keys(patch).length === 0) {
    errors.push({ field: "preferences", message: "At least one preference must be provided." });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, patch };
}

/**
 * Coerce whatever is in the `prefs` JSON column into a full, valid preference
 * set. Hand-edited/legacy values fall back to defaults (mirrors profile.ts
 * sanitize semantics so the response always contains all six keys).
 */
export function coercePreferences(raw: unknown): GamePreferences {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const num = (value: unknown, fallback: number): number =>
    isNumber(value) ? Math.min(1, Math.max(0, value)) : fallback;
  return {
    masterVolume: num(data.masterVolume, DEFAULT_PROFILE_PREFS.masterVolume),
    uiVolume: num(data.uiVolume, DEFAULT_PROFILE_PREFS.uiVolume),
    gameVolume: num(data.gameVolume, DEFAULT_PROFILE_PREFS.gameVolume),
    muted: typeof data.muted === "boolean" ? data.muted : DEFAULT_PROFILE_PREFS.muted,
    motion: data.motion === "reduced" ? "reduced" : "full",
    touchControls:
      data.touchControls === "on" || data.touchControls === "off"
        ? data.touchControls
        : "auto",
  };
}

/** Merge a validated patch over a full preference set. */
export function mergePreferences(
  base: GamePreferences,
  patch: Partial<GamePreferences>,
): GamePreferences {
  return { ...base, ...patch };
}
