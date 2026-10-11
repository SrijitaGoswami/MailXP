/**
 * GET /api/v1/integrations/google/accounts — `google.accountsList` (B8 §7.1).
 *
 * Player-scoped list of linked Google identities (a player may hold several —
 * MASTER §4.2). No config/verification flags here (that is `google.status`);
 * the DTO projection excludes every token field by construction.
 */

import { NextResponse } from "next/server";
import { toGoogleAccountDto } from "@/lib/server/googleOAuth";
import { handle, jsonEnvelope } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "google.accountsList", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const accounts = await db.googleConnection.findMany({
      where: { userId: session.user.id },
      orderBy: { connectedAt: "asc" },
    });
    return jsonEnvelope(200, { accounts: accounts.map(toGoogleAccountDto) }, requestId);
  });
}
