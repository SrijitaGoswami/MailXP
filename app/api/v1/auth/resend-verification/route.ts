/**
 * POST /api/v1/auth/resend-verification — `auth.resendVerification` (B1 §2).
 *
 * ALWAYS 202 {} — for known, unknown, and already-verified emails alike
 * (no enumeration). Auth is OPTIONAL: a valid session supplies the identity
 * (body email ignored — identity comes only from the session); unauthenticated
 * callers must provide { email }. When the account exists and is unverified, a
 * new token supersedes prior outstanding ones, `auth.verification_resent` is
 * audited, and (dev-only) the token is surfaced via `devDelivery`.
 * Rate: 5 / hour per normalized-email + IP. Origin-checked.
 */

import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/server/audit";
import { buildDevDelivery } from "@/lib/server/emailDelivery";
import {
  csrfRejected,
  handle,
  originMismatch,
  readJsonObject,
  rateLimitedResponse,
  validationError,
} from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { checkRate, clientIp } from "@/lib/server/rateLimit";
import { loadSession } from "@/lib/server/session";
import { issueToken } from "@/lib/server/tokens";
import { normalizeEmail } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "auth.resendVerification", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;

    const db = getDb();

    // Identity: live session wins; otherwise the body must carry the email.
    const session = await loadSession(db, request);
    let email: string;
    if (session.ok) {
      email = session.user.email;
    } else if (typeof parsed.body.email === "string" && parsed.body.email.trim() !== "") {
      email = normalizeEmail(parsed.body.email);
    } else {
      return validationError(requestId, [{ field: "email", message: "Email is required." }]);
    }

    const rate = checkRate("credentialEmail", `${email}:${clientIp(request)}`);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const issued = await db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { email } });
      if (!user || user.emailVerifiedAt !== null) return null; // silent no-op
      const token = await issueToken(tx, user.id, "EMAIL_VERIFICATION");
      await recordAudit(tx, { userId: user.id, eventType: "auth.verification_resent", requestId });
      return token;
    });

    const devDelivery = issued
      ? buildDevDelivery("email_verification", issued.token, issued.expiresAt)
      : null;
    // Contract shape is 202 {} — devDelivery exists only outside production.
    return NextResponse.json(devDelivery ? { devDelivery } : {}, { status: 202 });
  });
}
