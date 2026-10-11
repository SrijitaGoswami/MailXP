/**
 * POST /api/v1/auth/login — `auth.login`.
 *
 * Google-only entrance (user decision 2026-10-11): password login is RETIRED.
 * Every entrance must be a real, Google-verified Gmail via "Continue with
 * Google" (B8a sign-in), which proves a genuine mailbox on Google's own
 * screen. This route no longer authenticates anyone — it answers every POST
 * with 403 GOOGLE_SIGNIN_REQUIRED so a direct API call can never password-
 * enter. Existing password accounts are GRANDFATHERED via Google sign-in
 * (the verified-email match resolves to the same account — no progress lost).
 * Origin check and the `login` rate class are retained as cheap hardening.
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
  return handle(request, "auth.login", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);
    return errorResponse(
      403,
      CODES.GOOGLE_SIGNIN_REQUIRED,
      "Password sign-in is retired — continue with Google to verify a real Gmail address.",
      requestId,
    );
  });
}
