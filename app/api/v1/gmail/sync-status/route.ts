/**
 * GET /api/v1/gmail/sync-status — `gmail.syncStatus` (B9, contract §7.2).
 *
 * Reports the connected mailbox's persistent sync state for the INBOX UI
 * (phase_b9.md §6/§9): connected?, status, counts, last success, safe error
 * class, history window, and whether a reconnect is required. Player-scoped —
 * reads ONLY the session user's own connection; no other mailbox is visible.
 *
 * No Gmail API call happens here (status is read from the database). The
 * browser cannot choose a user/connection — identity comes from the session
 * (spec §4).
 */

import { NextResponse } from "next/server";
import type { GmailSyncStatusDto, GmailSyncStatus } from "@/game/backend/contract";
import { handle, jsonEnvelope } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** DB status enum → the player-facing contract status. */
function toUiStatus(status: string | null): GmailSyncStatus {
  switch (status) {
    case "running":
      return "syncing";
    case "synced":
      return "synced";
    case "delayed":
      return "delayed";
    case "reconnect_required":
      return "reconnect_required";
    case "error":
      return "error";
    default:
      return "pending";
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "gmail.syncStatus", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const connection = await db.googleConnection.findFirst({
      where: { userId: session.user.id, status: "connected" },
    });
    if (!connection) {
      const body: GmailSyncStatusDto = {
        connected: false,
        status: "pending",
        email: null,
        messageCount: 0,
        unreadCount: 0,
        syncInFlight: false,
        lastSyncedAt: null,
        lastSuccessAt: null,
        lastErrorClass: null,
        historyWindowDays: 30,
        reconnectRequired: false,
      };
      return jsonEnvelope(200, body as unknown as Record<string, unknown>, requestId);
    }

    const [syncState, messageCount, unreadCount] = await Promise.all([
      db.gmailSyncState.findUnique({ where: { googleConnectionId: connection.id } }),
      db.gmailMessage.count({ where: { googleConnectionId: connection.id } }),
      db.gmailMessage.count({ where: { googleConnectionId: connection.id, isUnread: true } }),
    ]);

    const status = toUiStatus(syncState?.status ?? null);
    const body: GmailSyncStatusDto = {
      connected: true,
      status,
      email: connection.email,
      messageCount,
      unreadCount,
      syncInFlight: status === "syncing",
      lastSyncedAt: syncState?.lastSyncedAt?.toISOString() ?? null,
      lastSuccessAt: syncState?.lastSuccessAt?.toISOString() ?? null,
      lastErrorClass: syncState?.lastErrorClass ?? null,
      historyWindowDays: syncState?.historyWindowDays ?? 30,
      reconnectRequired: status === "reconnect_required",
    };
    return jsonEnvelope(200, body as unknown as Record<string, unknown>, requestId);
  });
}
