/**
 * POST /api/v1/integrations/google/accounts/{accountId}/reconnect —
 * `google.accountReconnect` (B8 §7.1).
 *
 * Re-runs the consent round-trip for an identity the player already owns
 * (expired/revoked credentials, or a released row being taken back). Same
 * rules as connectStart — strict Origin, session, `oauth` rate class,
 * verified email, server-configured redirect — and beginGoogleConnect
 * re-validates ownership before minting a state with intent
 * `reconnect:<accountId>`; the callback refreshes THAT row's credentials
 * instead of creating a link.
 */

import { NextResponse } from "next/server";
import { beginGoogleConnect, parseConnectBody } from "@/lib/server/googleConnect";
import {
  CODES,
  csrfRejected,
  errorResponse,
  handle,
  jsonEnvelope,
  originMismatch,
  rateLimitedResponse,
  validationError,
} from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { checkRate } from "@/lib/server/rateLimit";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ accountId: string }> };

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  return handle(request, "google.accountReconnect", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);
    const { accountId } = await params;

    // A body is unnecessary here (the path carries the target) — tolerate an
    // empty body, reject a malformed one like connectStart does.
    const body = await parseConnectBody(request);
    if (!body.ok) return validationError(requestId, [{ field: body.field, message: body.message }]);

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("oauth", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    if (session.user.emailVerifiedAt === null) {
      return errorResponse(
        403,
        CODES.EMAIL_NOT_VERIFIED,
        "Verify your email address before connecting Google.",
        requestId,
      );
    }

    const outcome = await beginGoogleConnect(db, {
      userId: session.user.id,
      sessionId: session.session.id,
      accountId,
    });
    if (!outcome.ok) {
      if (outcome.reason === "config") {
        return errorResponse(
          503,
          CODES.SERVICE_UNAVAILABLE,
          "Google connection is not configured on this server.",
          requestId,
          [{ field: "config", message: `Missing or invalid: ${outcome.missing.join(", ")}` }],
        );
      }
      return errorResponse(404, CODES.NOT_FOUND, "Google account not found.", requestId);
    }

    return jsonEnvelope(200, { authUrl: outcome.authUrl }, requestId);
  });
}
