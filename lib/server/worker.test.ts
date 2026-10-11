/**
 * Phase B7 — worker/dispatcher tests (MOCKED storage: in-memory fake DB;
 * injected clock, no reliance on real time except job-row defaults).
 *
 * Covers phase_b7.md §11 worker requirements: end-to-end outbox -> job ->
 * handler pipeline, success recorded only after the handler's durable
 * effect, unknown-type and invalid-payload dead-letters with NO side effect,
 * transient failures retrying with backoff and exhausting to dead,
 * at-least-once delivery with idempotent effects, structured+redacted logs,
 * bounded polling with clean shutdown, and no stacked loops from repeated
 * start() calls (dev hot-reload guard, with the globalThis singleton covered
 * in workerRuntime via instrumentation.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { appendOutboxEvent, type OutboxDb } from "./outbox";
import { enqueueJob, type QueueDb } from "./jobQueue";
import { createWorker, type WorkerDb, type WorkerOptions } from "./worker";

let fake: FakeDb;
let db: WorkerDb;
let clock: number;

// >= the real clock (fake rows default availableAt/nextAttemptAt to "now"),
// so injected `now` is always "due"; advance `clock` to cross backoff waits.
const TICK = () => new Date(clock);

beforeEach(() => {
  fake = createFakeDb();
  db = fake.client as unknown as WorkerDb;
  clock = Date.now() + 3_600_000;
});

function makeWorker(overrides: Partial<WorkerOptions> = {}) {
  return createWorker({
    db,
    owner: "test-worker",
    pollIntervalMs: 600_000, // no background ticking unless a test opts in
    now: TICK,
    ...overrides,
  });
}

async function seedRequestedUser(email = "worker@example.test"): Promise<string> {
  const user = (await fake.client.user.create({
    data: { email, passwordHash: "x" },
  })) as { id: string };
  await fake.client.user.update({
    where: { id: user.id },
    data: { deletionRequestedAt: new Date() },
  });
  return user.id;
}

describe("runOnce — end-to-end pipeline (outbox -> relay -> claim -> handler -> success)", () => {
  it("processes a deletion event completely in one tick", async () => {
    const userId = await seedRequestedUser();
    await appendOutboxEvent(fake.client as unknown as OutboxDb, {
      eventType: "account.deletion_requested",
      payload: { userId },
    });

    const result = await makeWorker().runOnce();

    expect(result).toEqual({
      relayed: 1,
      relayDead: 0,
      claimed: 1,
      succeeded: 1,
      deferred: 0,
      retried: 0,
      dead: 0,
      lost: 0,
    });
    // Durable effects: account gone, event published, job succeeded, evidence written.
    expect(fake.users).toHaveLength(0);
    expect(fake.outboxEvents[0]?.status).toBe("published");
    const job = fake.jobs[0]!;
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(1);
    expect(job.leaseOwner).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
    expect(job.finishedAt).toEqual(TICK());
    expect(fake.audits.some((a) => a.eventType === "auth.account_erased")).toBe(true);
  });

  it("an already-succeeded job is never claimed again", async () => {
    const userId = await seedRequestedUser();
    await appendOutboxEvent(fake.client as unknown as OutboxDb, {
      eventType: "account.deletion_requested",
      payload: { userId },
    });
    const worker = makeWorker();
    await worker.runOnce();
    const second = await worker.runOnce();
    expect(second.claimed).toBe(0);
    expect(fake.audits.filter((a) => a.eventType === "auth.account_erased")).toHaveLength(1);
  });

  it("relay and claim are separate: a job created directly (no outbox) still runs", async () => {
    const userId = await seedRequestedUser("direct@example.test");
    await enqueueJob(db, { jobType: "account.deletion", payload: { userId }, dedupeKey: `account.deletion:${userId}` });
    const result = await makeWorker().runOnce();
    expect(result.relayed).toBe(0);
    expect(result.succeeded).toBe(1);
    expect(fake.users).toHaveLength(0);
  });
});

describe("fail-safe behavior — unknown types and invalid payloads", () => {
  it("unknown job type dead-letters as unsupported_type without executing anything", async () => {
    const userId = await seedRequestedUser("unrelated@example.test");
    await enqueueJob(db, { jobType: "gmail.sync_history", payload: { userId } });

    const result = await makeWorker().runOnce();

    expect(result.dead).toBe(1);
    expect(result.succeeded).toBe(0);
    const job = fake.jobs[0]!;
    expect(job.status).toBe("dead");
    expect(job.lastErrorClass).toBe("unsupported_type");
    expect(job.finishedAt).toEqual(TICK());
    // No side effect: the account (and everything else) is untouched.
    expect(fake.users.find((u) => u.id === userId)).toBeDefined();
    expect(fake.audits.filter((a) => a.eventType === "auth.account_erased")).toHaveLength(0);
  });

  it("invalid payload on a real job type dead-letters as validation, no side effect", async () => {
    const userId = await seedRequestedUser("malformed@example.test");
    await enqueueJob(db, { jobType: "account.deletion", payload: { notUserId: true } });

    const result = await makeWorker().runOnce();

    expect(result.dead).toBe(1);
    expect(fake.jobs[0]?.status).toBe("dead");
    expect(fake.jobs[0]?.lastErrorClass).toBe("validation");
    expect(fake.users.find((u) => u.id === userId)).toBeDefined();
    expect(fake.audits.filter((a) => a.eventType === "auth.account_erased")).toHaveLength(0);
  });
});

describe("failure classification — retry with backoff, terminal exhaustion", () => {
  it("transient handler error -> pending with backed-off availableAt (not yet claimable)", async () => {
    await enqueueJob(db, { jobType: "test.flaky", dedupeKey: "flaky" });
    const worker = makeWorker({
      handlers: {
        "test.flaky": async () => {
          throw new Error("service hiccup");
        },
      },
    });

    const result = await worker.runOnce();
    expect(result.retried).toBe(1);

    const job = fake.jobs[0]!;
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(1);
    expect(job.leaseOwner).toBeNull();
    expect(job.lastErrorClass).toBe("unexpected");
    expect((job.availableAt as Date).getTime()).toBeGreaterThan(clock); // backoff into the future

    // Immediately re-running must NOT pick it up (backoff honored).
    expect((await worker.runOnce()).claimed).toBe(0);

    // After the backoff window passes, redelivery happens (at-least-once).
    clock += 3_600_000;
    const again = await makeWorker({
      handlers: {
        "test.flaky": async () => {
          throw new Error("service hiccup");
        },
      },
    }).runOnce();
    expect(again.retried).toBe(1);
    expect(fake.jobs[0]?.attempts).toBe(2);
  });

  it("exhausts maxAttempts -> terminal dead, never loops forever", async () => {
    await enqueueJob(db, { jobType: "test.flaky", dedupeKey: "flaky-once", maxAttempts: 1 });
    const worker = makeWorker({
      handlers: {
        "test.flaky": async () => {
          throw new Error("always broken");
        },
      },
    });

    const result = await worker.runOnce();
    expect(result.dead).toBe(1);
    expect(fake.jobs[0]?.status).toBe("dead");
    expect(fake.jobs[0]?.lastErrorClass).toBe("unexpected");
    // Not claimable afterwards, whatever the clock does.
    clock += 10_000_000;
    expect((await worker.runOnce()).claimed).toBe(0);
  });

  it("lost lease: completion after takeover reports lost and does not override", async () => {
    await enqueueJob(db, { jobType: "test.slow", dedupeKey: "slow" });
    let observed: { status: unknown; finishedAt: unknown } | null = null;
    const worker = makeWorker({
      handlers: {
        "test.slow": async ({ jobId }) => {
          const row = fake.jobs.find((j) => j.id === jobId)!;
          observed = { status: row.status, finishedAt: row.finishedAt };
          // Simulate the lease expiring mid-handler and another worker taking over.
          row.status = "pending";
          row.leaseOwner = "someone-else";
          row.leaseExpiresAt = null;
        },
      },
    });

    const result = await worker.runOnce();
    expect(result.lost).toBe(1);
    // The handler observed a RUNNING job (success is only recorded afterwards).
    expect(observed).toEqual({ status: "running", finishedAt: null });
    // The takeover state was NOT overwritten by our late completion.
    expect(fake.jobs[0]?.status).toBe("pending");
    expect(fake.jobs[0]?.leaseOwner).toBe("someone-else");
  });
});

describe("at-least-once delivery", () => {
  it("a manually re-run (redelivered) job executes again — handler must be idempotent", async () => {
    let runs = 0;
    await enqueueJob(db, { jobType: "test.count", dedupeKey: "counter" });
    const handlers = {
      "test.count": async () => {
        runs += 1;
      },
    };
    const worker = makeWorker({ handlers });
    expect((await worker.runOnce()).succeeded).toBe(1);
    expect(runs).toBe(1);

    // Operator requeues (dead-letter recovery pattern) -> second delivery.
    const { requeueDeadJob } = await import("./jobQueue");
    const jobId = fake.jobs[0]!.id as string;
    // job is succeeded, not dead — force it back like a recovery replay:
    fake.jobs[0]!.status = "dead";
    await requeueDeadJob(db, { jobId, now: TICK() });
    expect((await worker.runOnce()).succeeded).toBe(1);
    expect(runs).toBe(2); // delivery happened twice (at-least-once)
    // The durable EFFECT for the real handler is idempotent — proven in
    // deletion.test.ts ("repeated erasure attempts are safe").
  });
});

describe("observability — structured, redacted logs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("job logs carry ids/types/attempts/outcomes but NEVER payload content", async () => {
    const logSpy = vi.spyOn(console, "log");
    const warnSpy = vi.spyOn(console, "warn");

    // Success path with a sensitive-looking payload.
    const userId = await seedRequestedUser("logs@example.test");
    await appendOutboxEvent(fake.client as unknown as OutboxDb, {
      eventType: "account.deletion_requested",
      payload: { userId, password: "hunter2-should-never-log" },
    });
    const worker = makeWorker();
    await worker.runOnce();

    // Failure path (unknown type) exercises the warn log.
    await enqueueJob(db, { jobType: "weird.type", payload: { secret: "do-not-log-either" } });
    await worker.runOnce();

    const all = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .map((args) => args.map(String).join(" "))
      .join("\n");
    // Correlation + safe fields ARE present.
    expect(all).toContain("worker.job.ok");
    expect(all).toContain("test-worker");
    expect(all).toContain("worker.job.failed");
    expect(all).toContain("unsupported_type");
    // Sensitive payload content is absent.
    expect(all).not.toContain("hunter2-should-never-log");
    expect(all).not.toContain("do-not-log-either");
    expect(all).not.toContain(userId); // internal id from payload never echoed by job logs
  });
});

describe("polling loop — bounded, idempotent start, clean shutdown", () => {
  it("start() twice does not stack loops; stop() halts polling", async () => {
    const original = fake.client.outboxEvent.findMany.bind(fake.client.outboxEvent);
    let ticks = 0;
    (fake.client.outboxEvent as { findMany: unknown }).findMany = (...args: unknown[]) => {
      ticks += 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };

    const worker = makeWorker({ pollIntervalMs: 5 });
    worker.start();
    worker.start(); // double-instrumentation / hot reload — must be a no-op
    expect(worker.isStarted()).toBe(true);

    await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(3), { timeout: 2_000 });

    await worker.stop();
    const ticksAtStop = ticks;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ticks).toBe(ticksAtStop); // nothing polls after clean shutdown
    expect(worker.isStarted()).toBe(false);
  });

  it("runOnce works standalone (tests/ops entry point) without start()", async () => {
    const result = await makeWorker().runOnce();
    expect(result.claimed).toBe(0);
  });

  it("a failing tick logs safely and keeps the loop alive", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    const brokenDb = {
      outboxEvent: {
        findMany: async () => {
          throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
        },
      },
    } as unknown as WorkerDb;
    const worker = createWorker({
      db: brokenDb,
      owner: "broken-worker",
      pollIntervalMs: 600_000,
      now: TICK,
    });
    const result = await worker.runOnce(); // claim also fails -> logged, not thrown
    expect(result.claimed).toBe(0);
    expect(warnSpy.mock.calls.map(String).join("\n")).toContain("worker.claim.failed");
    expect(warnSpy.mock.calls.map(String).join("\n")).not.toContain("connection refused");
    vi.restoreAllMocks();
  });
});
