/**
 * `me.get` (GET) and `me.delete` (DELETE) — /api/v1/me (B1 contract §2).
 *
 * GET me.get:
 *   Identity comes ONLY from the server-side session (cookie → hash → row).
 *   200 { player: { id, email, emailVerified, createdAt } } — nothing else
 *   (no password hash, session ids, token hashes, internal metadata).
 *   401 UNAUTHENTICATED (no cookie) / 401 SESSION_EXPIRED (dead cookie).
 *
 * DELETE me.delete:
 *   Password re-authentication (contract), Origin-checked, rate-limited per
 *   player (general class). 202 {} marks deletionRequestedAt (guarded,
 *   atomic), revokes ALL sessions including the caller's, clears the cookie,
 *   and writes `auth.deletion_requested` exactly ONCE (idempotent retries do
 *   not duplicate destructive work; after the first success the session is
 *   revoked so a retry ends in 401 SESSION_EXPIRED — safe, no repeated
 *   effect). Actual erasure is asynchronous (contract: 202 = "async-
 *   controlled"): B7 appends an `account.deletion_requested` outbox event in
 *   the SAME transaction as the marker, and the in-process worker relays it
 *   into an `account.deletion` job that physically erases the account on its
 *   next tick (lib/server/deletion.ts). Login stays disabled in the window
 *   via deletionRequestedAt. Gmail/other provider content is never touched —
 *   no such code exists in B4/B7 by construction.
 */

import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/server/audit";
import { appendOutboxEvent } from "@/lib/server/outbox";
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
import { verifyPassword } from "@/lib/server/password";
import { getDb } from "@/lib/server/prisma";
import { checkRate } from "@/lib/server/rateLimit";
import {
  clearSessionCookie,
  loadSession,
  revokeAllSessions,
  sessionErrorResponse,
  toPlayer,
} from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "me.get", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);
    return NextResponse.json({ player: toPlayer(session.user) });
  });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  return handle(request, "me.delete", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("general", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;
    if (typeof parsed.body.password !== "string" || parsed.body.password.length === 0) {
      return validationError(requestId, [{ field: "password", message: "Password is required." }]);
    }
    const passwordOk = await verifyPassword(parsed.body.password, session.user.passwordHash);
    if (!passwordOk) {
      return errorResponse(401, CODES.INVALID_CREDENTIALS, "Invalid email or password.", requestId);
    }

    // Guarded, idempotent lifecycle marker: first writer wins, everybody gets
    // 202, the audit row is written exactly once.
    await db.$transaction(async (tx) => {
      const claimed = await tx.user.updateMany({
        where: { id: session.user.id, deletionRequestedAt: null },
        data: { deletionRequestedAt: new Date() },
      });
      if (claimed.count === 1) {
        await revokeAllSessions(tx, session.user.id);
        await recordAudit(tx, { userId: session.user.id, eventType: "auth.deletion_requested", requestId });
        // B7 transactional outbox: the event commits atomically with the
        // marker — rolled-back tx => no event; committed marker => exactly
        // one event (claimed guard), which the worker relays into the
        // account.deletion job (lib/server/outbox.ts).
        await appendOutboxEvent(tx, {
          eventType: "account.deletion_requested",
          payload: { userId: session.user.id },
        });
      }
    });

    const response = NextResponse.json({}, { status: 202 });
    clearSessionCookie(response);
    return response;
  });
}
