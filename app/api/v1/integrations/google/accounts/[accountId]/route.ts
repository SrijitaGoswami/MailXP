/**
 * /api/v1/integrations/google/accounts/{accountId} — B8 §7.1
 *   GET    `google.accountGet`       — one linked identity (owner-scoped).
 *   DELETE `google.accountDisconnect` — unlink this mailbox connection.
 *
 * Ownership: another player's account is 404 NOT_FOUND, never 403 (contract
 * §1.4 — existence is not disclosed).
 *
 * Disconnect semantics (spec §6 + MASTER §4.3):
 *  - local credential removal ALWAYS happens (one transaction: row delete +
 *    audit) — this is the authoritative unlink;
 *  - remote revocation at Google is BEST-EFFORT and only claimed when the
 *    provider confirms 2xx; any failure (missing config/key, unreadable
 *    ciphertext, network) still completes the local disconnect, reported
 *    honestly in the audit meta (`revoked: true|false`);
 *  - original Gmail messages are never touched (contract §1.9) — and B8 has
 *    no local email data at all to delete (that is B9+ policy).
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
import {
  googleConfigStatus,
  revokeGoogleToken,
  toGoogleAccountDto,
} from "@/lib/server/googleOAuth";
import { getDb } from "@/lib/server/prisma";
import { checkRate } from "@/lib/server/rateLimit";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";
import { loadTokenKey, openSecret } from "@/lib/server/secretBox";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ accountId: string }> };

export async function GET(request: Request, { params }: RouteContext): Promise<NextResponse> {
  return handle(request, "google.accountGet", async (requestId) => {
    const { accountId } = await params;
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const account = await db.googleConnection.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== session.user.id) {
      return errorResponse(404, CODES.NOT_FOUND, "Google account not found.", requestId);
    }
    return jsonEnvelope(200, { account: toGoogleAccountDto(account) }, requestId);
  });
}

export async function DELETE(request: Request, { params }: RouteContext): Promise<NextResponse> {
  return handle(request, "google.accountDisconnect", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);
    const { accountId } = await params;

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("general", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const account = await db.googleConnection.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== session.user.id) {
      return errorResponse(404, CODES.NOT_FOUND, "Google account not found.", requestId);
    }

    // Best-effort remote revoke BEFORE the local delete (never inside the
    // transaction; never blocking). Fail closed: any problem → revoked=false,
    // unlink proceeds regardless.
    let revoked = false;
    if (googleConfigStatus().configured && account.refreshTokenCipher !== null) {
      try {
        const token = openSecret(
          {
            cipher: account.refreshTokenCipher,
            nonce: account.refreshTokenNonce as string,
            tag: account.refreshTokenTag as string,
          },
          loadTokenKey(),
        );
        revoked = await revokeGoogleToken(token);
      } catch {
        revoked = false;
      }
    }

    await db.$transaction(async (tx) => {
      // B9 retention (user decision 2026-10-11): disconnect deletes this
      // mailbox's synced messages + sync state. Explicit (not just the FK
      // cascade) so the wipe is observable under the test fake and its order
      // is clear. B10: AI analysis derived from them goes too. Original Gmail
      // messages on Google are NEVER touched (§1.9).
      await tx.emailAnalysis.deleteMany({ where: { googleConnectionId: account.id } });
      await tx.gmailMessage.deleteMany({ where: { googleConnectionId: account.id } });
      await tx.gmailSyncState.deleteMany({ where: { googleConnectionId: account.id } });
      await tx.googleConnection.deleteMany({ where: { id: account.id, userId: session.user.id } });
      await recordAudit(tx, {
        userId: session.user.id,
        eventType: "google.disconnected",
        requestId,
        meta: { accountId: account.id, revoked },
      });
    });

    return new NextResponse(null, { status: 204 });
  });
}
