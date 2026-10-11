/**
 * /api/v1/ai/settings — B10 player AI controls (phase_b10.md §7).
 *   GET   `ai.settingsGet`   — pause flag + today's usage + configured bit.
 *   PATCH `ai.settingsUpdate` — flip the GLOBAL pause (one flag blocks
 *                               background AND manual analysis; stored
 *                               results stay readable).
 *
 * The pause is profile-scoped (AiSettings), not a B5 preference — the B5
 * six-key allowlist and version counter stay untouched. Usage is the
 * server's UTC-day counter (AiDailyUsage); the client can never set it.
 *
 * Player-scoped + strict Origin on PATCH + `general` rate class + audited
 * `ai.settings_updated` (meta: the new flag only).
 */

import { NextResponse } from "next/server";
import type { AiSettingsDto, AiSettingsUpdateDto } from "@/game/backend/contract";
import { recordAudit } from "@/lib/server/audit";
import { readAiUsage, setAnalysisPaused, type AiAnalysisDb } from "@/lib/server/aiAnalysis";
import { loadAiEnv } from "@/lib/server/aiConfig";
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
import { getDb } from "@/lib/server/prisma";
import { checkRate } from "@/lib/server/rateLimit";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

async function requireProfile(db: ReturnType<typeof getDb>, userId: string) {
  return db.playerProfile.findUnique({ where: { userId }, select: { id: true } });
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "ai.settingsGet", async (requestId) => {
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const profile = await requireProfile(db, session.user.id);
    if (!profile) {
      return errorResponse(404, CODES.NOT_FOUND, "Profile not found.", requestId);
    }

    const env = loadAiEnv();
    const now = new Date();
    const aiDb = db as unknown as AiAnalysisDb;
    const settings = await db.aiSettings.findUnique({ where: { profileId: profile.id } });
    const usage = await readAiUsage(aiDb, profile.id, now, env.dailyLimit);

    const body: AiSettingsDto = {
      paused: settings?.paused === true,
      usage,
      configured: env.configured,
    };
    return jsonEnvelope(200, body as unknown as Record<string, unknown>, requestId);
  });
}

export async function PATCH(request: Request): Promise<NextResponse> {
  return handle(request, "ai.settingsUpdate", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("general", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;

    const paused = parsed.body.paused;
    if (typeof paused !== "boolean") {
      return validationError(requestId, [{ field: "paused", message: "paused must be a boolean." }]);
    }

    const profile = await requireProfile(db, session.user.id);
    if (!profile) {
      return errorResponse(404, CODES.NOT_FOUND, "Profile not found.", requestId);
    }

    await setAnalysisPaused(db as unknown as AiAnalysisDb, profile.id, paused);

    await recordAudit(db, {
      userId: session.user.id,
      eventType: "ai.settings_updated",
      requestId,
      meta: { paused },
    });

    const body: AiSettingsUpdateDto = { paused };
    return jsonEnvelope(200, body as unknown as Record<string, unknown>, requestId);
  });
}
