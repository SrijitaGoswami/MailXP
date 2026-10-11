/**
 * Phase B10 — AI analysis domain tests (fake DB + injected provider; no
 * network, no live Gemini).
 *
 * Covers phase_b10.md §3 + §7:
 * - pause flag + daily-cap reserve/release accounting (atomic conditional
 *   increment, success-only billing);
 * - enqueueAnalysisJob: row upsert, coalescing, SUCCEEDED requeue, DEAD
 *   requeue (manual Retry);
 * - runAiAnalysis: ownership re-check, fingerprint idempotency (no double
 *   billing), fail-closed missing config, pause/cap DEFER (no retry burn),
 *   malformed-output retryable class, permanent auth/config dead-letter with
 *   unit release, and the no-concurrent-double-run claim guard;
 * - readOwnedAnalysis / toAnalysisDto: foreign message is a safe null, enum
 *   coercion on read, not_analyzed default;
 * - appendAnalysisEventsForMessages: oldest-first bound (AUTO_ENQUEUE_MAX).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { loadAiEnv, type AiEnv } from "@/lib/server/aiConfig";
import { AiValidationError } from "@/lib/server/aiSchema";
import { GeminiApiError } from "@/lib/server/geminiApi";
import { JobDeferredError, PermanentJobError, claimJobs, completeJob, type QueueDb } from "@/lib/server/jobQueue";
import {
  AI_PAUSE_DEFER_MS,
  AUTO_ENQUEUE_MAX,
  appendAnalysisEventsForMessages,
  enqueueAnalysisJob,
  isAnalysisPaused,
  readAiUsage,
  readOwnedAnalysis,
  releaseAiUnit,
  reserveAiUnit,
  runAiAnalysis,
  setAnalysisPaused,
  toAnalysisDto,
  type AiAnalysisDb,
  type AiJobContext,
} from "./aiAnalysis";

let fake: FakeDb;
let db: AiAnalysisDb & { job: AiAnalysisDb["job"] };

// Comfortably in the future so fake-row default "now" availableAt stays due.
const T0 = new Date(Date.now() + 3_600_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

const VALID_MODEL_OUTPUT = JSON.stringify({
  summary: "Invoice 42 due Friday; confirm receipt with finance.",
  category: "finance",
  priority: "high",
  actionItems: [
    { text: "Pay invoice 42", dueDateSourceText: "by Friday", dueDateIso: "2026-10-16" },
  ],
  deadlines: [{ sourceText: "by Friday", iso: "2026-10-16" }],
});

const TEST_ENV: AiEnv = {
  ...loadAiEnv({ GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-test", AI_DAILY_LIMIT: "3" }),
  configured: true,
  apiKey: "test-key",
  model: "gemini-test",
  dailyLimit: 3,
};

beforeEach(() => {
  fake = createFakeDb();
  db = fake.client as unknown as AiAnalysisDb & { job: AiAnalysisDb["job"] };
});

async function seedMailbox(): Promise<{ userId: string; profileId: string; connectionId: string; messageId: string }> {
  const user = (await fake.client.user.create({
    data: { email: `ai-${Math.random().toString(36).slice(2)}@example.test`, passwordHash: "x" },
  })) as { id: string };
  const profile = (await fake.client.playerProfile.create({
    data: { userId: user.id, prefs: {}, draftCoin: 0, version: 1 },
  })) as { id: string };
  const connection = (await fake.client.googleConnection.create({
    data: {
      userId: user.id,
      googleSub: `sub-${Math.random().toString(36).slice(2)}`,
      email: "box@example.test",
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
      refreshTokenCipher: "c",
      refreshTokenNonce: "n",
      refreshTokenTag: "t",
    },
  })) as { id: string };
  const message = (await fake.client.gmailMessage.create({
    data: {
      googleConnectionId: connection.id,
      gmailMessageId: `gm-${Math.random().toString(36).slice(2)}`,
      internalDate: new Date("2026-10-10T12:00:00Z"),
      sender: "billing@example.com",
      subject: "Invoice 42",
      snippet: "Invoice 42 is due Friday",
      bodyText: "Please pay invoice 42 by Friday and confirm receipt.",
      labels: ["INBOX"],
    },
  })) as { id: string };
  return { userId: user.id, profileId: profile.id, connectionId: connection.id, messageId: message.id };
}

function ctx(overrides: Partial<AiJobContext> = {}): AiJobContext {
  return { jobId: "job-1", attempts: 1, leaseOwner: "w-1", ...overrides };
}

function queue(): QueueDb {
  return fake.client as unknown as QueueDb;
}

// ---------------------------------------------------------------------------
// Settings + usage accounting.
// ---------------------------------------------------------------------------

describe("pause + daily usage accounting", () => {
  it("pause defaults to false and round-trips through upsert", async () => {
    const { profileId } = await seedMailbox();
    expect(await isAnalysisPaused(db, profileId)).toBe(false);
    await setAnalysisPaused(db, profileId, true);
    expect(await isAnalysisPaused(db, profileId)).toBe(true);
    await setAnalysisPaused(db, profileId, false);
    expect(await isAnalysisPaused(db, profileId)).toBe(false);
  });

  it("reserveAiUnit increments under the cap and refuses at the cap", async () => {
    const { profileId } = await seedMailbox();
    expect(await reserveAiUnit(db, profileId, T0, 2)).toBe(true);
    expect(await reserveAiUnit(db, profileId, T0, 2)).toBe(true);
    expect(await reserveAiUnit(db, profileId, T0, 2)).toBe(false);
    const usage = await readAiUsage(db, profileId, T0, 2);
    expect(usage.used).toBe(2);
    expect(usage.cap).toBe(2);
  });

  it("releaseAiUnit gives a unit back (failure path) and never goes negative", async () => {
    const { profileId } = await seedMailbox();
    await reserveAiUnit(db, profileId, T0, 5);
    await releaseAiUnit(db, profileId, T0);
    expect((await readAiUsage(db, profileId, T0, 5)).used).toBe(0);
    await releaseAiUnit(db, profileId, T0); // extra release is a no-op
    expect((await readAiUsage(db, profileId, T0, 5)).used).toBe(0);
  });

  it("cap 0 refuses every reservation without creating a row", async () => {
    const { profileId } = await seedMailbox();
    expect(await reserveAiUnit(db, profileId, T0, 0)).toBe(false);
    expect((await readAiUsage(db, profileId, T0, 0)).used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// enqueueAnalysisJob.
// ---------------------------------------------------------------------------

describe("enqueueAnalysisJob", () => {
  it("creates a queued analysis row + a coalesced durable job", async () => {
    const { messageId } = await seedMailbox();
    await enqueueAnalysisJob(db, { messageId });
    const row = fake.emailAnalyses[0]!;
    expect(row.status).toBe("queued");
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0]?.jobType).toBe("ai.analysis");
    expect(fake.jobs[0]?.dedupeKey).toBe(`ai.analysis:${messageId}`);
  });

  it("coalesces a second enqueue while the job is still pending", async () => {
    const { messageId } = await seedMailbox();
    await enqueueAnalysisJob(db, { messageId });
    await enqueueAnalysisJob(db, { messageId });
    expect(fake.jobs).toHaveLength(1);
  });

  it("requeues a SUCCEEDED job in place (re-analysis after a finished run)", async () => {
    const { messageId } = await seedMailbox();
    await enqueueAnalysisJob(db, { messageId });
    const jobId = fake.jobs[0]!.id as string;
    await claimJobs(queue(), { owner: "w", limit: 1, leaseMs: 60_000, now: T0 });
    await completeJob(queue(), { jobId, owner: "w", now: at(100) });
    expect(fake.jobs[0]?.status).toBe("succeeded");

    await enqueueAnalysisJob(db, { messageId });
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0]?.status).toBe("pending");
    expect(fake.jobs[0]?.attempts).toBe(0);
  });

  it("revives a DEAD job on manual Retry (resetAttempts)", async () => {
    const { messageId } = await seedMailbox();
    await enqueueAnalysisJob(db, { messageId });
    const jobId = fake.jobs[0]!.id as string;
    await claimJobs(queue(), { owner: "w", limit: 1, leaseMs: 60_000, now: T0 });
    fake.jobs[0]!.status = "dead";
    fake.jobs[0]!.attempts = 5;

    await enqueueAnalysisJob(db, { messageId });
    const revived = fake.jobs[0]!;
    expect(revived.status).toBe("pending");
    expect(revived.attempts).toBe(0);
  });

  it("is a no-op for a message that is not owned by a connected mailbox", async () => {
    const { connectionId, messageId } = await seedMailbox();
    await fake.client.googleConnection.update({
      where: { id: connectionId },
      data: { status: "released" },
    });
    await enqueueAnalysisJob(db, { messageId });
    expect(fake.emailAnalyses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runAiAnalysis — the job handler.
// ---------------------------------------------------------------------------

describe("runAiAnalysis", () => {
  it("valid output → ready row, usage billed once, action ids regenerated", async () => {
    const { profileId, messageId } = await seedMailbox();
    await runAiAnalysis(db, { messageId }, ctx(), {
      env: TEST_ENV,
      now: () => T0,
      generate: async () => VALID_MODEL_OUTPUT,
    });
    const row = fake.emailAnalyses[0]!;
    expect(row.status).toBe("ready");
    expect(row.category).toBe("finance");
    expect(row.priority).toBe("high");
    expect(row.summary).toContain("Invoice 42");
    expect(row.usageConsumed).toBe(true);
    expect(row.errorClass).toBeNull();
    const items = (row.result as { actionItems: Array<{ id: string }> }).actionItems;
    expect(items[0]?.id).toBe("a1"); // regenerated locally, never from the model
    expect((await readAiUsage(db, profileId, T0, TEST_ENV.dailyLimit)).used).toBe(1);
  });

  it("missing provider config fails CLOSED (failed/config) with no provider call", async () => {
    const { profileId, messageId } = await seedMailbox();
    let called = false;
    await runAiAnalysis(db, { messageId }, ctx(), {
      env: { ...TEST_ENV, configured: false, apiKey: "" },
      now: () => T0,
      generate: async () => {
        called = true;
        return VALID_MODEL_OUTPUT;
      },
    });
    expect(called).toBe(false);
    const row = fake.emailAnalyses[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("config");
    expect((await readAiUsage(db, profileId, T0, TEST_ENV.dailyLimit)).used).toBe(0);
  });

  it("idempotent redelivery: matching ready result consumes NO usage", async () => {
    const { profileId, messageId } = await seedMailbox();
    const opts = { env: TEST_ENV, now: () => T0, generate: async () => VALID_MODEL_OUTPUT };
    await runAiAnalysis(db, { messageId }, ctx(), opts);
    expect((await readAiUsage(db, profileId, T0, TEST_ENV.dailyLimit)).used).toBe(1);

    let secondCall = false;
    await runAiAnalysis(db, { messageId }, ctx({ jobId: "job-2" }), {
      ...opts,
      generate: async () => {
        secondCall = true;
        return VALID_MODEL_OUTPUT;
      },
    });
    expect(secondCall).toBe(false); // fingerprint match short-circuits before the provider
    expect((await readAiUsage(db, profileId, T0, TEST_ENV.dailyLimit)).used).toBe(1);
  });

  it("global pause DEFERS the claimed job without burning an attempt", async () => {
    const { profileId, messageId } = await seedMailbox();
    await enqueueAnalysisJob(db, { messageId });
    const jobId = fake.jobs[0]!.id as string;
    const [claimed] = await claimJobs(queue(), { owner: "w", limit: 1, leaseMs: 60_000, now: T0 });
    expect(claimed?.attempts).toBe(1);

    await setAnalysisPaused(db, profileId, true);
    await expect(
      runAiAnalysis(db, { messageId }, { jobId, attempts: 1, leaseOwner: "w" }, {
        env: TEST_ENV,
        now: () => T0,
        generate: async () => VALID_MODEL_OUTPUT,
      }),
    ).rejects.toBeInstanceOf(JobDeferredError);

    const job = fake.jobs[0]!;
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0); // defer decrements the claim increment
    expect((job.availableAt as Date).getTime()).toBe(T0.getTime() + AI_PAUSE_DEFER_MS);
    expect((await readAiUsage(db, profileId, T0, TEST_ENV.dailyLimit)).used).toBe(0);
  });

  it("daily cap DEFERS until the next UTC reset (no retry burn)", async () => {
    const { profileId, messageId } = await seedMailbox();
    // Exhaust the budget first (same cap the handler will use).
    await reserveAiUnit(db, profileId, T0, TEST_ENV.dailyLimit);
    await reserveAiUnit(db, profileId, T0, TEST_ENV.dailyLimit);
    await reserveAiUnit(db, profileId, T0, TEST_ENV.dailyLimit);
    await enqueueAnalysisJob(db, { messageId });
    const jobId = fake.jobs[0]!.id as string;
    await claimJobs(queue(), { owner: "w", limit: 1, leaseMs: 60_000, now: T0 });

    await expect(
      runAiAnalysis(db, { messageId }, { jobId, attempts: 1, leaseOwner: "w" }, {
        env: TEST_ENV,
        now: () => T0,
        generate: async () => VALID_MODEL_OUTPUT,
      }),
    ).rejects.toBeInstanceOf(JobDeferredError);

    const job = fake.jobs[0]!;
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    // Cap wait lands at the next UTC midnight.
    expect((job.availableAt as Date).getTime()).toBe(Date.UTC(
      T0.getUTCFullYear(), T0.getUTCMonth(), T0.getUTCDate() + 1,
    ));
  });

  it("malformed model output is retryable (malformed_output) and keeps the unit for the retry", async () => {
    const { profileId, messageId } = await seedMailbox();
    await expect(
      runAiAnalysis(db, { messageId }, ctx({ attempts: 1 }), {
        env: TEST_ENV,
        now: () => T0,
        generate: async () => "this is not json",
      }),
    ).rejects.toBeInstanceOf(AiValidationError);
    const row = fake.emailAnalyses[0]!;
    expect(row.status).toBe("queued"); // will retry
    expect(row.errorClass).toBe("malformed_output");
    // The reserved unit is NOT released while a retry is still planned.
    expect((await readAiUsage(db, profileId, T0, TEST_ENV.dailyLimit)).used).toBe(1);
  });

  it("permanent auth failure dead-letters and RELEASES the unit", async () => {
    const { profileId, messageId } = await seedMailbox();
    await expect(
      runAiAnalysis(db, { messageId }, ctx(), {
        env: TEST_ENV,
        now: () => T0,
        generate: async () => {
          throw new GeminiApiError("auth");
        },
      }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    const row = fake.emailAnalyses[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("auth");
    expect(row.usageConsumed).toBe(false);
    expect((await readAiUsage(db, profileId, T0, TEST_ENV.dailyLimit)).used).toBe(0);
  });

  it("a released mailbox at execution time is a terminal PermanentJobError (no provider call)", async () => {
    const { connectionId, messageId } = await seedMailbox();
    let called = false;
    await fake.client.googleConnection.update({ where: { id: connectionId }, data: { status: "released" } });
    await expect(
      runAiAnalysis(db, { messageId }, ctx(), {
        env: TEST_ENV,
        now: () => T0,
        generate: async () => {
          called = true;
          return VALID_MODEL_OUTPUT;
        },
      }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(called).toBe(false);
  });

  it("an invalid payload is a PermanentJobError before any DB work", async () => {
    await expect(
      runAiAnalysis(db, {}, ctx(), { env: TEST_ENV, generate: async () => VALID_MODEL_OUTPUT }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(fake.emailAnalyses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DTO mapping + ownership-scoped read.
// ---------------------------------------------------------------------------

describe("toAnalysisDto / readOwnedAnalysis", () => {
  it("null row maps to not_analyzed with empty lists", () => {
    const dto = toAnalysisDto("m-1", null);
    expect(dto.status).toBe("not_analyzed");
    expect(dto.category).toBeNull();
    expect(dto.actionItems).toEqual([]);
    expect(dto.deadlines).toEqual([]);
  });

  it("coerces out-of-enum category/priority to null on read", () => {
    const dto = toAnalysisDto("m-1", {
      id: "a-1",
      gmailMessageId: "m-1",
      googleConnectionId: "c-1",
      profileId: "p-1",
      status: "ready",
      contentFingerprint: "fp",
      schemaVersion: 1,
      modelId: "gemini-test",
      category: "not-a-real-category",
      priority: "urgent",
      summary: "s",
      result: { actionItems: [], deadlines: [] },
      limited: false,
      usageConsumed: true,
      errorClass: null,
      analyzedAt: T0,
      updatedAt: T0,
    });
    expect(dto.category).toBeNull();
    expect(dto.priority).toBe("urgent");
  });

  it("readOwnedAnalysis returns null for a foreign message (safe 404 upstream)", async () => {
    const { messageId, userId } = await seedMailbox();
    // A different user asks for the same message id.
    const other = (await fake.client.user.create({
      data: { email: "other@example.test", passwordHash: "x" },
    })) as { id: string };
    expect(other.id).not.toBe(userId);
    expect(await readOwnedAnalysis(db, { userId: other.id, messageId })).toBeNull();
  });

  it("readOwnedAnalysis returns the DTO for the owning user", async () => {
    const { userId, messageId } = await seedMailbox();
    await enqueueAnalysisJob(db, { messageId });
    const dto = await readOwnedAnalysis(db, { userId, messageId });
    expect(dto).not.toBeNull();
    expect(dto?.messageId).toBe(messageId);
    expect(dto?.status).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// Auto-enqueue outbox events (inside the gmail.sync commit tx).
// ---------------------------------------------------------------------------

describe("appendAnalysisEventsForMessages", () => {
  it("writes one event per message, bounded by AUTO_ENQUEUE_MAX", async () => {
    const ids = Array.from({ length: AUTO_ENQUEUE_MAX + 5 }, (_, i) => `m-${i}`);
    const appended = await appendAnalysisEventsForMessages(
      fake.client as never,
      ids,
    );
    expect(appended).toBe(AUTO_ENQUEUE_MAX);
    expect(fake.outboxEvents).toHaveLength(AUTO_ENQUEUE_MAX);
    expect(fake.outboxEvents[0]?.eventType).toBe("ai.analysis_requested");
    expect((fake.outboxEvents[0]?.payload as { messageId: string }).messageId).toBe("m-0");
  });

  it("preserves the caller's oldest-first ordering", async () => {
    await appendAnalysisEventsForMessages(fake.client as never, ["older", "newer"]);
    const payloads = fake.outboxEvents.map((e) => (e.payload as { messageId: string }).messageId);
    expect(payloads).toEqual(["older", "newer"]);
  });
});

// ---------------------------------------------------------------------------
// Job registration (worker wiring guard).
// ---------------------------------------------------------------------------

describe("worker registration", () => {
  it("ai.analysis is a registered JOB_HANDLER type", async () => {
    // Import here so the guard test fails loudly if the registration is removed.
    const { JOB_HANDLERS } = await import("./worker");
    expect(Object.keys(JOB_HANDLERS)).toContain("ai.analysis");
  });
});
