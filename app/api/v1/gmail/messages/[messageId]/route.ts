/**
 * GET /api/v1/gmail/messages/{messageId} — `gmail.messageGet` (B9, §7.2).
 *
 * Safe message detail for the inbox reader. PLAIN TEXT body only — HTML is
 * never returned or rendered (spec §5). Attachments are METADATA only (never
 * bytes). Player-scoped: the message is looked up by row id AND the session
 * user's own connection, so another player's message is a safe 404 — existence
 * is never disclosed (contract §1.4). No Gmail call here (local mirror).
 */

import { NextResponse } from "next/server";
import type { GmailMessageDetailDto } from "@/game/backend/contract";
import { CODES, errorResponse, handle, jsonEnvelope } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ messageId: string }> };

export async function GET(request: Request, { params }: RouteContext): Promise<NextResponse> {
  return handle(request, "gmail.messageGet", async (requestId) => {
    const { messageId } = await params;
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const connection = await db.googleConnection.findFirst({
      where: { userId: session.user.id, status: "connected" },
    });
    if (!connection) {
      return errorResponse(404, CODES.NOT_FOUND, "Message not found.", requestId);
    }

    // Scoped by connection id so a cross-user id is indistinguishable from a
    // missing one (both → 404).
    const row = await db.gmailMessage.findFirst({
      where: { id: messageId, googleConnectionId: connection.id },
    });
    if (!row) {
      return errorResponse(404, CODES.NOT_FOUND, "Message not found.", requestId);
    }

    const attachments = Array.isArray(row.attachments)
      ? (row.attachments as Array<Record<string, unknown>>).map((a) => ({
          filename: typeof a?.filename === "string" ? a.filename : "attachment",
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : "application/octet-stream",
          size: typeof a?.size === "number" ? a.size : 0,
        }))
      : [];

    const body: GmailMessageDetailDto = {
      id: row.id,
      threadId: (row.gmailThreadId as string | null) ?? null,
      sender: row.sender,
      subject: (row.subject as string | null) ?? null,
      bodyText: (row.bodyText as string | null) ?? null,
      isUnread: row.isUnread,
      receivedAt: row.internalDate.toISOString(),
      attachments,
    };
    return jsonEnvelope(200, body as unknown as Record<string, unknown>, requestId);
  });
}
