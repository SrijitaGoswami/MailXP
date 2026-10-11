/**
 * AI analysis domain (Phase B10, phase_b10.md §3 + §7).
 *
 * The durable `ai.analysis` job handler plus the accounting/eligibility
 * services the API routes use. Server-only; the provider is injected
 * (GeminiGenerateFn) so unit tests never touch the live API.
 *
 * Consistency model:
 *   - one CURRENT EmailAnalysis row per message (unique gmailMessageId);
 *   - idempotency = (contentFingerprint, schemaVersion, modelId): a matching
 *     ready/limited row makes a redelivered job a no-op that consumes NO
 *     usage unit (spec §3.3);
 *   - a usage unit is RESERVED with an atomic conditional increment BEFORE
 *     the provider call and RELEASED on failure, so only success bills and
 *     two racing jobs cannot both slip under the cap;
 *   - every write is guarded (fingerprint / ownership / status) so a stale
 *     job can never overwrite a newer result (spec §7);
 *   - pause and daily-cap waits DEFER the job (no retry burn) so the queue
 *     drains oldest-first on resume (spec §3.3).
 */

import type { Prisma } from "@prisma/client";
import {
  loadAiEnv,
  type AiEnv,
} from "@/lib/server/aiConfig";
import {
  ANALYSIS_SCHEMA_VERSION,
  AiValidationError,
  buildUserContent,
  isAiCategory,
  isAiPriority,
  parseAnalysisText,
  prepareAnalysisInput,
  SYSTEM_INSTRUCTION,
  type AiCategoryValue,
  type AiPriorityValue,
  type ValidatedAnalysis,
} from "@/lib/server/aiSchema";
import {
  classifyGeminiError,
  createGeminiGenerate,
  GeminiApiError,
  type GeminiGenerateFn,
} from "@/lib/server/geminiApi";
import { nextUtcReset, utcDayStart } from "@/lib/server/economy";
import {
  deferJob,
  enqueueJob,
  JobDeferredError,
  PermanentJobError,
  MAX_ATTEMPTS,
  requeueDeadJob,
  type QueueDb,
} from "@/lib/server/jobQueue";
import { logger } from "@/lib/server/logger";

export const AI_JOB_TYPE = "ai.analysis";
export const AI_OUTBOX_EVENT = "ai.analysis_requested";
export const AI_DEDUPE_PREFIX = "ai.analysis:";
/** Policy-wait wake-up: pause re-checks every 30 s; cap waits until UTC reset. */
export const AI_PAUSE_DEFER_MS = 30_000;
/** Auto-enqueue bound per sync run (documented in B10_REPORT.md). */
export const AUTO_ENQUEUE_MAX = 25;

// ---------------------------------------------------------------------------
// Database surface (structural — real PrismaClient and the test fake both fit).
// ---------------------------------------------------------------------------

export interface AiSettingsRow {
  id: string;
  profileId: string;
  paused: boolean;
}

export interface EmailAnalysisRow {
  id: string;
  gmailMessageId: string;
  googleConnectionId: string;
  profileId: string;
  status: string;
  contentFingerprint: string;
  schemaVersion: number;
  modelId: string;
  category: string | null;
  priority: string | null;
  summary: string | null;
  result: unknown;
  limited: boolean;
  usageConsumed: boolean;
  errorClass: string | null;
  analyzedAt: Date | null;
  updatedAt: Date;
}

export interface AiMessageRow {
  id: string;
  googleConnectionId: string;
  sender: string;
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  internalDate: Date;
  labels: unknown;
  googleConnection: { id: string; userId: string; status: string };
}

type TxLike = Prisma.TransactionClient;

export interface AiAnalysisDb {
  // Queue access: the handler defers its own claimed job (pause/cap waits).
  job: QueueDb["job"];
  aiSettings: {
    findUnique(args: { where: { profileId: string } }): Promise<AiSettingsRow | null>;
    upsert(args: {
      where: { profileId: string };
      create: { profileId: string; paused: boolean };
      update: { paused: boolean };
    }): Promise<AiSettingsRow>;
  };
  aiDailyUsage: {
    findUnique(args: { where: { profileId_dayUtc: { profileId: string; dayUtc: Date } } }): Promise<{ units: number } | null>;
    upsert(args: {
      where: { profileId_dayUtc: { profileId: string; dayUtc: Date } };
      create: { profileId: string; dayUtc: Date; units: number };
      update: { units: { increment: number } };
    }): Promise<{ units: number }>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  emailAnalysis: {
    findUnique(args: { where: { gmailMessageId: string } }): Promise<EmailAnalysisRow | null>;
    findFirst(args: { where: Record<string, unknown> }): Promise<EmailAnalysisRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<EmailAnalysisRow>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  gmailMessage: {
    findUnique(args: {
      where: { id: string };
      include: { googleConnection: { select: { id: true; userId: true; status: true } } };
    }): Promise<AiMessageRow | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
  playerProfile: {
    findUnique(args: { where: { userId: string }; select: { id: true } }): Promise<{ id: string } | null>;
  };
  $transaction<T>(fn: (tx: TxLike) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Settings + usage services (also used by the API routes).
// ---------------------------------------------------------------------------

export async function isAnalysisPaused(db: AiAnalysisDb, profileId: string): Promise<boolean> {
  const row = await db.aiSettings.findUnique({ where: { profileId } });
  return row?.paused === true;
}

export async function setAnalysisPaused(db: AiAnalysisDb, profileId: string, paused: boolean): Promise<void> {
  await db.aiSettings.upsert({
    where: { profileId },
    create: { profileId, paused },
    update: { paused },
  });
}

export interface AiUsageStatus {
  used: number;
  cap: number;
  resetsAtUtc: string;
}

export async function readAiUsage(db: AiAnalysisDb, profileId: string, now: Date, cap: number): Promise<AiUsageStatus> {
  const day = utcDayStart(now);
  const row = await db.aiDailyUsage.findUnique({
    where: { profileId_dayUtc: { profileId, dayUtc: day } },
  });
  return {
    used: row?.units ?? 0,
    cap,
    resetsAtUtc: nextUtcReset(now).toISOString(),
  };
}

/**
 * Atomically reserve one daily unit for today (UTC). Conditional increment
 * inside the updateMany predicate means two concurrent reservations cannot
 * both land under the cap — the loser matches 0 rows (same pattern as B6's
 * conditional balance deduction).
 */
export async function reserveAiUnit(db: AiAnalysisDb, profileId: string, now: Date, cap: number): Promise<boolean> {
  const day = utcDayStart(now);
  const res = await db.aiDailyUsage.updateMany({
    where: { profileId, dayUtc: day, units: { lt: cap } },
    data: { units: { increment: 1 } },
  });
  if (res.count === 1) return true;
  // No row for today yet: create one only if the cap allows (cap >= 1).
  const existing = await db.aiDailyUsage.findUnique({
    where: { profileId_dayUtc: { profileId, dayUtc: day } },
  });
  if (existing !== null) return false; // row exists but is at/over cap
  if (cap < 1) return false;
  try {
    await db.aiDailyUsage.upsert({
      where: { profileId_dayUtc: { profileId, dayUtc: day } },
      create: { profileId, dayUtc: day, units: 1 },
      update: { units: { increment: 1 } }, // lost the race — still counts once
    });
    const after = await db.aiDailyUsage.findUnique({
      where: { profileId_dayUtc: { profileId, dayUtc: day } },
    });
    return (after?.units ?? 0) <= cap;
  } catch {
    return false;
  }
}

/** Give a reserved unit back (analysis did not succeed). */
export async function releaseAiUnit(db: AiAnalysisDb, profileId: string, now: Date): Promise<void> {
  const day = utcDayStart(now);
  await db.aiDailyUsage.updateMany({
    where: { profileId, dayUtc: day, units: { gt: 0 } },
    data: { units: { decrement: 1 } },
  });
}

// ---------------------------------------------------------------------------
// Enqueue helpers.
// ---------------------------------------------------------------------------

export interface EnqueueAnalysisInput {
  messageId: string;
  availableAt?: Date;
}

/**
 * Ensure a queued analysis row exists for the message and enqueue the
 * coalesced durable job. Called by the manual Analyze route; the auto path
 * (gmail.sync) writes an outbox event instead so the job is created by the
 * relay in the usual B7 flow. Returns false when the message is not owned by
 * a connected mailbox (the route maps that to 404 before calling).
 */
export async function enqueueAnalysisJob(
  db: AiAnalysisDb & QueueDb,
  input: EnqueueAnalysisInput,
): Promise<void> {
  const message = await db.gmailMessage.findUnique({
    where: { id: input.messageId },
    include: { googleConnection: { select: { id: true, userId: true, status: true } } },
  });
  if (!message || message.googleConnection.status !== "connected") return;

  const profile = await db.playerProfile.findUnique({
    where: { userId: message.googleConnection.userId },
    select: { id: true },
  });
  if (!profile) return;

  const existing = await db.emailAnalysis.findUnique({ where: { gmailMessageId: input.messageId } });
  if (!existing) {
    await db.emailAnalysis.create({
      data: {
        gmailMessageId: input.messageId,
        googleConnectionId: message.googleConnectionId,
        profileId: profile.id,
        status: "queued",
        contentFingerprint: "",
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
      },
    });
  } else if (existing.status === "failed" || existing.status === "stale") {
    await db.emailAnalysis.updateMany({
      where: { id: existing.id, status: existing.status },
      data: { status: "queued", errorClass: null },
    });
  }

  // Direct durable enqueue. The unique dedupeKey collapses live repeats
  // (pending/running coalesce). A SUCCEEDED job is requeued in place by
  // enqueueJob (latent B9 fix) so re-analysis works. A DEAD job is revived
  // here (manual Analyze/Retry is the player's explicit dead-letter recovery
  // for AI; gmail.sync keeps its own manual path).
  const dedupeKey = `${AI_DEDUPE_PREFIX}${input.messageId}`;
  const enqueued = await enqueueJob(db, {
    jobType: AI_JOB_TYPE,
    payload: { messageId: input.messageId },
    dedupeKey,
    ...(input.availableAt ? { availableAt: input.availableAt } : {}),
  });
  if (!enqueued.created) {
    const job = await db.job.findUnique({ where: { id: enqueued.jobId } });
    if (job?.status === "dead") {
      await requeueDeadJob(db, {
        jobId: job.id,
        now: input.availableAt ?? new Date(),
        resetAttempts: true,
      });
    }
  }
}

/**
 * Auto-enqueue (called INSIDE the gmail.sync commit transaction): oldest
 * imported messages first, bounded per run. Writes an outbox event per
 * message so the relay creates the job — payload carries the internal row id
 * only, never content (spec §5).
 */
export async function appendAnalysisEventsForMessages(
  tx: { outboxEvent: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> } },
  messageIds: string[],
): Promise<number> {
  let appended = 0;
  for (const messageId of messageIds.slice(0, AUTO_ENQUEUE_MAX)) {
    await tx.outboxEvent.create({
      data: {
        eventType: AI_OUTBOX_EVENT,
        payload: { messageId },
      },
    });
    appended += 1;
  }
  return appended;
}

// ---------------------------------------------------------------------------
// Job handler.
// ---------------------------------------------------------------------------

export interface AiJobContext {
  jobId: string;
  attempts: number;
  /** Worker claim owner — required to defer the job (pause/cap waits). */
  leaseOwner?: string;
}

export interface AiJobOptions {
  /** Injected provider; defaults to the SDK-backed implementation. */
  generate?: GeminiGenerateFn;
  env?: AiEnv;
  now?: () => Date;
}

interface AnalysisJobPayload {
  messageId: string;
}

function parsePayload(payload: unknown): AnalysisJobPayload {
  const messageId = (payload as { messageId?: unknown } | null | undefined)?.messageId;
  if (typeof messageId !== "string" || messageId.length === 0) {
    throw new PermanentJobError("validation", "ai.analysis: payload requires messageId");
  }
  return { messageId };
}

/**
 * The `ai.analysis` job handler. Re-checks ownership, connection status,
 * pause, daily cap, and fingerprint AT EXECUTION TIME (spec §3.1/§3.3) — the
 * browser can never influence any of them.
 */
export async function runAiAnalysis(
  db: AiAnalysisDb,
  payload: unknown,
  ctx: AiJobContext,
  options: AiJobOptions = {},
): Promise<void> {
  const { messageId } = parsePayload(payload);
  const env = options.env ?? loadAiEnv();
  const now = options.now ?? (() => new Date());
  const generate = options.generate ?? createGeminiGenerate();

  const message = await db.gmailMessage.findUnique({
    where: { id: messageId },
    include: { googleConnection: { select: { id: true, userId: true, status: true } } },
  });
  // Message vanished (deleted mailbox / account erasure): idempotent no-op.
  if (!message) return;
  // Ownership/connection re-check at execution time: a released, deleted, or
  // transferred mailbox must never be analyzed (spec §3.1). Terminal — a
  // reconnect re-enqueues via the inbox or the next sync.
  if (message.googleConnection.status !== "connected") {
    throw new PermanentJobError("not_requested", "ai.analysis: mailbox no longer connected");
  }

  const profile = await db.playerProfile.findUnique({
    where: { userId: message.googleConnection.userId },
    select: { id: true },
  });
  if (!profile) return;

  const prepared = prepareAnalysisInput(message, env.inputMaxChars);

  const ensureRow = async (): Promise<EmailAnalysisRow> => {
    const existing = await db.emailAnalysis.findUnique({ where: { gmailMessageId: messageId } });
    if (existing) return existing;
    return db.emailAnalysis.create({
      data: {
        gmailMessageId: messageId,
        googleConnectionId: message.googleConnectionId,
        profileId: profile.id,
        status: "queued",
        contentFingerprint: prepared.fingerprint,
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        modelId: env.model,
        limited: prepared.limited,
      },
    });
  };
  const row = await ensureRow();

  // Idempotent redelivery: a matching current result consumes nothing.
  if (
    (row.status === "ready" || row.status === "limited") &&
    row.contentFingerprint === prepared.fingerprint &&
    row.schemaVersion === ANALYSIS_SCHEMA_VERSION &&
    row.modelId === env.model
  ) {
    logger.info("ai.analysis.ok", { jobId: ctx.jobId, outcome: "idempotent" });
    return;
  }

  // Missing provider config fails CLOSED (spec §6): honest failed state, no
  // retry storm, inbox/sync unaffected. A later Retry after configuration
  // works because the row is re-queued by the route.
  if (!env.configured) {
    await db.emailAnalysis.updateMany({
      where: { id: row.id, gmailMessageId: messageId },
      data: { status: "failed", errorClass: "config", contentFingerprint: prepared.fingerprint, modelId: env.model },
    });
    logger.warn("ai.analysis.skip", { jobId: ctx.jobId, errorClass: "config" });
    return;
  }

  // Global pause blocks scheduling (spec §3.3) — defer without burning an
  // attempt so the queue drains oldest-first on resume. In-flight work may
  // finish, but the re-check happens BEFORE the provider call.
  if (await isAnalysisPaused(db, profile.id)) {
    await deferOrWait(db, ctx, new Date(now().getTime() + AI_PAUSE_DEFER_MS), "paused");
    return;
  }

  // Reserve the daily unit unless a prior attempt of THIS analysis already
  // did (usageConsumed guard = no double-billing on retry, spec §3.3).
  let reservedNow = false;
  if (!row.usageConsumed) {
    const reserved = await reserveAiUnit(db, profile.id, now(), env.dailyLimit);
    if (!reserved) {
      // Cap reached: wait until the UTC reset, oldest-first (spec §3.3).
      await db.emailAnalysis.updateMany({
        where: { id: row.id },
        data: { status: "queued", contentFingerprint: prepared.fingerprint, modelId: env.model },
      });
      await deferOrWait(db, ctx, nextUtcReset(now()), "capped");
      return;
    }
    reservedNow = true;
    await db.emailAnalysis.updateMany({
      where: { id: row.id },
      data: {
        usageConsumed: true,
        contentFingerprint: prepared.fingerprint,
        modelId: env.model,
        limited: prepared.limited,
      },
    });
  } else {
    await db.emailAnalysis.updateMany({
      where: { id: row.id },
      data: { contentFingerprint: prepared.fingerprint, modelId: env.model, limited: prepared.limited },
    });
  }

  // Flip to analyzing — guarded so a concurrent job for the same message
  // cannot run two provider calls (the loser exits; the winner proceeds).
  const claimed = await db.emailAnalysis.updateMany({
    where: { id: row.id, status: { in: ["queued", "stale", "failed", "analyzing", "limited", "ready"] } },
    data: { status: "analyzing", errorClass: null },
  });
  if (claimed.count !== 1) {
    // Another delivery already holds the analysis — hand our fresh reservation
    // back so a losing race never silently burns budget.
    if (reservedNow) {
      await releaseAiUnit(db, profile.id, now());
      await db.emailAnalysis.updateMany({ where: { id: row.id, usageConsumed: true }, data: { usageConsumed: false } });
    }
    return;
  }

  const startedAt = Date.now();
  try {
    const text = await generate({
      apiKey: env.apiKey as string,
      model: env.model,
      systemInstruction: SYSTEM_INSTRUCTION,
      userContent: buildUserContent(message, prepared),
    });
    const validated: ValidatedAnalysis = parseAnalysisText(text);

    // Persist ONLY if the fingerprint is still current (spec §7: a stale
    // result never overwrites a newer one).
    const result = {
      actionItems: validated.actionItems,
      deadlines: validated.deadlines,
    };
    const persisted = await db.emailAnalysis.updateMany({
      where: { id: row.id, gmailMessageId: messageId, contentFingerprint: prepared.fingerprint },
      data: {
        status: prepared.limited ? "limited" : "ready",
        category: validated.category,
        priority: validated.priority,
        summary: validated.summary,
        result,
        errorClass: null,
        analyzedAt: now(),
      },
    });
    if (persisted.count !== 1) {
      // Superseded by a newer fingerprint mid-flight — keep the newer row.
      logger.info("ai.analysis.ok", { jobId: ctx.jobId, outcome: "superseded", ms: Date.now() - startedAt });
      return;
    }
    logger.info("ai.analysis.ok", {
      jobId: ctx.jobId,
      outcome: "ready",
      limited: prepared.limited,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    await handleAnalysisFailure(db, {
      ctx,
      rowId: row.id,
      messageId,
      profileId: profile.id,
      reservedNow,
      error,
      now: now(),
      startedAt,
    });
  }
}

/**
 * Put the claimed job back to pending at `availableAt` (no attempt burned)
 * and signal the dispatcher with JobDeferredError so the row is neither
 * completed nor failed. Without a lease owner (defensive: unit tests that
 * call the handler directly), just return — the job stays running until its
 * lease expires and is reclaimed.
 */
async function deferOrWait(
  db: AiAnalysisDb,
  ctx: AiJobContext,
  availableAt: Date,
  reason: string,
): Promise<void> {
  if (!ctx.leaseOwner) return;
  const ok = await deferJob(db, {
    jobId: ctx.jobId,
    owner: ctx.leaseOwner,
    availableAt,
  });
  if (ok) throw new JobDeferredError(reason);
}

async function handleAnalysisFailure(
  db: AiAnalysisDb,
  input: {
    ctx: AiJobContext;
    rowId: string;
    messageId: string;
    profileId: string;
    reservedNow: boolean;
    error: unknown;
    now: Date;
    startedAt: number;
  },
): Promise<void> {
  // Malformed model output is a distinct, RETRYABLE class (a re-ask often
  // yields valid JSON); provider failures keep their categorized class.
  const errorClass =
    input.error instanceof AiValidationError ? "malformed_output" : classifyGeminiError(input.error).category;
  const permanent = errorClass === "auth" || errorClass === "config" || errorClass === "permanent";
  const exhausted = input.ctx.attempts >= MAX_ATTEMPTS;
  const willRetry = !permanent && !exhausted;

  // Release the reserved unit when this analysis will NOT succeed later —
  // success is the only thing that bills (spec §3.3). The release is safe to
  // repeat because usageConsumed is cleared with it.
  if (!willRetry) {
    await releaseAiUnit(db, input.profileId, input.now);
    await db.emailAnalysis.updateMany({
      where: { id: input.rowId },
      data: { usageConsumed: false },
    });
  }

  await db.emailAnalysis.updateMany({
    where: { id: input.rowId },
    data: {
      status: willRetry ? "queued" : "failed",
      errorClass,
    },
  });

  logger.warn("ai.analysis.failed", {
    jobId: input.ctx.jobId,
    errorClass,
    willRetry,
    ms: Date.now() - input.startedAt,
  });

  if (permanent) throw new PermanentJobError(errorClass);
  // Re-throw the categorized transient error so the queue applies backoff.
  throw input.error instanceof AiValidationError || input.error instanceof GeminiApiError
    ? input.error
    : classifyGeminiError(input.error);
}

// ---------------------------------------------------------------------------
// DTO mapping (routes + UI; never leaks internal ids beyond the caller's own).
// ---------------------------------------------------------------------------

export type AiAnalysisStatusValue =
  | "not_analyzed"
  | "queued"
  | "analyzing"
  | "ready"
  | "stale"
  | "limited"
  | "failed";

export interface AiActionItemDto {
  id: string;
  text: string;
  dueDateSourceText: string | null;
  dueDateIso: string | null;
}

export interface AiDeadlineDto {
  sourceText: string;
  iso: string | null;
}

export interface AiAnalysisDto {
  messageId: string;
  status: AiAnalysisStatusValue;
  category: AiCategoryValue | null;
  priority: AiPriorityValue | null;
  summary: string | null;
  actionItems: AiActionItemDto[];
  deadlines: AiDeadlineDto[];
  limited: boolean;
  errorClass: string | null;
  schemaVersion: number;
  modelId: string | null;
  analyzedAt: string | null;
  updatedAt: string | null;
}

function coerceResult(raw: unknown): { actionItems: AiActionItemDto[]; deadlines: AiDeadlineDto[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { actionItems: [], deadlines: [] };
  }
  const record = raw as Record<string, unknown>;
  const actionItems = Array.isArray(record.actionItems)
    ? (record.actionItems as Array<Record<string, unknown>>)
        .filter((item) => typeof item?.text === "string")
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : "a0",
          text: item.text as string,
          dueDateSourceText: typeof item.dueDateSourceText === "string" ? item.dueDateSourceText : null,
          dueDateIso: typeof item.dueDateIso === "string" ? item.dueDateIso : null,
        }))
    : [];
  const deadlines = Array.isArray(record.deadlines)
    ? (record.deadlines as Array<Record<string, unknown>>)
        .filter((item) => typeof item?.sourceText === "string")
        .map((item) => ({
          sourceText: item.sourceText as string,
          iso: typeof item.iso === "string" ? item.iso : null,
        }))
    : [];
  return { actionItems, deadlines };
}

export function toAnalysisDto(messageId: string, row: EmailAnalysisRow | null): AiAnalysisDto {
  if (!row) {
    return {
      messageId,
      status: "not_analyzed",
      category: null,
      priority: null,
      summary: null,
      actionItems: [],
      deadlines: [],
      limited: false,
      errorClass: null,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      modelId: null,
      analyzedAt: null,
      updatedAt: null,
    };
  }
  const { actionItems, deadlines } = coerceResult(row.result);
  // Rows were validated on write; coerce again on read so a hand-edited row
  // can never widen the DTO beyond the contract enums.
  return {
    messageId,
    status: row.status as AiAnalysisStatusValue,
    category: typeof row.category === "string" && isAiCategory(row.category) ? row.category : null,
    priority: typeof row.priority === "string" && isAiPriority(row.priority) ? row.priority : null,
    summary: row.summary,
    actionItems,
    deadlines,
    limited: row.limited,
    errorClass: row.errorClass,
    schemaVersion: row.schemaVersion,
    modelId: row.modelId || null,
    analyzedAt: row.analyzedAt ? row.analyzedAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Ownership-scoped read used by the GET route: the message must belong to the
 * caller's own CONNECTED-or-not mailbox (analysis of a released mailbox is
 * cleaned up, so this is effectively connected-only).
 */
export async function readOwnedAnalysis(
  db: AiAnalysisDb,
  input: { userId: string; messageId: string },
): Promise<AiAnalysisDto | null> {
  const message = await db.gmailMessage.findUnique({
    where: { id: input.messageId },
    include: { googleConnection: { select: { id: true, userId: true, status: true } } },
  });
  if (!message || message.googleConnection.userId !== input.userId) return null;
  const row = await db.emailAnalysis.findUnique({ where: { gmailMessageId: input.messageId } });
  return toAnalysisDto(input.messageId, row);
}
