/**
 * Phase B7 — job queue unit tests (MOCKED storage: in-memory fake DB with
 * real transaction-rollback semantics; live PostgreSQL evidence comes from
 * the b7 live smoke, labeled separately).
 *
 * Covers phase_b7.md §11 queue requirements: idempotent enqueue (dedupe +
 * outbox unique keys), atomic claims between competing workers, lease expiry
 * recovery, backoff bounds with injected randomness, permanent-vs-transient
 * terminal states, attempt accounting, lost-lease protection, requeue
 * (dead-letter manual recovery), and restart durability of persisted rows.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import {
  BACKOFF_CAP_MS,
  claimJobs,
  completeJob,
  computeBackoffMs,
  enqueueJob,
  failJob,
  MAX_ATTEMPTS,
  requeueDeadJob,
  type QueueDb,
} from "./jobQueue";

let fake: FakeDb;
let db: QueueDb;

beforeEach(() => {
  fake = createFakeDb();
  db = fake.client as unknown as QueueDb;
});

// Comfortably in the future: fake rows default availableAt/nextAttemptAt to
// the REAL clock, so T0 must always be >= "now" for them to be due.
const T0 = new Date(Date.now() + 3_600_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

async function enqueueReady(jobType = "account.deletion", dedupeKey?: string) {
  return enqueueJob(db, { jobType, payload: { userId: "user-1" }, dedupeKey: dedupeKey ?? null });
}

describe("enqueueJob idempotency (unique dedupeKey / outboxEventId)", () => {
  it("collides on duplicate dedupeKey and resolves to the existing job", async () => {
    const first = await enqueueReady("account.deletion", "account.deletion:user-1");
    const second = await enqueueReady("account.deletion", "account.deletion:user-1");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    expect(fake.jobs).toHaveLength(1);
  });

  it("collides on duplicate outboxEventId (relay crash-window dedupe)", async () => {
    const a = await enqueueJob(db, { jobType: "account.deletion", outboxEventId: "obx-1" });
    const b = await enqueueJob(db, { jobType: "account.deletion", outboxEventId: "obx-1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.jobId).toBe(a.jobId);
    expect(fake.jobs).toHaveLength(1);
  });

  it("distinct keys create distinct rows", async () => {
    await enqueueJob(db, { jobType: "account.deletion", dedupeKey: "k1" });
    await enqueueJob(db, { jobType: "account.deletion", dedupeKey: "k2" });
    expect(fake.jobs).toHaveLength(2);
  });

  it("requeues a SUCCEEDED job in place on dedupeKey collision (B10 latent-B9 fix)", async () => {
    // A completed job + a later enqueue with the same key (second "Sync now",
    // re-analysis of a finished message) must run again — the unique-ever
    // dedupeKey would otherwise swallow the request forever.
    const first = await enqueueJob(db, { jobType: "gmail.sync", dedupeKey: "gmail.sync:conn-1" });
    await claimJobs(db, { owner: "w", limit: 1, leaseMs: 60_000, now: T0 });
    await completeJob(db, { jobId: first.jobId, owner: "w", now: at(100) });
    expect(fake.jobs[0]?.status).toBe("succeeded");

    const again = await enqueueJob(db, {
      jobType: "gmail.sync",
      dedupeKey: "gmail.sync:conn-1",
      now: at(5_000),
    });
    expect(again.created).toBe(true);
    expect(again.jobId).toBe(first.jobId);
    expect(fake.jobs).toHaveLength(1);
    const row = fake.jobs[0]!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.finishedAt).toBeNull();
    expect(row.lastErrorClass).toBeNull();
    expect(row.leaseOwner).toBeNull();
    expect((row.availableAt as Date).getTime()).toBe(T0.getTime() + 5_000);
  });

  it("still coalesces a PENDING or RUNNING job (created: false)", async () => {
    const first = await enqueueJob(db, { jobType: "gmail.sync", dedupeKey: "gmail.sync:conn-2" });
    const pending = await enqueueJob(db, { jobType: "gmail.sync", dedupeKey: "gmail.sync:conn-2" });
    expect(pending.created).toBe(false);
    expect(pending.jobId).toBe(first.jobId);

    await claimJobs(db, { owner: "w", limit: 1, leaseMs: 60_000, now: T0 });
    const running = await enqueueJob(db, { jobType: "gmail.sync", dedupeKey: "gmail.sync:conn-2" });
    expect(running.created).toBe(false);
    expect(fake.jobs).toHaveLength(1);
  });

  it("does NOT auto-requeue a DEAD job (manual requeueDeadJob path)", async () => {
    const first = await enqueueJob(db, { jobType: "ai.analysis", dedupeKey: "ai.analysis:m-1" });
    await claimJobs(db, { owner: "w", limit: 1, leaseMs: 60_000, now: T0 });
    await failJob(db, {
      jobId: first.jobId,
      owner: "w",
      errorClass: "permanent",
      permanent: true,
      now: T0,
    });
    expect(fake.jobs[0]?.status).toBe("dead");

    const again = await enqueueJob(db, { jobType: "ai.analysis", dedupeKey: "ai.analysis:m-1" });
    expect(again.created).toBe(false);
    expect(fake.jobs[0]?.status).toBe("dead");
  });
});

describe("claimJobs — atomic claim, ordering, leases", () => {
  it("two competing claimers never hold the same job", async () => {
    await enqueueReady();
    const [a, b] = await Promise.all([
      claimJobs(db, { owner: "w-a", limit: 5, leaseMs: 60_000, now: T0 }),
      claimJobs(db, { owner: "w-b", limit: 5, leaseMs: 60_000, now: T0 }),
    ]);
    expect(a.length + b.length).toBe(1); // exactly one winner
    const winner = a.length === 1 ? a[0]! : b[0]!;
    expect(winner.status).toBe("running");
    expect(winner.attempts).toBe(1);
    expect(winner.leaseExpiresAt?.getTime()).toBe(T0.getTime() + 60_000);
  });

  it("claims oldest availableAt first and skips future work", async () => {
    await enqueueJob(db, { jobType: "later", dedupeKey: "later", availableAt: at(10_000) });
    await enqueueJob(db, { jobType: "soon", dedupeKey: "soon", availableAt: at(-100) });
    await enqueueJob(db, { jobType: "ready", dedupeKey: "ready", availableAt: at(-1_000) });

    const claimed = await claimJobs(db, { owner: "w", limit: 5, leaseMs: 60_000, now: T0 });
    expect(claimed.map((j) => j.jobType)).toEqual(["ready", "soon"]); // oldest first
    expect(claimed.map((j) => j.dedupeKey)).not.toContain("later");
    expect(fake.jobs.find((j) => j.dedupeKey === "later")?.status).toBe("pending");
  });

  it("respects the batch limit", async () => {
    await enqueueJob(db, { jobType: "a", dedupeKey: "a" });
    await enqueueJob(db, { jobType: "b", dedupeKey: "b" });
    await enqueueJob(db, { jobType: "c", dedupeKey: "c" });
    const claimed = await claimJobs(db, { owner: "w", limit: 2, leaseMs: 60_000, now: T0 });
    expect(claimed).toHaveLength(2);
  });

  it("an active lease is not reclaimed; an expired lease is (crash recovery)", async () => {
    await enqueueReady();
    const [first] = await claimJobs(db, { owner: "w-crashed", leaseMs: 5_000, limit: 5, now: T0 });
    expect(first).toBeDefined();

    // Lease still active -> nobody can steal it.
    const whileActive = await claimJobs(db, { owner: "w-2", leaseMs: 5_000, limit: 5, now: at(4_000) });
    expect(whileActive).toHaveLength(0);

    // Lease expired -> reclaimable, attempt counted again (at-least-once).
    const afterExpiry = await claimJobs(db, { owner: "w-2", leaseMs: 5_000, limit: 5, now: at(6_000) });
    expect(afterExpiry).toHaveLength(1);
    expect(afterExpiry[0]?.leaseOwner).toBe("w-2");
    expect(afterExpiry[0]?.attempts).toBe(2);
    expect(afterExpiry[0]?.startedAt).toEqual(T0); // first-claim timestamp kept
  });

  it("a re-claimed row keeps its original dedupeKey and payload", async () => {
    await enqueueJob(db, { jobType: "account.deletion", payload: { userId: "u-9" }, dedupeKey: "account.deletion:u-9" });
    await claimJobs(db, { owner: "w-1", leaseMs: 1, limit: 5, now: T0 });
    const [again] = await claimJobs(db, { owner: "w-2", leaseMs: 60_000, limit: 5, now: at(100) });
    expect(again?.dedupeKey).toBe("account.deletion:u-9");
    expect(again?.payload).toEqual({ userId: "u-9" });
  });
});

describe("completeJob / failJob transitions", () => {
  it("success only from the lease owner; wrong owner reports lost", async () => {
    await enqueueReady();
    await claimJobs(db, { owner: "mine", leaseMs: 60_000, limit: 5, now: T0 });
    const job = fake.jobs[0]!;

    expect(await completeJob(db, { jobId: job.id as string, owner: "intruder", now: at(100) })).toBe(false);
    expect(await completeJob(db, { jobId: job.id as string, owner: "mine", now: at(100) })).toBe(true);
    expect(job.status).toBe("succeeded");
    expect(job.leaseOwner).toBeNull();
    expect(job.finishedAt).toEqual(at(100));
  });

  it("transient failure -> pending with bounded backoff delay", async () => {
    await enqueueReady();
    await claimJobs(db, { owner: "w", leaseMs: 60_000, limit: 5, now: T0 });
    const job = fake.jobs[0]!;

    const outcome = await failJob(db, {
      jobId: job.id as string,
      owner: "w",
      errorClass: "unexpected",
      now: at(10),
      random: () => 0.5, // zero jitter in this test: delay = raw = 1000ms
    });
    expect(outcome).toBe("retry");
    expect(job.status).toBe("pending");
    expect(job.leaseOwner).toBeNull();
    expect(job.lastErrorClass).toBe("unexpected");
    expect((job.availableAt as Date).getTime()).toBe(at(10).getTime() + 1_000);
    expect((job.availableAt as Date).getTime()).toBeGreaterThan(at(10).getTime()); // not yet claimable at `now`
  });

  it("permanent class -> dead immediately, never retried", async () => {
    await enqueueReady();
    await claimJobs(db, { owner: "w", leaseMs: 60_000, limit: 5, now: T0 });
    const job = fake.jobs[0]!;

    const outcome = await failJob(db, {
      jobId: job.id as string,
      owner: "w",
      errorClass: "validation",
      now: at(10),
    });
    expect(outcome).toBe("dead");
    expect(job.status).toBe("dead");
    expect(job.finishedAt).toEqual(at(10));
    expect(job.lastErrorClass).toBe("validation");
    // And a dead job is not claimable.
    expect(await claimJobs(db, { owner: "w2", leaseMs: 60_000, limit: 5, now: at(100_000) })).toHaveLength(0);
  });

  it("attempts exhaustion -> dead (max attempts honored)", async () => {
    await enqueueReady();
    const job = fake.jobs[0]!;
    job.attempts = MAX_ATTEMPTS; // simulate MAX_ATTEMPTS prior deliveries
    await claimJobs(db, { owner: "w", leaseMs: 60_000, limit: 5, now: T0 });
    expect(job.attempts).toBe(MAX_ATTEMPTS + 1);

    const outcome = await failJob(db, {
      jobId: job.id as string,
      owner: "w",
      errorClass: "db", // transient class — but attempts are exhausted
      now: at(10),
    });
    expect(outcome).toBe("dead");
    expect(job.status).toBe("dead");
    expect(job.lastErrorClass).toBe("db");
  });

  it("failing without holding the lease reports lost and changes nothing", async () => {
    await enqueueReady();
    await claimJobs(db, { owner: "real-owner", leaseMs: 60_000, limit: 5, now: T0 });
    const job = fake.jobs[0]!;

    const outcome = await failJob(db, { jobId: job.id as string, owner: "ghost", errorClass: "db", now: at(5) });
    expect(outcome).toBe("lost");
    expect(job.status).toBe("running");
    expect(job.leaseOwner).toBe("real-owner");
  });
});

describe("computeBackoffMs — bounded exponential + injected jitter", () => {
  it("matches the documented formula with injected randomness", () => {
    // random = 0.5 -> factor 1.0 (no jitter): pure exponential series.
    expect(computeBackoffMs(1, () => 0.5)).toBe(1_000);
    expect(computeBackoffMs(2, () => 0.5)).toBe(2_000);
    expect(computeBackoffMs(3, () => 0.5)).toBe(4_000);
    expect(computeBackoffMs(4, () => 0.5)).toBe(8_000);
  });

  it("stays within ±25 % jitter bounds", () => {
    for (const attempts of [1, 2, 3, 4]) {
      const raw = 1_000 * 2 ** (attempts - 1);
      expect(computeBackoffMs(attempts, () => 0)).toBe(Math.round(raw * 0.75));
      expect(computeBackoffMs(attempts, () => 1)).toBe(Math.round(raw * 1.25));
    }
  });

  it("never exceeds the cap, whatever the attempt count or randomness", () => {
    for (const attempts of [1, 5, 10, 50, 1_000]) {
      for (const r of [0, 0.5, 1]) {
        expect(computeBackoffMs(attempts, () => r)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
      }
    }
    expect(computeBackoffMs(1_000, () => 1)).toBe(BACKOFF_CAP_MS); // 5 min ceiling
  });

  it("guards against invalid attempt counts", () => {
    expect(computeBackoffMs(0, () => 0.5)).toBe(1_000);
    expect(computeBackoffMs(-3, () => 0.5)).toBe(1_000);
  });
});

describe("requeueDeadJob — manual dead-letter recovery", () => {
  it("requeues a dead job in place (same row, attempts preserved)", async () => {
    await enqueueReady();
    await claimJobs(db, { owner: "w", leaseMs: 60_000, limit: 5, now: T0 });
    const job = fake.jobs[0]!;
    await failJob(db, { jobId: job.id as string, owner: "w", errorClass: "validation", now: at(1) });
    expect(job.status).toBe("dead");

    expect(await requeueDeadJob(db, { jobId: job.id as string, now: at(2) })).toBe(true);
    expect(job.status).toBe("pending");
    expect(job.finishedAt).toBeNull();
    expect(job.lastErrorClass).toBeNull();
    expect((job.availableAt as Date).getTime()).toBe(at(2).getTime());
    expect(job.attempts).toBe(1); // preserved by default — operator sees history

    // Now claimable again.
    const [again] = await claimJobs(db, { owner: "w2", leaseMs: 60_000, limit: 5, now: at(3) });
    expect(again?.id).toBe(job.id);
  });

  it("resetAttempts clears the counter; non-dead jobs are untouched", async () => {
    await enqueueReady();
    const job = fake.jobs[0]!;
    job.status = "dead";
    job.attempts = 5;
    expect(await requeueDeadJob(db, { jobId: job.id as string, now: T0, resetAttempts: true })).toBe(true);
    expect(job.attempts).toBe(0);

    expect(await requeueDeadJob(db, { jobId: job.id as string, now: T0 })).toBe(false); // now pending, not dead
  });
});

describe("durability across restart (persisted rows)", () => {
  it("a job enqueued before a 'restart' is claimed by a fresh worker afterwards", async () => {
    // Simulate process A: enqueue, then "crash" before claiming.
    const { jobId } = await enqueueJob(db, { jobType: "account.deletion", payload: { userId: "u" }, dedupeKey: "account.deletion:u" });

    // Simulate process B (fresh instance over the same persisted store):
    // createWorker is stateless over its db, so a new claimer sees the row.
    const [claimed] = await claimJobs(db, { owner: "worker-2", leaseMs: 60_000, limit: 5, now: at(50) });
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.attempts).toBe(1);
    expect(await completeJob(db, { jobId, owner: "worker-2", now: at(60) })).toBe(true);
    expect(fake.jobs[0]?.status).toBe("succeeded");
  });
});
