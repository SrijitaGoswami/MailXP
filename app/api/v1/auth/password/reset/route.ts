/**
 * POST /api/v1/auth/password/reset — `auth.passwordReset` (B1 §2, binding).
 *
 * 200 {} after: password policy re-validation (400 on weak), ATOMIC
 * single-use token consumption (404 NOT_FOUND for unknown/used/expired —
 * identical for every failure reason), password hash update, and revocation
 * of ALL active sessions for the player — everything inside one transaction,
 * plus audit `auth.password_reset`.
 * The caller is not logged in by this route (their previous sessions, if
 * any, are all revoked — they sign in again with the new password).
 * Rate: general class (60/min per IP). Origin-checked. No scheduled password
 * rotation anywhere (B1-confirmed policy).
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
import { hashPassword } from "@/lib/server/password";
import { getDb } from "@/lib/server/prisma";
import { checkRate, clientIp } from "@/lib/server/rateLimit";
import { revokeAllSessions } from "@/lib/server/session";
import { consumeToken } from "@/lib/server/tokens";
import { validatePassword } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "auth.passwordReset", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const rate = checkRate("general", clientIp(request));
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;
    const { token, password } = parsed.body;
    if (token === undefined || typeof token !== "string" || token.length === 0) {
      return validationError(requestId, [{ field: "token", message: "Reset token is required." }]);
    }
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.ok) return validationError(requestId, passwordCheck.errors);

    // Hash before the transaction so bcrypt work does not hold it open.
    const passwordHash = await hashPassword(passwordCheck.value);

    const db = getDb();
    const outcome = await db.$transaction(async (tx) => {
      const claimed = await consumeToken(tx, token, "PASSWORD_RESET");
      if (!claimed.ok) return { kind: "notFound" } as const;
      await tx.user.update({ where: { id: claimed.userId }, data: { passwordHash } });
      await revokeAllSessions(tx, claimed.userId);
      await recordAudit(tx, { userId: claimed.userId, eventType: "auth.password_reset", requestId });
      return { kind: "ok" } as const;
    });

    if (outcome.kind === "notFound") {
      return errorResponse(404, CODES.NOT_FOUND, "Reset link is invalid or has expired.", requestId);
    }
    return NextResponse.json({});
  });
}
