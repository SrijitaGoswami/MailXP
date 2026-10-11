/**
 * POST /api/v1/integrations/google/accounts/{accountId}/release —
 * `google.accountRelease` (B8 §7.1).
 *
 * The mailbox-TRANSFER half of MASTER §3.2: "a mailbox transfer requires the
 * current owner to authorize release; the new owner must authenticate with
 * Google and confirm the link." Releasing:
 *  - flips status `connected → released` and WIPES the sealed refresh token
 *    in place (credentials the releaser handed over are no longer usable by
 *    anyone; the new owner consents fresh) — spec §6 minimum-material rule;
 *  - keeps the identity row (googleSub stays reserved) so the transfer is
 *    explicit: only a RELEASED row may move to another player, and only via
 *    that player's own OAuth consent (linkGoogleIdentity);
 *  - is idempotent: releasing an already-released row returns it unchanged.
 * Owner-scoped (404 for others), strict Origin, `general` rate class,
 * audited `google.released` inside the same transaction.
 */

import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/server/audit";
import {
  CODES,
  csrfRejected,
  errorResponse,
  handle,
  jsonEnvelope,
  originMismatch,
  rateLimitedResponse,
} from "@/lib/server/http";
import { toGoogleAccountDto } from "@/lib/server/googleOAuth";
import { getDb } from "@/lib/server/prisma";
import { checkRate } from "@/lib/server/rateLimit";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ accountId: string }> };

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  return handle(request, "google.accountRelease", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);
    const { accountId } = await params;

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("general", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const account = await db.$transaction(async (tx) => {
      const row = await tx.googleConnection.findUnique({ where: { id: accountId } });
      if (!row || row.userId !== session.user.id) return null; // → 404 below
      if (row.status === "connected") {
        // B9 retention (user decision 2026-10-11): release deletes this
        // mailbox's synced messages + sync state (the row stays reserved for
        // transfer, but no personal email content survives the hand-off).
        // B10: the AI analysis derived from those messages goes with them.
        // Explicit — the row is updated in place, so the FK cascade never fires.
        await tx.emailAnalysis.deleteMany({ where: { googleConnectionId: row.id } });
        await tx.gmailMessage.deleteMany({ where: { googleConnectionId: row.id } });
        await tx.gmailSyncState.deleteMany({ where: { googleConnectionId: row.id } });
        const updated = await tx.googleConnection.update({
          where: { id: row.id },
          data: {
            status: "released",
            refreshTokenCipher: null,
            refreshTokenNonce: null,
            refreshTokenTag: null,
          },
        });
        await recordAudit(tx, {
          userId: session.user.id,
          eventType: "google.released",
          requestId,
          meta: { accountId: row.id },
        });
        return updated;
      }
      return row; // already released — idempotent
    });

    if (!account) {
      return errorResponse(404, CODES.NOT_FOUND, "Google account not found.", requestId);
    }
    return jsonEnvelope(200, { account: toGoogleAccountDto(account) }, requestId);
  });
}
