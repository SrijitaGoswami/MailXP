/**
 * `game.preferencesUpdate` — PATCH /api/v1/game/preferences (contract §3,
 * phase_b5.md §7).
 *
 * Scope: the six-key allowlist ONLY (masterVolume, uiVolume, gameVolume,
 * muted, motion, touchControls). Balance, inventory, outfit, decor, owner id
 * and arbitrary profile fields are rejected (400 VALIDATION_ERROR) — they
 * have no route until B6+. Unknown keys are rejected too (contract line:
 * "400 (unknown key rejected)").
 *
 * Concurrency (contract §1.7): the caller sends `expectedVersion`; the write
 * is an ATOMIC conditional update (updateMany WHERE version = expected), so
 * concurrent writers can never silently overwrite newer state. A lost race →
 * 409 STALE_VERSION carrying the current version in safe details.
 *
 * Order: Origin gate (before any work) → session → general per-player rate →
 * body. After the commit, `profile.updated {version}` is published to that
 * player's SSE streams (contract §3: state changes are emitted as SSE after
 * commit). No audit rows: none of the six preferences are security-relevant
 * (contract: "audit only on security-relevant prefs").
 */

import { NextResponse } from "next/server";
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
import {
  coercePreferences,
  mergePreferences,
  validatePreferencesPatch,
} from "@/lib/server/preferences";
import { getDb } from "@/lib/server/prisma";
import { checkRate } from "@/lib/server/rateLimit";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";
import { publishSse } from "@/lib/server/sseHub";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request): Promise<NextResponse> {
  return handle(request, "game.preferencesUpdate", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("general", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;

    const expected = parsed.body.expectedVersion;
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
      return validationError(requestId, [
        { field: "expectedVersion", message: "expectedVersion must be a positive integer." },
      ]);
    }
    const validated = validatePreferencesPatch(parsed.body.preferences);
    if (!validated.ok) return validationError(requestId, validated.errors);

    const profile = await db.playerProfile.findUnique({ where: { userId: session.user.id } });
    if (!profile) {
      return errorResponse(404, CODES.NOT_FOUND, "Profile not found.", requestId);
    }

    const merged = mergePreferences(coercePreferences(profile.prefs), validated.patch);

    // Atomic conditional write: exactly one concurrent writer can win.
    const outcome = await db.playerProfile.updateMany({
      where: { id: profile.id, version: expected },
      data: { prefs: merged, version: { increment: 1 } },
    });

    if (outcome.count === 0) {
      const current = await db.playerProfile.findUnique({
        where: { id: profile.id },
        select: { version: true },
      });
      if (!current) {
        return errorResponse(404, CODES.NOT_FOUND, "Profile not found.", requestId);
      }
      return errorResponse(
        409,
        CODES.STALE_VERSION,
        "Profile version is stale. Refetch state and retry.",
        requestId,
        [
          {
            field: "expectedVersion",
            message: "expectedVersion does not match the current profile version.",
            currentVersion: current.version,
          },
        ],
      );
    }

    const fresh = await db.playerProfile.findUnique({ where: { id: profile.id } });
    const version = fresh ? fresh.version : expected + 1;
    const preferences = fresh ? coercePreferences(fresh.prefs) : merged;

    // Emitted only AFTER the committed write (phase §9).
    publishSse(session.user.id, "profile.updated", { version });

    return NextResponse.json({ preferences, version });
  });
}
