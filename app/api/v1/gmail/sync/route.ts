/**
 * POST /api/v1/gmail/sync — `gmail.syncStart` (B9, contract §7.2).
 *
 * "Sync now" / reconcile-on-open. This route NEVER calls Gmail inline
 * (phase_b9.md §6): it re-checks the player owns a connected mailbox, then
 * enqueues a durable `gmail.sync` job onto the B7 queue. The worker does the
 * provider work. Repeated taps COALESCE to one live job via the unique
 * dedupeKey `gmail.sync:<connectionId>` (spec §6), so a burst of requests or
 * push hints cannot spawn duplicate jobs or duplicate messages.
 *
 * Player-scoped + strict Origin + `general` rate class + audited
 * `gmail.sync_requested`. The browser cannot choose the connection — it comes
 * from the session (spec §4).
 */

import { NextResponse } from "next/server";
import type { GmailSyncStartDto, GmailSyncStatus } from "@/game/backend/contract";
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
import { enqueueJob, type QueueDb } from "@/lib/server/jobQueue";
import { getDb } from "@/lib/server/prisma";
import { checkRate } from "@/lib/server/rateLimit";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "gmail.syncStart", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("general", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const connection = await db.googleConnection.findFirst({
      where: { userId: session.user.id, status: "connected" },
    });
    if (!connection) {
      return errorResponse(404, CODES.NOT_FOUND, "No connected Gmail mailbox.", requestId);
    }

    // A mailbox whose credentials are dead must not be re-triggerable into a
    // retry storm — surface RECONNECT_REQUIRED so the UI offers reconnect.
    const state = await db.gmailSyncState.findUnique({ where: { googleConnectionId: connection.id } });
    if (state?.status === "reconnect_required") {
      return errorResponse(409, CODES.RECONNECT_REQUIRED, "Reconnect this mailbox to resume sync.", requestId);
    }

    // Durable enqueue (never inline provider work). The dedupeKey coalesces.
    const { created } = await enqueueJob(db as unknown as QueueDb, {
      jobType: "gmail.sync",
      payload: { googleConnectionId: connection.id },
      dedupeKey: `gmail.sync:${connection.id}`,
    });

    await recordAudit(db, {
      userId: session.user.id,
      eventType: "gmail.sync_requested",
      requestId,
      meta: { accountId: connection.id, coalesced: !created },
    });

    // Reflect the optimistic in-flight state so the UI shows "syncing".
    const status: GmailSyncStatus = "syncing";
    const body: GmailSyncStartDto = { enqueued: created, status };
    return jsonEnvelope(202, body as unknown as Record<string, unknown>, requestId);
  });
}
