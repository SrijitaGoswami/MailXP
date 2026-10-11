/**
 * Canonical server-side shop catalog (Phase B6, contract §4 `shop.catalog`).
 *
 * Single price authority: prices and item eligibility are READ from the
 * shipped `game/data/shopConfig.ts` module (the same definitions the game's
 * artwork references — no secrets, no server-only dependencies, so importing
 * it server-side creates no client bundle risk and no catalog duplication).
 * Client-supplied prices/balances/ownership are never trusted; the purchase
 * route resolves the item and price from HERE inside its transaction.
 *
 * - `available` = not yet owned (every item is ownable exactly once — the
 *   game's model: `ownedItems` is a flat own-once list, confirmed by the user
 *   at B6). Owned items show `available: false`; re-purchase → 409 CONFLICT.
 * - `catalogVersion` is a stable content hash (ids + prices + kinds), so any
 *   catalog change is observable by clients without a second version field.
 */

import { createHash } from "node:crypto";

import { DECOR_ITEMS, OUTFITS } from "@/game/data/shopConfig";
import type { ShopCatalogItem } from "@/game/backend/contract";

export type { ShopCatalogItem };

export interface CatalogEntry {
  itemId: string;
  name: string;
  price: number;
  kind: "outfit" | "decor";
}

/** Every purchasable item in stable order (outfits first, then decor). */
export const CATALOG_ENTRIES: readonly CatalogEntry[] = [
  ...OUTFITS.map((item) => ({
    itemId: item.id,
    name: item.name,
    price: item.price,
    kind: "outfit" as const,
  })),
  ...DECOR_ITEMS.map((item) => ({
    itemId: item.id,
    name: item.name,
    price: item.price,
    kind: "decor" as const,
  })),
];

const byId = new Map<string, CatalogEntry>(CATALOG_ENTRIES.map((entry) => [entry.itemId, entry]));

/** Server lookup: unknown ids resolve to undefined (route answers 404). */
export function findCatalogEntry(itemId: string): CatalogEntry | undefined {
  return byId.get(itemId);
}

/**
 * Stable content hash of the catalog (12 hex chars of sha-256 over the
 * id/price/kind tuples). Recomputed per call is fine (47 items), and it can
 * never drift from the entries themselves.
 */
export function catalogVersion(): string {
  const canonical = CATALOG_ENTRIES.map((entry) => `${entry.itemId}:${entry.kind}:${entry.price}`).join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
}

/**
 * Project the entries into the contract §4 response items. `ownedItemIds`
 * drives `available` (false when already owned — purchase would 409).
 */
export function buildCatalog(ownedItemIds: ReadonlySet<string>): ShopCatalogItem[] {
  return CATALOG_ENTRIES.map((entry) => ({
    itemId: entry.itemId,
    name: entry.name,
    price: entry.price,
    kind: entry.kind,
    available: !ownedItemIds.has(entry.itemId),
  }));
}
