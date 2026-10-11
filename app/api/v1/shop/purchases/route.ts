/**
 * `shop.purchase` — POST /api/v1/shop/purchases (contract §4, phase_b6.md §6).
 *
 * The only money-moving route of B6. Order (B5 pattern + §1.6 additions):
 * Origin gate (strict — absent Origin is a mismatch on non-GET) → session →
 * per-player rate → REQUIRED `Idempotency-Key` (UUID) → strict body
 * ({ itemId, expectedVersion } only, unknown keys rejected) → profile →
 * idempotency reserve (replay / mismatch / in-progress resolved BEFORE any
 * execution) → atomic `purchaseShopItem` transaction (deduct, grant, ledger,
 * audit AND the replayable 2xx idempotency outcome commit together) → SSE
 * `economy.updated` + `profile.updated` after commit → 201.
 *
 * Rejections (404 unknown item · 409 CONFLICT already owned · 409
 * STALE_VERSION · 409 INSUFFICIENT_FUNDS) all carry the authoritative
 * balance/version in safe `details` (contract §4: "Rejection MUST include
 * current authoritative state (balance/version) so the optimistic client UI
 * can roll back") and RELEASE the reservation so an honest retry can
 * re-execute (no stored result exists for a failure).
 *
 * The `economy.purchase` audit row is written inside the purchase transaction
 * (contract §4 side effect) — no PII, only item id/price/transaction id.
 */

import { NextResponse } from "next/server";
import {
  CODES,
  csrfRejected,
  errorResponse,
  handle,
  jsonEnvelope,
  originMismatch,
  rateLimitedResponse,
  readJsonObject,
  validationError,
} from "@/lib/server/http";
import {
  purchaseShopItem,
  type EconomyDb,
  type PurchaseOutcome,
} from "@/lib/server/economy";
import {
  beginIdempotency,
  ENDPOINT_SHOP_PURCHASE,
  isValidIdempotencyKey,
  releaseIdempotency,
  requestFingerprint,
  type IdempotencyDb,
} from "@/lib/server/idempotency";
import { getDb } from "@/lib/server/prisma";
import { checkRate } from "@/lib/server/rateLimit";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";
import { publishSse } from "@/lib/server/sseHub";

export const dynamic = "force-dynamic";

const ALLOWED_BODY_KEYS = new Set(["itemId", "expectedVersion"]);

/** Map a rejection to the B1 envelope with authoritative state in details. */
function rejectionResponse(outcome: Extract<PurchaseOutcome, { ok: false }>, requestId: string): NextResponse {
  const state = {
    ...(outcome.currentVersion !== undefined ? { currentVersion: outcome.currentVersion } : {}),
    ...(outcome.balance !== undefined ? { currentBalance: outcome.balance } : {}),
  };
  switch (outcome.reason) {
    case "NOT_FOUND":
      return errorResponse(404, CODES.NOT_FOUND, "Unknown shop item.", requestId);
    case "ALREADY_OWNED":
      return errorResponse(409, CODES.CONFLICT, "Item already owned.", requestId, [
        { field: "itemId", message: "This item is already in your inventory.", ...state },
      ]);
    case "STALE_VERSION":
      return errorResponse(
        409,
        CODES.STALE_VERSION,
        "Profile version is stale. Refetch state and retry.",
        requestId,
        [
          {
            field: "expectedVersion",
            message: "expectedVersion does not match the current profile version.",
            ...state,
          },
        ],
      );
    case "INSUFFICIENT_FUNDS":
      return errorResponse(409, CODES.INSUFFICIENT_FUNDS, "Not enough DraftCoin for this purchase.", requestId, [
        { field: "draftCoin", message: "Authoritative balance does not cover the item price.", ...state },
      ]);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "shop.purchase", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("general", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    // Contract §1.6: the header is REQUIRED for this endpoint and must be a UUID.
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return validationError(requestId, [
        { field: "Idempotency-Key", message: "Idempotency-Key header (UUID) is required." },
      ]);
    }

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;

    for (const key of Object.keys(parsed.body)) {
      if (!ALLOWED_BODY_KEYS.has(key)) {
        return validationError(requestId, [{ field: key, message: "Unknown field." }]);
      }
    }
    const itemId = parsed.body.itemId;
    const expectedVersion = parsed.body.expectedVersion;
    if (typeof itemId !== "string" || itemId.length === 0) {
      return validationError(requestId, [{ field: "itemId", message: "itemId must be a non-empty string." }]);
    }
    if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return validationError(requestId, [
        { field: "expectedVersion", message: "expectedVersion must be a positive integer." },
      ]);
    }

    const profile = await db.playerProfile.findUnique({ where: { userId: session.user.id } });
    if (!profile) {
      return errorResponse(404, CODES.NOT_FOUND, "Profile not found.", requestId);
    }

    // Reserve the key BEFORE executing (contract §1.6): replay, mismatch and
    // concurrent in-progress requests are resolved here without side effects.
    const fingerprint = requestFingerprint(ENDPOINT_SHOP_PURCHASE, parsed.body);
    const begin = await beginIdempotency(db as unknown as IdempotencyDb, {
      profileId: profile.id,
      endpoint: ENDPOINT_SHOP_PURCHASE,
      key: idempotencyKey,
      fingerprint,
    });

    if (begin.kind === "MISMATCH") {
      return errorResponse(
        409,
        CODES.IDEMPOTENCY_MISMATCH,
        "Idempotency-Key was already used with a different request.",
        requestId,
      );
    }
    if (begin.kind === "IN_PROGRESS") {
      return errorResponse(
        409,
        CODES.IDEMPOTENCY_IN_PROGRESS,
        "The first request with this Idempotency-Key is still executing.",
        requestId,
      );
    }
    if (begin.kind === "REPLAY") {
      // Same key + same fingerprint → the stored 2xx result, not a re-run.
      const summary =
        begin.summary && typeof begin.summary === "object"
          ? (begin.summary as Record<string, unknown>)
          : {};
      return jsonEnvelope(begin.httpStatus, summary, requestId);
    }

    // Atomic: conditional deduction + inventory grant + ledger row + audit +
    // idempotency outcome (phase_b6 §6: one transaction, all-or-nothing).
    const outcome = await purchaseShopItem(db as unknown as EconomyDb, {
      profileId: profile.id,
      itemId,
      expectedVersion,
      requestId,
      userId: session.user.id,
      idempotency: { endpoint: ENDPOINT_SHOP_PURCHASE, key: idempotencyKey },
    });

    if (!outcome.ok) {
      await releaseIdempotency(db as unknown as IdempotencyDb, {
        profileId: profile.id,
        endpoint: ENDPOINT_SHOP_PURCHASE,
        key: idempotencyKey,
      });
      return rejectionResponse(outcome, requestId);
    }

    const body = {
      transactionId: outcome.transactionId,
      itemId: outcome.itemId,
      balance: outcome.balance,
      version: outcome.version,
    };

    // Emitted only AFTER the committed write (phase §9 / contract §5).
    // The idempotency outcome was already stored inside the transaction.
    publishSse(session.user.id, "economy.updated", {
      balance: outcome.balance,
      reason: "purchase",
      version: outcome.version,
    });
    publishSse(session.user.id, "profile.updated", { version: outcome.version });

    return jsonEnvelope(201, body, requestId);
  });
}
