/**
 * `game.state` — GET /api/v1/game/state (B1 contract §3, phase_b5.md §6).
 *
 * Identity comes ONLY from the validated B4 session; no client-supplied id
 * ever selects data. Returns the contract shape (playerId, draftCoin, xp,
 * level, stats, ownedItems, equippedOutfit, placedDecor, preferences,
 * version) with internal fields (password hashes, session/token data, audit
 * metadata, profile ids) excluded. rewardHistory is intentionally NOT
 * inlined — it lives in the ledger (contract §3).
 *
 * Missing profile (anomaly path — B4 creates one at register): safe computed
 * defaults are returned WITHOUT persisting, per phase §6 ("do not create on
 * read unless the contract explicitly requires it" — it does not).
 */

import { NextResponse } from "next/server";
import { buildGameState } from "@/lib/server/gameState";
import { handle } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "game.state", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const profile = await db.playerProfile.findUnique({
      where: { userId: session.user.id },
      include: { inventoryItems: true },
    });

    return NextResponse.json(buildGameState(session.user.id, profile));
  });
}
