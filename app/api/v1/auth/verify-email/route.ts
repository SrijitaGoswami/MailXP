/**
 * POST /api/v1/auth/verify-email — `auth.verifyEmail` (B1 contract §2, binding).
 *
 * Token-borne (no session needed). 200 { player: { emailVerified: true } } on
 * a valid, unexpired, unused token — the claim is ATOMIC (guarded update) so
 * replayed/concurrent submissions lose the race and get the same
 * 404 NOT_FOUND as unknown/expired tokens (no reason leakage). 409 CONFLICT
 * when the account is already verified. Success also invalidates every other
 * outstanding verification token and audits `auth.email_verified`.
 * Rate: general class (60/min per IP). Origin-checked (uniform mutation
 * posture, documented in B4_REPORT). Play-now-verify-later: nothing here
 * gates gameplay.
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
  readJsonObject,
  validationError,
} from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { checkRate, clientIp } from "@/lib/server/rateLimit";
import { consumeToken, hashAuthToken } from "@/lib/server/tokens";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "auth.verifyEmail", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const rate = checkRate("general", clientIp(request));
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;
    const token = parsed.body.token;
    if (typeof token !== "string" || token.length === 0) {
      return validationError(requestId, [{ field: "token", message: "Verification token is required." }]);
    }

    const db = getDb();
    const notFound = () =>
      errorResponse(404, CODES.NOT_FOUND, "Verification link is invalid or has expired.", requestId);

    const outcome = await db.$transaction(async (tx) => {
      // Pre-read for the already-verified branch (contract: 409, not 404).
      const row = await tx.authToken.findUnique({
        where: { tokenHash: hashAuthToken(token) },
        include: { user: true },
      });
      const now = Date.now();
      const usable =
        row !== null &&
        row.purpose === "EMAIL_VERIFICATION" &&
        row.consumedAt === null &&
        row.expiresAt.getTime() > now;
      if (!usable || row === null) return { kind: "notFound" } as const;
      if (row.user.emailVerifiedAt !== null) return { kind: "conflict" } as const;

      const claimed = await consumeToken(tx, token, "EMAIL_VERIFICATION");
      if (!claimed.ok) return { kind: "notFound" } as const; // replay race lost

      const user = await tx.user.update({
        where: { id: claimed.userId },
        data: { emailVerifiedAt: new Date(now) },
      });
      // Invalidate every other outstanding verification token.
      await tx.authToken.updateMany({
        where: { userId: claimed.userId, purpose: "EMAIL_VERIFICATION", consumedAt: null },
        data: { consumedAt: new Date(now) },
      });
      await recordAudit(tx, { userId: claimed.userId, eventType: "auth.email_verified", requestId });
      return { kind: "ok", user } as const;
    });

    if (outcome.kind === "notFound") return notFound();
    if (outcome.kind === "conflict") {
      return errorResponse(409, CODES.CONFLICT, "Email is already verified.", requestId);
    }
    return NextResponse.json({ player: { emailVerified: true } });
  });
}
