/**
 * GET /api/v1/gmail/messages — `gmail.messagesList` (B9, contract §7.2).
 *
 * Cursor-paginated inbox list, newest-first, read from the LOCAL mirror (no
 * Gmail call here — the worker keeps the mirror fresh via reconcile-on-open).
 * Player-scoped: only the session user's connected mailbox is readable; a
 * cross-user or unknown message id is a safe 404 (contract §1.4).
 *
 * Cursor is the last message's (internalDate,id) — opaque to the client. The
 * body never carries tokens, cursors-as-provider-state, or HTML (spec §5/§9).
 */

import { NextResponse } from "next/server";
import type { GmailMessageListDto, GmailMessageSummaryDto } from "@/game/backend/contract";
import { handle, jsonEnvelope } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const PAGE_SIZE = 25;

/** Opaque cursor: base64url of `<internalDateMs>_<messageRowId>`. */
function encodeCursor(internalDateMs: number, rowId: string): string {
  return Buffer.from(`${internalDateMs}_${rowId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { internalDateMs: number; rowId: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const index = decoded.indexOf("_");
    if (index <= 0) return null;
    const ms = Number(decoded.slice(0, index));
    const rowId = decoded.slice(index + 1);
    if (!Number.isFinite(ms) || rowId === "") return null;
    return { internalDateMs: ms, rowId };
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "gmail.messagesList", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const connection = await db.googleConnection.findFirst({
      where: { userId: session.user.id, status: "connected" },
    });
    if (!connection) {
      const empty: GmailMessageListDto = { messages: [], nextCursor: null };
      return jsonEnvelope(200, empty as unknown as Record<string, unknown>, requestId);
    }

    const url = new URL(request.url);
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      const empty: GmailMessageListDto = { messages: [], nextCursor: null };
      return jsonEnvelope(200, empty as unknown as Record<string, unknown>, requestId);
    }

    const where = {
      googleConnectionId: connection.id,
      ...(cursor
        ? {
            OR: [
              { internalDate: { lt: new Date(cursor.internalDateMs) } },
              { internalDate: new Date(cursor.internalDateMs), id: { lt: cursor.rowId } },
            ],
          }
        : {}),
    };
    const rows = await db.gmailMessage.findMany({
      where,
      // Newest-first, stable tie-break by row id (contract §1.5 ordering).
      orderBy: [{ internalDate: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1, // one extra to detect a next page
    });

    const page = rows.slice(0, PAGE_SIZE);
    const hasMore = rows.length > PAGE_SIZE;
    const last = page[page.length - 1];

    const messages: GmailMessageSummaryDto[] = page.map((row) => {
      const attachments = Array.isArray(row.attachments) ? row.attachments : [];
      return {
        id: row.id,
        threadId: (row.gmailThreadId as string | null) ?? null,
        sender: row.sender,
        subject: (row.subject as string | null) ?? null,
        snippet: (row.snippet as string | null) ?? null,
        isUnread: row.isUnread,
        receivedAt: row.internalDate.toISOString(),
        hasAttachments: attachments.length > 0,
        attachmentCount: attachments.length,
      };
    });

    const body: GmailMessageListDto = {
      messages,
      nextCursor:
        hasMore && last ? encodeCursor(last.internalDate.getTime(), last.id) : null,
    };
    return jsonEnvelope(200, body as unknown as Record<string, unknown>, requestId);
  });
}
