/**
 * Transactional outbox (Phase B7, phase_b7.md §4).
 *
 * An outbox row is created in the SAME database transaction as the domain
 * change it represents — me.delete writes User.deletionRequestedAt and the
 * account.deletion_requested event in one $transaction. Consequences:
 *   - commit   => the event exists (durable, survives restart);
 *   - rollback => no event (a rolled-back domain change never publishes);
 *   - nothing is emitted before the source transaction commits, because the
 *     relay only ever sees committed rows in PostgreSQL.
 *
 * relayOutboxEvents converts pending events into Job rows idempotently:
 * Job.outboxEventId is UNIQUE, so a crash between "job created" and "event
 * marked published" re-runs the relay, hits the unique index, resolves to the
 * existing job, and completes the acknowledgement — no duplicates, no lost
 * events (at-least-once conversion; the job handler itself is idempotent).
 *
 * Payload policy (§4): internal identifiers only — never cookies, session or
 * auth tokens, passwords, provider credentials, message bodies, or email
 * addresses. Payloads are never logged; relay logs pass eventType/errorClass
 * scalars through the redacting logger only.
 *
 * Only event types that REQUIRE asynchronous work are emitted: B6 purchases
 * and rewards stay synchronous and were deliberately left out (§4).
 */

import type { Prisma } from "@prisma/client";
import { errorCategory } from "@/lib/server/http";
import { logger } from "@/lib/server/logger";
import {
  computeBackoffMs,
  enqueueJob,
  MAX_ATTEMPTS,
  PermanentJobError,
  type EnqueueResult,
  type QueueDb,
} from "@/lib/server/jobQueue";

// ---------------------------------------------------------------------------
// Rows + database surface (structural — satisfies real Prisma and the fake).
// ---------------------------------------------------------------------------

export type OutboxStatusValue = "pending" | "published" | "dead";

export interface OutboxEventRow {
  id: string;
  eventType: string;
  eventVersion: number;
  payload: unknown;
  status: OutboxStatusValue;
  attempts: number;
  nextAttemptAt: Date;
  lastErrorClass: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface OutboxDb {
  outboxEvent: {
    create(args: {
      data: {
        eventType: string;
        // Nullable Json: omit for SQL NULL (Prisma rejects plain null on
        // create); the fake defaults payload to null too.
        payload?: Prisma.InputJsonValue;
        eventVersion?: number;
      };
    }): Promise<{ id: string }>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
    }): Promise<OutboxEventRow[]>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * The slice a domain transaction needs — pass your `tx` straight in. Narrowed
 * to `create` on purpose: callers only ever append inside their own
 * $transaction, so only that method must be structurally compatible with
 * Prisma's TransactionClient.
 */
export type OutboxAppendDb = { outboxEvent: Pick<OutboxDb["outboxEvent"], "create"> };

export interface AppendInput {
  eventType: string;
  payload?: Prisma.InputJsonValue;
  eventVersion?: number;
}

/**
 * Append one event — MUST be called inside the same $transaction as the
 * domain change (callers are responsible for the tx; the signature only
 * accepts a create-capable client so it can be handed `tx` directly).
 */
export async function appendOutboxEvent(tx: OutboxAppendDb, input: AppendInput): Promise<string> {
  const row = await tx.outboxEvent.create({
    data: {
      eventType: input.eventType,
      ...(input.payload !== undefined && input.payload !== null ? { payload: input.payload } : {}),
      ...(input.eventVersion !== undefined ? { eventVersion: input.eventVersion } : {}),
    },
  });
  return row.id;
}

// ---------------------------------------------------------------------------
// Event -> job planning registry. Unknown event types are rejected by the
// relay (terminal "unsupported_type"); malformed payloads are rejected by the
// planner (terminal "validation") — neither executes any code.
// ---------------------------------------------------------------------------

export interface OutboxDispatch {
  jobType: string;
  payload: Prisma.InputJsonValue;
  dedupeKey?: string;
}

export type OutboxPlanner = (payload: unknown) => OutboxDispatch;

export const OUTBOX_PLANNERS: Readonly<Record<string, OutboxPlanner>> = {
  // B4 deletion marker (me.delete) -> B7 erasure job. One live job per
  // account ever: the unique dedupeKey collapses repeated requests/relays.
  "account.deletion_requested": (payload): OutboxDispatch => {
    const userId = (payload as { userId?: unknown } | null | undefined)?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      throw new PermanentJobError("validation", "outbox: deletion event requires userId");
    }
    return {
      jobType: "account.deletion",
      payload: { userId },
      dedupeKey: `account.deletion:${userId}`,
    };
  },
  // B9 Gmail sync: a durable "sync requested" event (written in the same
  // transaction that establishes/refreshes a connection) becomes a gmail.sync
  // job. The dedupeKey collapses repeated requests to ONE live job per mailbox
  // (phase_b9.md §6 "coalesce duplicate pending/running sync jobs per
  // connection"). A dead job is requeued in place, never duplicated.
  "gmail.sync_requested": (payload): OutboxDispatch => {
    const googleConnectionId = (payload as { googleConnectionId?: unknown } | null | undefined)?.googleConnectionId;
    if (typeof googleConnectionId !== "string" || googleConnectionId.length === 0) {
      throw new PermanentJobError("validation", "outbox: gmail sync event requires googleConnectionId");
    }
    return {
      jobType: "gmail.sync",
      payload: { googleConnectionId },
      dedupeKey: `gmail.sync:${googleConnectionId}`,
    };
  },
  // B10 (phase_b10.md §7): advisory analysis of ONE message. Written inside
  // the gmail.sync commit transaction for auto-enqueue; the payload carries
  // the internal message row id only — never content. One live job per
  // message ever (unique dedupeKey), so repeated syncs cannot duplicate
  // billable work (spec §3.3).
  "ai.analysis_requested": (payload): OutboxDispatch => {
    const messageId = (payload as { messageId?: unknown } | null | undefined)?.messageId;
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new PermanentJobError("validation", "outbox: ai analysis event requires messageId");
    }
    return {
      jobType: "ai.analysis",
      payload: { messageId },
      dedupeKey: `ai.analysis:${messageId}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

export interface RelayOptions {
  now: Date;
  limit: number;
  random?: () => number;
}

export interface RelayResult {
  scanned: number;
  published: number;
  dead: number;
  deferred: number;
}

export type RelayDb = OutboxDb & Pick<QueueDb, "job">;

/**
 * Convert due pending events into jobs, oldest first. Per event:
 *   planner validates -> enqueueJob (idempotent via unique outboxEventId)
 *   -> acknowledge by marking the event published.
 * A transient failure (db) backs the event off with the same bounded
 * exponential policy as jobs and dead-letters after MAX_ATTEMPTS; permanent
 * failures (unknown type, invalid payload) dead-letter immediately. The event
 * row is NEVER deleted — status is the durable audit of the outcome.
 */
export async function relayOutboxEvents(db: RelayDb, options: RelayOptions): Promise<RelayResult> {
  const events = await db.outboxEvent.findMany({
    where: { status: "pending", nextAttemptAt: { lte: options.now } },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: options.limit,
  });

  const result: RelayResult = { scanned: events.length, published: 0, dead: 0, deferred: 0 };

  for (const event of events) {
    try {
      const planner = OUTBOX_PLANNERS[event.eventType];
      if (!planner) {
        throw new PermanentJobError("unsupported_type", "outbox: unknown event type");
      }
      const dispatch = planner(event.payload);
      const enqueued: EnqueueResult = await enqueueJob(db, {
        jobType: dispatch.jobType,
        payload: dispatch.payload,
        dedupeKey: dispatch.dedupeKey ?? null,
        outboxEventId: event.id,
      });
      await db.outboxEvent.update({
        where: { id: event.id },
        data: { status: "published", publishedAt: options.now, lastErrorClass: null },
      });
      result.published += 1;
      logger.info("outbox.published", {
        eventType: event.eventType,
        jobId: enqueued.jobId,
        created: enqueued.created,
      });
    } catch (error) {
      const permanent = error instanceof PermanentJobError;
      const errorClass = permanent ? error.errorClass : errorCategory(error);
      const attempts = event.attempts + 1;
      if (permanent || attempts >= MAX_ATTEMPTS) {
        await db.outboxEvent.update({
          where: { id: event.id },
          data: { status: "dead", attempts, lastErrorClass: errorClass },
        });
        result.dead += 1;
        logger.warn("outbox.dead", { eventType: event.eventType, attempts, errorClass });
      } else {
        const delay = computeBackoffMs(attempts, options.random ?? Math.random);
        await db.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts,
            lastErrorClass: errorClass,
            nextAttemptAt: new Date(options.now.getTime() + delay),
          },
        });
        result.deferred += 1;
        logger.warn("outbox.deferred", { eventType: event.eventType, attempts, errorClass });
      }
    }
  }
  return result;
}
