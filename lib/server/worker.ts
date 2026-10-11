/**
 * In-process development worker / dispatcher (Phase B7, phase_b7.md §6).
 *
 * One loop per process, started from Next.js's instrumentation hook
 * (instrumentation.ts -> workerRuntime.ts), that every bounded poll interval:
 *   1. relays due outbox events into job rows (outbox.ts),
 *   2. claims a small batch of runnable jobs (jobQueue.ts conditional update),
 *   3. executes handlers from an EXPLICIT registry,
 *   4. records success only after the handler returns, or classifies the
 *      failure into retry-with-backoff / terminal dead / lost-lease.
 *
 * Safety properties (§6):
 *   - no loop ever starts inside a route handler or per request; the only
 *     entry point is start() (instrumentation) or runOnce() (tests/ops);
 *   - dev hot reload cannot stack loops: the globalThis guard in
 *     workerRuntime.ts keeps exactly one worker per process, and start() on
 *     an already-started worker is a no-op;
 *   - WORKER_ENABLED=false (or a build/static-render phase) skips startup
 *     entirely, so the worker being disabled never blocks `next build`;
 *   - unknown job types are dead-lettered WITHOUT code execution — handlers
 *     live in JOB_HANDLERS and nothing else is ever invoked;
 *   - logs are structured and redacted: only whitelisted scalar fields
 *     (ids, types, attempts, counts, error classes, durations) are emitted —
 *     never payloads, cookies, tokens, or email content;
 *   - clean shutdown where practical: stop() cancels the pending timer and
 *     awaits the in-flight tick; SIGTERM/SIGINT trigger it from
 *     workerRuntime.ts. Durability does NOT depend on a graceful stop — an
 *     interrupted job keeps its row, its lease expires, and the next claim
 *     re-runs it (handlers are idempotent).
 *
 * LIMITATION (documented in B7_REPORT.md §13): an in-process worker is a
 * development / single-process guarantee. It is NOT a production multi-
 * instance delivery guarantee — competing instances would each poll (safe,
 * thanks to leases) but there is no cross-instance coordination, no leader
 * election, and no guaranteed per-instance presence. Cloud Tasks or Pub/Sub
 * remain deferred to production deployment per the B0 queue decision.
 */

import { errorCategory } from "@/lib/server/http";
import { logger } from "@/lib/server/logger";
import { getDb } from "@/lib/server/prisma";
import {
  claimJobs,
  completeJob,
  computeBackoffMs,
  failJob,
  JobDeferredError,
  PermanentJobError,
  type FailOutcome,
  type JobRow,
  type QueueDb,
} from "@/lib/server/jobQueue";
import { relayOutboxEvents, type RelayDb } from "@/lib/server/outbox";
import { runAccountDeletion, type DeletionDb } from "@/lib/server/deletion";
import { runGmailSync, type GmailSyncDb } from "@/lib/server/gmailSync";
import { runAiAnalysis, type AiAnalysisDb } from "@/lib/server/aiAnalysis";

// ---------------------------------------------------------------------------
// Handler registry — the ONLY code the worker may execute for a job.
// ---------------------------------------------------------------------------

export interface JobHandlerContext {
  db: WorkerDb;
  payload: unknown;
  jobId: string;
  requestId: string; // correlation: the job id doubles as the audit requestId
  attempts: number; // 1-based delivery number for this run
  leaseOwner: string; // this worker's claim owner (B10: needed to defer)
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<void>;
export type JobHandlerRegistry = Record<string, JobHandler>;

/** Every B7 job type (phase_b7.md §8: only grounded, approved types). */
export const JOB_HANDLERS: JobHandlerRegistry = {
  "account.deletion": async ({ db, payload, requestId }) => runAccountDeletion(db, payload, requestId),
  "gmail.sync": async ({ db, payload, requestId }) => {
    await runGmailSync(db as unknown as GmailSyncDb, payload, requestId);
  },
  // B10 (phase_b10.md §7): advisory analysis only — no Gmail mutation.
  "ai.analysis": async ({ db, payload, jobId, attempts, leaseOwner }) => {
    await runAiAnalysis(db as unknown as AiAnalysisDb, payload, { jobId, attempts, leaseOwner });
  },
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export type WorkerDb = QueueDb & RelayDb & DeletionDb & GmailSyncDb & AiAnalysisDb;

export interface WorkerOptions {
  /** Injectable database (tests pass the fake); default lazy getDb(). */
  db?: WorkerDb;
  handlers?: JobHandlerRegistry;
  owner?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  now?: () => Date;
  random?: () => number;
}

export interface TickResult {
  relayed: number;
  relayDead: number;
  claimed: number;
  succeeded: number;
  deferred: number;
  retried: number;
  dead: number;
  lost: number;
}

export interface WorkerHandle {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<TickResult>;
  isStarted(): boolean;
}

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_BATCH_SIZE = 5;

function emptyTick(): TickResult {
  return { relayed: 0, relayDead: 0, claimed: 0, succeeded: 0, deferred: 0, retried: 0, dead: 0, lost: 0 };
}

export function createWorker(options: WorkerOptions = {}): WorkerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? 60_000;
  const owner = options.owner ?? `mailxp-worker-${process.pid}`;
  const handlers = options.handlers ?? JOB_HANDLERS;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;

  // Lazily resolved per tick so `getDb()`'s env validation happens at first
  // server use, never at import/build time (B3 convention).
  const resolveDb = (): WorkerDb => options.db ?? (getDb() as unknown as WorkerDb);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopping = false;
  let inFlight: Promise<unknown> | null = null;

  async function dispatch(db: WorkerDb, job: JobRow): Promise<FailOutcome | "succeeded" | "deferred"> {
    const handler = handlers[job.jobType];
    const startedAt = now();

    if (!handler) {
      // Unknown type: never execute anything — dead-letter immediately.
      const outcome = await failJob(db, {
        jobId: job.id,
        owner,
        errorClass: "unsupported_type",
        permanent: true,
        now: startedAt,
      });
      logger.warn("worker.job.failed", {
        jobId: job.id,
        jobType: job.jobType,
        attempts: job.attempts,
        errorClass: "unsupported_type",
        outcome,
      });
      return outcome;
    }

    try {
      await handler({
        db,
        payload: job.payload,
        jobId: job.id,
        requestId: job.id,
        attempts: job.attempts,
        leaseOwner: owner,
      });
      const ok = await completeJob(db, { jobId: job.id, owner, now: startedAt });
      if (ok) {
        logger.info("worker.job.ok", {
          jobId: job.id,
          jobType: job.jobType,
          attempts: job.attempts,
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
        });
        return "succeeded";
      }
      // Our lease expired while the handler ran and another worker took over:
      // do not overwrite their record. The side effect was idempotent anyway.
      logger.warn("worker.job.lease_lost", {
        jobId: job.id,
        jobType: job.jobType,
        attempts: job.attempts,
      });
      return "lost";
    } catch (error) {
      // B10 policy wait: the handler already put the job back to pending with
      // a future availableAt — record neither success nor failure.
      if (error instanceof JobDeferredError) {
        logger.info("worker.job.deferred", {
          jobId: job.id,
          jobType: job.jobType,
          reason: error.reason,
        });
        return "deferred";
      }
      const permanent = error instanceof PermanentJobError;
      const errorClass = permanent ? error.errorClass : errorCategory(error);
      const outcome = await failJob(db, {
        jobId: job.id,
        owner,
        errorClass,
        permanent,
        now: now(),
        random,
      });
      // errorClass is a safe category ("db", "validation", "unexpected", ...)
      // — never the raw error message, never the payload.
      logger.warn("worker.job.failed", {
        jobId: job.id,
        jobType: job.jobType,
        attempts: job.attempts,
        errorClass,
        outcome,
      });
      return outcome;
    }
  }

  async function runOnce(): Promise<TickResult> {
    const db = resolveDb();
    const result = emptyTick();
    const tickAt = now();

    try {
      const relay = await relayOutboxEvents(db, { now: tickAt, limit: batchSize, random });
      result.relayed = relay.published;
      result.relayDead = relay.dead;
    } catch (error) {
      logger.warn("worker.relay.failed", { errorClass: errorCategory(error) });
    }

    let jobs: JobRow[] = [];
    try {
      jobs = await claimJobs(db, { owner, limit: batchSize, leaseMs, now: now() });
    } catch (error) {
      logger.warn("worker.claim.failed", { errorClass: errorCategory(error) });
      return result;
    }
    result.claimed = jobs.length;

    for (const job of jobs) {
      const outcome = await dispatch(db, job);
      if (outcome === "succeeded") result.succeeded += 1;
      else if (outcome === "deferred") result.deferred += 1;
      else if (outcome === "retry") result.retried += 1;
      else if (outcome === "dead") result.dead += 1;
      else if (outcome === "lost") result.lost += 1;
    }

    const active =
      result.relayed > 0 ||
      result.relayDead > 0 ||
      result.claimed > 0 ||
      result.succeeded > 0 ||
      result.deferred > 0 ||
      result.retried > 0 ||
      result.dead > 0 ||
      result.lost > 0;
    if (active) {
      logger.info("worker.tick", {
        owner,
        relayed: result.relayed,
        relayDead: result.relayDead,
        claimed: result.claimed,
        succeeded: result.succeeded,
        deferred: result.deferred,
        retried: result.retried,
        dead: result.dead,
        lost: result.lost,
      });
    }
    return result;
  }

  function scheduleNext(): void {
    if (stopping || !started) return;
    timer = setTimeout(() => {
      void tick();
    }, pollIntervalMs);
    // Never hold the process open just for polling (tests, graceful exit).
    timer.unref?.();
  }

  function tick(): void {
    const run = runOnce()
      .catch((error: unknown) => {
        logger.warn("worker.tick.failed", { errorClass: errorCategory(error) });
      })
      .finally(() => {
        inFlight = null;
        scheduleNext();
      });
    inFlight = run;
  }

  return {
    start(): void {
      if (started) return; // hot-reload / double-instrumentation guard
      started = true;
      stopping = false;
      logger.info("worker.started", { owner, pollIntervalMs, batchSize, leaseMs });
      void tick(); // first pass immediately; afterwards at the bounded interval
    },
    async stop(): Promise<void> {
      stopping = true;
      started = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* runOnce errors are already logged inside tick() */
        }
      }
      logger.info("worker.stopped", { owner });
    },
    runOnce,
    isStarted: () => started,
  };
}
