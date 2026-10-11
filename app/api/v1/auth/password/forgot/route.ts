/**
 * POST /api/v1/auth/password/forgot — `auth.passwordForgot` (B1 §2, binding).
 *
 * ALWAYS 202 {} for existing and non-existing emails alike (no enumeration) —
 * the ONLY in-contract error besides 429. Interpretation recorded in
 * B4_REPORT: a structurally malformed body (missing/non-string email) is a
 * protocol/schema failure → 400 VALIDATION_ERROR per B1 §1.4; any provided
 * string (even syntactically invalid — it simply cannot exist) proceeds and
 * returns 202 with no token issued.
 * When the account exists: single-use 1-hour reset token issued (hashed at
 * rest), `auth.reset_requested` audited, dev-only `devDelivery` surfaces the
 * token. Rate: 5 / hour per normalized-email + IP. Origin-checked.
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
import { issueToken } from "@/lib/server/tokens";
import { normalizeEmail } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "auth.passwordForgot", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;
    const rawEmail = parsed.body.email;
    if (rawEmail === undefined || typeof rawEmail !== "string") {
      return validationError(requestId, [{ field: "email", message: "Email is required." }]);
    }
    const email = normalizeEmail(rawEmail);

    const rate = checkRate("credentialEmail", `${email}:${clientIp(request)}`);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const db = getDb();
    const issued = await db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { email } });
      if (!user) return null; // unknown or invalid-format email: silent no-op
      const token = await issueToken(tx, user.id, "PASSWORD_RESET");
      await recordAudit(tx, { userId: user.id, eventType: "auth.reset_requested", requestId });
      return token;
    });

    const devDelivery = issued ? buildDevDelivery("password_reset", issued.token, issued.expiresAt) : null;
    // Contract shape is 202 {} — devDelivery exists only outside production.
    return NextResponse.json(devDelivery ? { devDelivery } : {}, { status: 202 });
  });
}
