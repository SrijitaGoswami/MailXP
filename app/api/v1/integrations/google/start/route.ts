/**
 * POST /api/v1/integrations/google/start — `google.connectStart` (B8 §7.1,
 * B8a amendment for `intent:"signin"`).
 *
 * Two intents, one route (phase_b8a.md §3.2):
 * - `link` (default, B8 behavior unchanged): only a signed-in, EMAIL-VERIFIED
 *   player may start; the fresh state is bound to user + session.
 * - `signin` (B8a): a SIGNED-OUT visitor may start "Continue with Google";
 *   the state is UNBOUND (userId/sessionId NULL — the 256-bit state itself
 *   is the CSRF defense) and the rate key is the client IP. No verified-email
 *   gate: Google asserts the email on its own consent screen.
 *
 * Order for both: strict Origin (CSRF) → body parse → (link: session →
 * `oauth` rate per player → verified gate) / (signin: `oauth` rate per IP)
 * → beginGoogleConnect / beginGoogleSignIn. The redirect URI inside the
 * returned URL always comes from server config (§4.3). Errors use the B1
 * envelope; a missing/invalid provider setup is a safe 503 SERVICE_UNAVAILABLE
 * naming variable NAMES only (spec §9).
 */

import { NextResponse } from "next/server";
import {
  beginGoogleConnect,
  beginGoogleSignIn,
  parseStartBody,
} from "@/lib/server/googleConnect";
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
import { checkRate, clientIp } from "@/lib/server/rateLimit";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "google.connectStart", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const body = await parseStartBody(request);
    if (!body.ok) return validationError(requestId, [{ field: body.field, message: body.message }]);

    const db = getDb();

    // ---- B8a: signed-out "Continue with Google" ---------------------------
    if (body.intent === "signin") {
      const rate = checkRate("oauth", `signin:${clientIp(request)}`);
      if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

      const outcome = await beginGoogleSignIn(db);
      if (!outcome.ok) {
        return errorResponse(
          503,
          CODES.SERVICE_UNAVAILABLE,
          "Google sign-in is not configured on this server.",
          requestId,
          [{ field: "config", message: `Missing or invalid: ${outcome.missing.join(", ")}` }],
        );
      }
      return jsonEnvelope(200, { authUrl: outcome.authUrl }, requestId);
    }

    // ---- B8: link / reconnect (unchanged) ---------------------------------
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
      accountId: body.accountId,
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
