/**
 * `shop.catalog` — GET /api/v1/shop (contract §4, phase_b6.md §5).
 *
 * Session-authenticated read of the canonical server catalog: ids, names,
 * prices (SERVER TRUTH), kind, and `available` (= not yet owned; every item
 * is ownable exactly once, user-confirmed at B6). `catalogVersion` is a
 * content hash so clients can detect catalog changes. READ-ONLY — the Origin
 * gate follows the B5 GET policy (`originConflicts`: absence allowed for
 * same-origin GETs, cross-origin always rejected).
 */

import { NextResponse } from "next/server";
import { buildCatalog, catalogVersion } from "@/lib/server/catalog";
import { handle, originConflicts, csrfRejected } from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "shop.catalog", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);
    if (originConflicts(request)) return csrfRejected(requestId);

    const profile = await db.playerProfile.findUnique({
      where: { userId: session.user.id },
      include: { inventoryItems: true },
    });

    const owned = new Set((profile?.inventoryItems ?? []).map((item) => item.itemId));
    return NextResponse.json({
      items: buildCatalog(owned),
      catalogVersion: catalogVersion(),
    });
  });
}
