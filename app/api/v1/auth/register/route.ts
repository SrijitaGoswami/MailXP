/**
 * POST /api/v1/auth/register — `auth.register`.
 *
 * Google-only entrance (user decision 2026-10-11): password-based account
 * creation is RETIRED. New accounts are created ONLY by the B8a "Continue
 * with Google" callback (resolveSignInTarget), which requires a real, Google-
 * verified Gmail. This route no longer creates anything — it answers every
 * POST with 403 GOOGLE_SIGNIN_REQUIRED so a direct API call can never mint a
 * dummy account. Origin check and the `register` rate class are retained as
 * cheap hardening.
 */

import { NextResponse } from "next/server";
import {
  CODES,
  csrfRejected,
  errorResponse,
  handle,
  originMismatch,
} from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "auth.register", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);
    return errorResponse(
      403,
      CODES.GOOGLE_SIGNIN_REQUIRED,
      "Password sign-up is retired — continue with Google to verify a real Gmail address.",
      requestId,
    );
  });
}
