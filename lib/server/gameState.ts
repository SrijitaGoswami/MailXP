/**
 * `game.state` response mapping and ledger cursor helpers (Phase B5).
 *
 * Pure functions so routes stay thin and shapes are unit-testable without a
 * request. Field authority (phase_b5.md §6, contract §3.3): the SERVER owns
 * draftCoin, xp, level, stats, inventory, outfit, decor, preferences and
 * version — this module reads persisted rows (or safe defaults) and never
 * accepts client-supplied values. Internal columns (ids, hashes, timestamps
 * other than ownedSince) never appear in the payload.
 *
 * Missing profile handling (phase §6): computed defaults are RETURNED, not
 * persisted — "do not create on read unless the contract explicitly requires
 * it" (it does not). Every registered user has a row (B4 creates it at
 * register), so this branch is an anomaly path kept safe and side-effect free.
 */

import type { InventoryItem, PlayerProfile } from "@prisma/client";
import type { GameStateDto } from "@/game/backend/contract";
import {
  coercePreferences,
  DEFAULT_PROFILE_PREFS,
  type GamePreferences,
} from "@/lib/server/preferences";

export type { GameStateDto };

export interface DecorPlacement {
  itemId: string;
  x: number;
  y: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** JSONB → valid placements only (mirrors profile.ts sanitize filtering). */
export function coerceDecor(raw: unknown): DecorPlacement[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is DecorPlacement =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as DecorPlacement).itemId === "string" &&
      isFiniteNumber((entry as DecorPlacement).x) &&
      isFiniteNumber((entry as DecorPlacement).y),
  );
}

/** JSONB → { mailCount } contract stat set; malformed data falls back to 0. */
export function coerceStats(raw: unknown): { mailCount: number } {
  const mailCount =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).mailCount
      : undefined;
  return { mailCount: isFiniteNumber(mailCount) && mailCount >= 0 ? Math.floor(mailCount) : 0 };
}

/**
 * Build the contract `game.state` body. `profile` is the row (with
 * inventoryItems) or null for the anomaly path.
 */
export function buildGameState(
  userId: string,
  profile: (Partial<PlayerProfile> & { inventoryItems?: InventoryItem[] }) | null,
): GameStateDto {
  const inventory = (profile?.inventoryItems ?? [])
    .slice()
    .sort((a, b) => a.ownedSince.getTime() - b.ownedSince.getTime() || a.itemId.localeCompare(b.itemId));

  return {
    playerId: userId,
    draftCoin: typeof profile?.draftCoin === "number" ? profile.draftCoin : 0,
    xp: typeof profile?.xp === "number" ? profile.xp : 0,
    level: typeof profile?.level === "number" ? profile.level : 1,
    stats: coerceStats(profile?.stats),
    ownedItems: inventory.map((item) => ({
      itemId: item.itemId,
      ownedSince: item.ownedSince.toISOString(),
    })),
    equippedOutfit:
      typeof profile?.equippedOutfit === "string" && profile.equippedOutfit.length > 0
        ? profile.equippedOutfit
        : "worker",
    placedDecor: coerceDecor(profile?.placedDecor),
    preferences: profile ? coercePreferences(profile.prefs) : { ...DEFAULT_PROFILE_PREFS },
    version: typeof profile?.version === "number" ? profile.version : 1,
  };
}

// --------------------------------------------------------------- pagination --
// Contract §1.5: ?limit= (default 25, max 100), opaque ?cursor=, ordering
// createdAt DESC with id DESC, { items, nextCursor } with null = end of list.

export const LEDGER_DEFAULT_LIMIT = 25;
export const LEDGER_MAX_LIMIT = 100;

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

/** Opaque cursor: base64url of a compact JSON tuple. Not a client contract. */
export function encodeCursor(entry: { createdAt: Date; id: string }): string {
  const payload = JSON.stringify({ c: entry.createdAt.toISOString(), i: entry.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** Decode a cursor; malformed/invalid input → null (caller answers 400). */
export function decodeCursor(raw: string): LedgerCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { c, i } = parsed as { c?: unknown; i?: unknown };
    if (typeof c !== "string" || typeof i !== "string" || i.length === 0) return null;
    const createdAt = new Date(c);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: i };
  } catch {
    return null;
  }
}

/** Parse ?limit= with the contract bounds; null = invalid (caller answers 400). */
export function parseLimit(raw: string | null): number | null {
  if (raw === null) return LEDGER_DEFAULT_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > LEDGER_MAX_LIMIT) return null;
  return value;
}
