/**
 * POST /api/v1/auth/logout — `auth.logout` (B1 contract §2, binding).
 *
 * 204 + cookie cleared; the presented session is revoked server-side and
 * `auth.logout` is audited when a live session was actually revoked.
 * Edge reading documented in B4_REPORT: no session cookie at all → 401
 * UNAUTHENTICATED (there is nothing to log out); a cookie that is present but
 * already dead/revoked/expired → 204 (idempotent-tolerant per contract).
 * Origin-checked; general mutation rate (60/min per IP).
 */

import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/server/audit";
import {
  CODES,
  csrfRejected,
  errorResponse,
  handle,
  originMismatch,
  rateLimitedResponse,
} from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { checkRate, clientIp } from "@/lib/server/rateLimit";
import { clearSessionCookie, hashSessionToken, readSessionCookie, revokeSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "auth.logout", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const rate = checkRate("general", clientIp(request));
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const raw = readSessionCookie(request);
    if (raw === null) {
      return errorResponse(401, CODES.UNAUTHENTICATED, "Authentication required.", requestId);
    }

    const db = getDb();
    const session = await db.session.findUnique({ where: { tokenHash: hashSessionToken(raw) } });
    if (session && session.revokedAt === null) {
      await db.$transaction(async (tx) => {
        const revoked = await revokeSession(tx, session.id);
        if (revoked) {
          await recordAudit(tx, { userId: session.userId, eventType: "auth.logout", requestId });
        }
      });
    }

    const response = new NextResponse(null, { status: 204 });
    clearSessionCookie(response);
    return response;
  });
}
