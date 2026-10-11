/**
 * `rewards.rules` — GET /api/v1/rewards/rules (contract §7.5 "B6 surface").
 *
 * READ-ONLY server truth for the fixed reward configuration the user
 * confirmed at B6: quest reward amount, per-UTC-day cap, reset hour. No
 * issuance happens here (B11 provider evidence; dev fixture at
 * POST /api/v1/dev/rewards until then). Missing profile → rules are global
 * config, so the read succeeds regardless (B5 read philosophy: no create-on-read).
 */

import { NextResponse } from "next/server";
import { ECONOMY_CONFIG } from "@/lib/server/economy";
import { handle, csrfRejected, originConflicts } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "rewards.rules", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);
    if (originConflicts(request)) return csrfRejected(requestId);

    return NextResponse.json({
      questRewardDraftCoin: ECONOMY_CONFIG.questRewardDraftCoin,
      dailyCapDraftCoin: ECONOMY_CONFIG.dailyRewardCapDraftCoin,
      resetUtcHour: ECONOMY_CONFIG.rewardResetUtcHour,
    });
  });
}
