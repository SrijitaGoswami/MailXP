/**
 * /api/v1/ai/analysis/{messageId} — B10 advisory analysis (phase_b10.md §7).
 *   GET    `ai.analysisGet`  — current analysis for one owned message.
 *   POST   `ai.analysisStart` — manual Analyze/Retry (durable job enqueue).
 *
 * GET returns `not_analyzed` (200) when the message is owned but has no row
 * yet — the UI offers Analyze. A foreign/absent message is a safe 404
 * (contract §1.4: existence is never disclosed).
 *
 * POST never calls the provider inline: it re-checks ownership + connection,
 * refuses while paused (409 AI_PAUSED) or over the daily cap (409
 * AI_LIMIT_REACHED), then enqueues the coalesced durable `ai.analysis` job.
 * The worker owns the provider call, budget reservation, and validation.
 *
 * Player-scoped + strict Origin + `general` rate class + audited
 * `ai.analysis_requested` (meta: messageId only — never content).
 */

import { NextResponse } from "next/server";
import type { AiAnalysisStartDto } from "@/game/backend/contract";
import { recordAudit } from "@/lib/server/audit";
import {
  enqueueAnalysisJob,
  isAnalysisPaused,
  readAiUsage,
  readOwnedAnalysis,
  type AiAnalysisDb,
} from "@/lib/server/aiAnalysis";
import { loadAiEnv } from "@/lib/server/aiConfig";
import {
  CODES,
  csrfRejected,
  errorResponse,
  handle,
  jsonEnvelope,
  originMismatch,
  rateLimitedResponse,
} from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { type QueueDb } from "@/lib/server/jobQueue";
import { checkRate } from "@/lib/server/rateLimit";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ messageId: string }> };

export async function GET(request: Request, { params }: RouteContext): Promise<NextResponse> {
  return handle(request, "ai.analysisGet", async (requestId) => {
    const { messageId } = await params;
    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const analysis = await readOwnedAnalysis(db as unknown as AiAnalysisDb, {
      userId: session.user.id,
      messageId,
    });
    if (!analysis) {
      return errorResponse(404, CODES.NOT_FOUND, "Message not found.", requestId);
    }
    return jsonEnvelope(200, { analysis } as unknown as Record<string, unknown>, requestId);
  });
}

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  return handle(request, "ai.analysisStart", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);
    const { messageId } = await params;

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return sessionErrorResponse(session.reason, requestId);

    const rate = checkRate("general", session.user.id);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    // Ownership + connected-mailbox re-check (the browser cannot pick a
    // foreign message or a released mailbox).
    const message = await db.gmailMessage.findUnique({
      where: { id: messageId },
      include: { googleConnection: { select: { id: true, userId: true, status: true } } },
    });
    if (!message || message.googleConnection.userId !== session.user.id) {
      return errorResponse(404, CODES.NOT_FOUND, "Message not found.", requestId);
    }
    if (message.googleConnection.status !== "connected") {
      return errorResponse(404, CODES.NOT_FOUND, "Message not found.", requestId);
    }

    const profile = await db.playerProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!profile) {
      return errorResponse(404, CODES.NOT_FOUND, "Message not found.", requestId);
    }

    const env = loadAiEnv();
    const now = new Date();
    const aiDb = db as unknown as AiAnalysisDb;

    // Global pause blocks player-triggered analysis too (spec §3.3) — honest
    // 409, no job, no budget reserved.
    if (await isAnalysisPaused(aiDb, profile.id)) {
      return errorResponse(409, CODES.AI_PAUSED, "AI analysis is paused in settings.", requestId);
    }

    // Daily cap re-checked at request time (the worker re-checks again at
    // execution time; a request cannot schedule over-budget work).
    const usage = await readAiUsage(aiDb, profile.id, now, env.dailyLimit);
    if (usage.used >= usage.cap) {
      return errorResponse(409, CODES.AI_LIMIT_REACHED, "Today's AI analysis limit is reached.", requestId);
    }

    // Missing provider config fails CLOSED at enqueue time too — the UI can
    // say "not configured" instead of queueing jobs that would dead-letter.
    if (!env.configured) {
      return errorResponse(503, CODES.SERVICE_UNAVAILABLE, "AI analysis is not configured.", requestId);
    }

    await enqueueAnalysisJob(db as unknown as AiAnalysisDb & QueueDb, { messageId });

    await recordAudit(db, {
      userId: session.user.id,
      eventType: "ai.analysis_requested",
      requestId,
      meta: { messageId, trigger: "manual" },
    });

    const analysis = await readOwnedAnalysis(aiDb, { userId: session.user.id, messageId });
    const body: AiAnalysisStartDto = { analysis: analysis! };
    return jsonEnvelope(202, body as unknown as Record<string, unknown>, requestId);
  });
}
