/**
 * GET /api/v1/integrations/google — `google.status` (B8, contract §7.1).
 *
 * Auth: session required (401 UNAUTHENTICATED / SESSION_EXPIRED). Player-
 * scoped: returns only THIS player's connections, plus the two flags the
 * Settings card needs to render honestly —
 *  - `configured`: whether the server has Google OAuth credentials set
 *    (variable NAMES only in `missing`, never values — spec §9);
 *  - `emailVerified`: the connect gate (contract §7.1 "email verification
 *    precedes connection"); gameplay itself stays ungated (spec §10).
 * The account DTO is built field-by-field — no token material can appear.
 */

import { NextResponse } from "next/server";
import { googleConfigStatus, toGoogleAccountDto } from "@/lib/server/googleOAuth";
import { handle, jsonEnvelope } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "google.status", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const accounts = await db.googleConnection.findMany({
      where: { userId: session.user.id },
      orderBy: { connectedAt: "asc" },
    });
    const config = googleConfigStatus();
    return jsonEnvelope(
      200,
      {
        configured: config.configured,
        missing: config.missing,
        emailVerified: session.user.emailVerifiedAt !== null,
        accounts: accounts.map(toGoogleAccountDto),
      },
      requestId,
    );
  });
}
