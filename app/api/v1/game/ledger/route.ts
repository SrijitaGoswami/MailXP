/**
 * `game.ledger` — GET /api/v1/game/ledger?limit=&cursor= (contract §3,
 * phase_b5.md §8).
 *
 * Caller-owned entries only: the profile is resolved from the session, so
 * another player's rows are unreachable (404/401 policy — there is nothing to
 * cross-reference). Cursor pagination per §1.5: limit default 25 / max 100,
 * opaque cursor, ordering createdAt DESC with id DESC, { items, nextCursor }
 * (null = end). Unsupported query parameters → 400 (§1.5 filter whitelist).
 *
 * DATA NOTE (user decision at B5): the LedgerEntry table exists from B5 so
 * these are real paginated reads — the list is simply EMPTY until B6 starts
 * writing reward/purchase rows. No entries are faked, invented, or derived
 * from localStorage, and there is no write route (B6 scope).
 */

import { NextResponse } from "next/server";
import {
  decodeCursor,
  encodeCursor,
  parseLimit,
  type LedgerCursor,
} from "@/lib/server/gameState";
import { handle, validationError } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const ALLOWED_PARAMS = new Set(["limit", "cursor"]);

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "game.ledger", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_PARAMS.has(key)) {
        return validationError(requestId, [
          { field: key, message: "Unsupported query parameter." },
        ]);
      }
    }

    const limit = parseLimit(url.searchParams.get("limit"));
    if (limit === null) {
      return validationError(requestId, [
        { field: "limit", message: "limit must be an integer between 1 and 100." },
      ]);
    }

    let cursor: LedgerCursor | null = null;
    const cursorRaw = url.searchParams.get("cursor");
    if (cursorRaw !== null) {
      cursor = decodeCursor(cursorRaw);
      if (cursor === null) {
        return validationError(requestId, [{ field: "cursor", message: "Malformed cursor." }]);
      }
    }

    const profile = await db.playerProfile.findUnique({ where: { userId: session.user.id } });
    if (!profile) {
      // Anomaly path (B4 always creates the row): no profile → no entries.
      return NextResponse.json({ items: [], nextCursor: null });
    }

    const rows = await db.ledgerEntry.findMany({
      where: {
        profileId: profile.id,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1, // one extra row detects a next page without guessing
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) => ({
      id: row.id,
      type: row.type,
      amount: row.amount,
      reason: row.reason,
      sourceRef: row.sourceRef,
      createdAt: row.createdAt.toISOString(),
    }));

    return NextResponse.json({
      items,
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
    });
  });
}
