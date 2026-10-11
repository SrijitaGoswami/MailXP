/**
 * Phase B7 — transactional outbox tests (MOCKED storage: in-memory fake DB
 * with real $transaction snapshot rollback).
 *
 * Covers phase_b7.md §11 outbox requirements: atomic commit with the domain
 * transaction (rollback leaves NO publishable event), idempotent relay
 * conversion (crash between job-created and event-acknowledged), safe
 * terminal failure for unknown event types and invalid payloads (no job, no
 * side effect), transient relay failures backing off and dead-lettering
 * after max attempts, and payload PII policy of the planner registry.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import {
  appendOutboxEvent,
  OUTBOX_PLANNERS,
  relayOutboxEvents,
  type OutboxDb,
} from "./outbox";
import { MAX_ATTEMPTS, type QueueDb } from "./jobQueue";

let fake: FakeDb;
let db: OutboxDb & Pick<QueueDb, "job">;

beforeEach(() => {
  fake = createFakeDb();
  db = fake.client as unknown as OutboxDb & Pick<QueueDb, "job">;
});

// Comfortably in the future: fake rows default nextAttemptAt to the REAL
// clock, so T0 must always be >= "now" for fresh events to be due.
const T0 = new Date(Date.now() + 3_600_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

async function appendDeletionEvent(userId = "user-1") {
  return appendOutboxEvent(db, {
    eventType: "account.deletion_requested",
    payload: { userId },
  });
}

describe("transactional outbox atomicity", () => {
  it("event commits together with the domain change", async () => {
    await fake.client.$transaction(async (tx) => {
      await tx.user.create({ data: { email: "a@b.test", passwordHash: "x" } });
      await appendOutboxEvent(tx as unknown as OutboxDb, {
        eventType: "account.deletion_requested",
        payload: { userId: "user-1" },
      });
    });
    expect(fake.outboxEvents).toHaveLength(1);
    expect(fake.users).toHaveLength(1);
  });

  it("a rolled-back domain transaction leaves NO outbox event", async () => {
    await expect(
      fake.client.$transaction(async (tx) => {
        await tx.user.create({ data: { email: "rollback@b.test", passwordHash: "x" } });
        await appendOutboxEvent(tx as unknown as OutboxDb, {
          eventType: "account.deletion_requested",
          payload: { userId: "user-1" },
        });
        throw new Error("domain logic failed after append");
      }),
    ).rejects.toThrow("domain logic failed after append");

    expect(fake.outboxEvents).toHaveLength(0); // nothing publishable survived
    expect(fake.users).toHaveLength(0); // domain row rolled back too
  });
});

describe("relayOutboxEvents — conversion to jobs", () => {
  it("publishes a pending event into exactly one job with dedupeKey + outboxEventId", async () => {
    const eventId = await appendDeletionEvent("user-7");
    const result = await relayOutboxEvents(db, { now: T0, limit: 10 });

    expect(result).toEqual({ scanned: 1, published: 1, dead: 0, deferred: 0 });
    expect(fake.jobs).toHaveLength(1);
    const job = fake.jobs[0]!;
    expect(job.jobType).toBe("account.deletion");
    expect(job.dedupeKey).toBe("account.deletion:user-7");
    expect(job.outboxEventId).toBe(eventId);
    expect(job.payload).toEqual({ userId: "user-7" });

    const event = fake.outboxEvents[0]!;
    expect(event.status).toBe("published");
    expect(event.publishedAt).toEqual(T0);
  });

  it("is idempotent across a crash between job-created and event-acknowledged", async () => {
    await appendDeletionEvent("user-7");
    // Simulate the crash window: the job exists but the event never got its
    // published acknowledgement (e.g. process died mid-relay).
    await db.job.create({ data: { jobType: "account.deletion", payload: { userId: "user-7" }, dedupeKey: "account.deletion:user-7", outboxEventId: fake.outboxEvents[0]!.id as string } });

    const result = await relayOutboxEvents(db, { now: at(100), limit: 10 });
    expect(result.published).toBe(1); // acknowledged on re-run
    expect(fake.jobs).toHaveLength(1); // …without a duplicate job
    expect(fake.outboxEvents[0]?.status).toBe("published");
  });

  it("ignores future events (only due pending ones are relayed)", async () => {
    await appendDeletionEvent("user-7");
    fake.outboxEvents[0]!.nextAttemptAt = at(10_000);
    const result = await relayOutboxEvents(db, { now: T0, limit: 10 });
    expect(result.scanned).toBe(0);
    expect(fake.jobs).toHaveLength(0);
  });

  it("skips already-published and dead events", async () => {
    await appendDeletionEvent("user-7");
    fake.outboxEvents[0]!.status = "published";
    await appendDeletionEvent("user-8");
    fake.outboxEvents[1]!.status = "dead";
    const result = await relayOutboxEvents(db, { now: T0, limit: 10 });
    expect(result.scanned).toBe(0);
    expect(fake.jobs).toHaveLength(0);
  });

  it("oldest due events are relayed first", async () => {
    await appendDeletionEvent("older");
    fake.outboxEvents[0]!.createdAt = at(-1_000);
    await appendDeletionEvent("newer");
    await relayOutboxEvents(db, { now: T0, limit: 1 }); // batch of one
    expect(fake.jobs[0]?.payload).toEqual({ userId: "older" });
  });
});

describe("relay terminal failures — unknown type and invalid payload", () => {
  it("unknown event type -> event dead with unsupported_type, NO job created", async () => {
    await db.outboxEvent.create({ data: { eventType: "gmail.future_thing", payload: { userId: "u" } } });
    const result = await relayOutboxEvents(db, { now: T0, limit: 10 });

    expect(result).toEqual({ scanned: 1, published: 0, dead: 1, deferred: 0 });
    expect(fake.outboxEvents[0]?.status).toBe("dead");
    expect(fake.outboxEvents[0]?.lastErrorClass).toBe("unsupported_type");
    expect(fake.jobs).toHaveLength(0);
  });

  it("invalid payload (missing userId) -> dead with validation, NO job created", async () => {
    await db.outboxEvent.create({ data: { eventType: "account.deletion_requested", payload: { notUserId: 42 } } });
    const result = await relayOutboxEvents(db, { now: T0, limit: 10 });

    expect(result.dead).toBe(1);
    expect(fake.outboxEvents[0]?.status).toBe("dead");
    expect(fake.outboxEvents[0]?.lastErrorClass).toBe("validation");
    expect(fake.jobs).toHaveLength(0);
  });

  it("null payload -> dead with validation, NO job created", async () => {
    await db.outboxEvent.create({ data: { eventType: "account.deletion_requested" } });
    const result = await relayOutboxEvents(db, { now: T0, limit: 10 });
    expect(result.dead).toBe(1);
    expect(fake.jobs).toHaveLength(0);
  });
});

describe("relay transient failures — backoff then terminal after max attempts", () => {
  it("defers with backoff and dead-letters after MAX_ATTEMPTS", async () => {
    await appendDeletionEvent("user-7");
    const originalCreate = fake.client.job.create.bind(fake.client.job);
    let failures = 0;
    // Simulate an unavailable database during enqueue (transient "db" class).
    (fake.client.job as { create: unknown }).create = async () => {
      failures += 1;
      throw { code: "ECONNREFUSED" };
    };

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const result = await relayOutboxEvents(db, { now: T0, limit: 10, random: () => 0.5 });
        const event = fake.outboxEvents[0]!;
        expect(event.status).toBe(attempt === MAX_ATTEMPTS ? "dead" : "pending");
        expect(event.attempts).toBe(attempt);
        expect(event.lastErrorClass).toBe("db");
        if (attempt < MAX_ATTEMPTS) {
          expect(result.deferred).toBe(1);
          expect((event.nextAttemptAt as Date).getTime()).toBeGreaterThan(T0.getTime()); // backed off
          event.nextAttemptAt = T0; // make it due again for the next loop
        } else {
          expect(result.dead).toBe(1);
        }
      }
      expect(failures).toBe(MAX_ATTEMPTS);
      expect(fake.jobs).toHaveLength(0); // never produced work while broken
    } finally {
      (fake.client.job as { create: unknown }).create = originalCreate;
    }

    // A dead event is never relayed again.
    const after = await relayOutboxEvents(db, { now: at(1_000_000), limit: 10 });
    expect(after.scanned).toBe(0);
  });
});

describe("planner registry & payload policy", () => {
  it("only the approved event types exist (deletion + B9 gmail sync + B10 analysis)", () => {
    // B7's account.deletion_requested, B9's gmail.sync_requested and B10's
    // approved ai.analysis_requested (phase_b10.md §7). No other event type
    // may ever be planned, and no planner may be keyed literally "gemini" —
    // the provider name stays out of the pipeline (see deletion.test.ts).
    expect(Object.keys(OUTBOX_PLANNERS).sort()).toEqual([
      "account.deletion_requested",
      "ai.analysis_requested",
      "gmail.sync_requested",
    ]);
    expect(Object.keys(OUTBOX_PLANNERS)).not.toContain("gemini");
  });

  it("the ai planner dispatches one coalesced job keyed only on the message id", () => {
    const dispatch = OUTBOX_PLANNERS["ai.analysis_requested"]!({ messageId: "msg-7" });
    expect(dispatch.jobType).toBe("ai.analysis");
    expect(dispatch.payload).toEqual({ messageId: "msg-7" });
    expect(Object.keys(dispatch.payload)).toEqual(["messageId"]);
    expect(dispatch.dedupeKey).toBe("ai.analysis:msg-7");
  });

  it("the ai planner rejects malformed payloads as permanent validation errors", () => {
    for (const bad of [null, undefined, "msg", 42, {}, { messageId: "" }, { messageId: 7 }]) {
      expect(() => OUTBOX_PLANNERS["ai.analysis_requested"]!(bad)).toThrowError();
    }
  });

  it("the gmail planner dispatches a coalesced job keyed only on the connection id", () => {
    const dispatch = OUTBOX_PLANNERS["gmail.sync_requested"]!({ googleConnectionId: "conn-7" });
    expect(dispatch.jobType).toBe("gmail.sync");
    expect(dispatch.payload).toEqual({ googleConnectionId: "conn-7" });
    expect(Object.keys(dispatch.payload)).toEqual(["googleConnectionId"]);
    expect(dispatch.dedupeKey).toBe("gmail.sync:conn-7");
  });

  it("the gmail planner rejects malformed payloads as permanent validation errors", () => {
    for (const bad of [null, undefined, "conn", 42, {}, { googleConnectionId: "" }, { googleConnectionId: 7 }]) {
      expect(() => OUTBOX_PLANNERS["gmail.sync_requested"]!(bad)).toThrowError();
    }
  });

  it("planner payloads carry only the internal userId — no email, tokens, or secrets", () => {
    const dispatch = OUTBOX_PLANNERS["account.deletion_requested"]!({ userId: "user-42" });
    expect(dispatch.jobType).toBe("account.deletion");
    expect(dispatch.payload).toEqual({ userId: "user-42" });
    expect(Object.keys(dispatch.payload)).toEqual(["userId"]);
    expect(dispatch.dedupeKey).toBe("account.deletion:user-42");
  });

  it("planner rejects malformed payloads as permanent validation errors", () => {
    for (const bad of [null, undefined, "user-1", 42, {}, { userId: "" }, { userId: 7 }]) {
      expect(() => OUTBOX_PLANNERS["account.deletion_requested"]!(bad)).toThrowError();
    }
  });
});
