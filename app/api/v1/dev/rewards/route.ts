/**
 * `dev.reward_fixture` — POST /api/v1/dev/rewards (development-only fixture,
 * user-approved at B6).
 *
 * WHY IT EXISTS: no provider-verified qualifying action exists until B11, so
 * without a fixture every fresh server account stays at 0 DraftCoin and the
 * shop is unaffordable. The contract explicitly allows "development-only
 * fixtures per B6 scope" (§4) — this route issues ONE quest_reward through
 * the SAME atomic `issueQuestReward` service B11 will use: fixed amount, UTC
 * daily cap, ledger row, version bump, SSE notify. Nothing is special-cased.
 *
 * PRODUCTION: blocked with 404 before any work (same NODE_ENV gate family as
 * B4's devDelivery) — the route does not exist as far as a prod client knows.
 *
 * Idempotency-Key (UUID) is REQUIRED, mirroring the phase plan's
 * "idempotency keys on reward/purchase requests" so the reward path's shape
 * is settled before B11: replay returns the stored outcome instead of
 * issuing twice; the daily cap is a second, independent guard.
 */

import { NextResponse } from "next/server";
import { issueQuestReward, type EconomyDb } from "@/lib/server/economy";
import {
  CODES,
  csrfRejected,
  errorResponse,
  handle,
  jsonEnvelope,
  originMismatch,
  rateLimitedResponse,
  validationError,
} from "@/lib/server/http";
import {
  beginIdempotency,
  isValidIdempotencyKey,
  releaseIdempotency,
  requestFingerprint,
  type IdempotencyDb,
} from "@/lib/server/idempotency";
import { getDb } from "@/lib/server/prisma";
import { checkRate } from "@/lib/server/rateLimit";
import { isProduction, loadSession, sessionErrorResponse } from "@/lib/server/session";
import { publishSse } from "@/lib/server/sseHub";

export const dynamic = "force-dynamic";

/** Endpoint scope for idempotency (per player + endpoint, contract §1.6). */
const ENDPOINT_REWARD_FIXTURE = "dev.reward_fixture";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "dev.reward_fixture", async (requestId) => {
    // Production gate FIRST: 404, no session/rate/work — indistinguishable
    // from a route that simply does not exist.
    if (isProduction()) {
      return errorResponse(404, CODES.NOT_FOUND, "Not found.", requestId);
    }
    if (originMismatch(request)) return csrfRejected(requestId);

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("general", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const idempotencyKey = request.headers.get("idempotency-key");
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return validationError(requestId, [
        { field: "Idempotency-Key", message: "Idempotency-Key header (UUID) is required." },
      ]);
    }

    const profile = await db.playerProfile.findUnique({ where: { userId: session.user.id } });
    if (!profile) {
      return errorResponse(404, CODES.NOT_FOUND, "Profile not found.", requestId);
    }

    // The fixture takes no parameters — the fingerprint covers the endpoint only.
    const fingerprint = requestFingerprint(ENDPOINT_REWARD_FIXTURE, null);
    const begin = await beginIdempotency(db as unknown as IdempotencyDb, {
      profileId: profile.id,
      endpoint: ENDPOINT_REWARD_FIXTURE,
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
      const summary =
        begin.summary && typeof begin.summary === "object"
          ? (begin.summary as Record<string, unknown>)
          : {};
      return jsonEnvelope(begin.httpStatus, summary, requestId);
    }

    let outcome;
    try {
      outcome = await issueQuestReward(db as unknown as EconomyDb, {
        profileId: profile.id,
        reason: "dev.fixture",
        // Outcome (granted OR capped) is completed inside the transaction —
        // same all-or-nothing semantics as shop.purchase (phase_b6 §6.9).
        idempotency: { endpoint: ENDPOINT_REWARD_FIXTURE, key: idempotencyKey },
      });
    } catch (error) {
      await releaseIdempotency(db as unknown as IdempotencyDb, {
        profileId: profile.id,
        endpoint: ENDPOINT_REWARD_FIXTURE,
        key: idempotencyKey,
      });
      throw error;
    }
    if (!outcome) {
      await releaseIdempotency(db as unknown as IdempotencyDb, {
        profileId: profile.id,
        endpoint: ENDPOINT_REWARD_FIXTURE,
        key: idempotencyKey,
      });
      return errorResponse(404, CODES.NOT_FOUND, "Profile not found.", requestId);
    }

    const body = {
      awarded: outcome.awarded,
      capped: outcome.capped,
      balance: outcome.balance,
      version: outcome.version,
    };

    // Only real state changes notify (capped = no mutation, no event). The
    // idempotency outcome was stored inside the issuing transaction.
    if (outcome.awarded > 0) {
      publishSse(session.user.id, "economy.updated", {
        balance: outcome.balance,
        reason: "reward",
        version: outcome.version,
      });
      publishSse(session.user.id, "profile.updated", { version: outcome.version });
    }

    return jsonEnvelope(200, body, requestId);
  });
}
