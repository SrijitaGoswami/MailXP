/**
 * `rewards.status` — GET /api/v1/rewards/status (contract §7.5 "B6 surface").
 *
 * Today's UTC reward-cap progress for the signed-in player: how much was
 * earned today, the cap, what remains, and when the window resets. Derived
 * from quest_reward ledger rows (the same table `game.ledger` pages — no
 * duplicate storage). Missing profile (anomaly, B4 always creates one) →
 * zero earned with full remaining, consistent with B5's read philosophy.
 */

import { NextResponse } from "next/server";
import { dailyRewardStatus, ECONOMY_CONFIG, nextUtcReset, type EconomyDb } from "@/lib/server/economy";
import { handle, csrfRejected, originConflicts } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "rewards.status", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);
    if (originConflicts(request)) return csrfRejected(requestId);

    const profile = await db.playerProfile.findUnique({ where: { userId: session.user.id } });
    if (!profile) {
      const now = new Date();
      return NextResponse.json({
        earnedToday: 0,
        dailyCapDraftCoin: ECONOMY_CONFIG.dailyRewardCapDraftCoin,
        remainingToday: ECONOMY_CONFIG.dailyRewardCapDraftCoin,
        resetsAtUtc: nextUtcReset(now).toISOString(),
      });
    }

    const status = await dailyRewardStatus(db as unknown as EconomyDb, { profileId: profile.id });
    return NextResponse.json(status);
  });
}
