/**
 * Durable idempotency for economy mutations (Phase B6, contract §1.6).
 *
 * `shop.purchase` REQUIRES an `Idempotency-Key` header (UUID). The key,
 * endpoint and request fingerprint (sha-256 of endpoint + canonical JSON
 * body) live in the `IdempotencyRecord` table with the outcome:
 *
 * - same player + endpoint + key + same fingerprint + stored 2xx result
 *   → REPLAY (the route re-sends the stored status/body — no re-execution);
 * - same key + different fingerprint → MISMATCH (409, no mutation);
 * - same key while the first request is still executing → IN_PROGRESS
 *   (409, no mutation) — and because @@unique([profileId, endpoint, key])
 *   is a DATABASE constraint, a concurrent duplicate can never even create
 *   a second reservation (the create throws P2002, mapped below);
 * - an expired reservation (24 h retention, contract §1.6) is replaced;
 * - an in-progress reservation older than IN_PROGRESS_STALE_MS is taken
 *   over (its request crashed between reservation and completion — the
 *   transaction is the truth: it either committed, in which case a NEW key
 *   is required to see the effect, or it rolled back, so re-executing is
 *   safe).
 *
 * Failed attempts (no 2xx outcome to replay) DELETE their reservation so an
 * honest retry with the same key can re-execute — documented in B6_REPORT §6.
 * Raw keys are never logged (B1 redaction policy).
 */

import { createHash } from "node:crypto";

import { isUniqueViolation } from "@/lib/server/http";

/** Contract §1.6 retention: stored keys/outcomes live for 24 hours. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * Take-over threshold for a stuck "in_progress" reservation (crashed request).
 * Generous vs. any real transaction duration; nothing retries faster than
 * this in practice because the client only retries on transport failure.
 */
export const IN_PROGRESS_STALE_MS = 2 * 60 * 1000;

/** Endpoint scope names (contract §1.6: scoped per player + endpoint). */
export const ENDPOINT_SHOP_PURCHASE = "shop.purchase";

export interface IdempotencyKeyCheck {
  /** Valid = UUID v4-shaped (contract §1.6: "Idempotency-Key (UUID)"). */
  valid: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidIdempotencyKey(raw: string | null): raw is string {
  return typeof raw === "string" && UUID_PATTERN.test(raw);
}

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** sha-256 over endpoint + canonical body — the stored request fingerprint. */
export function requestFingerprint(endpoint: string, body: unknown): string {
  return createHash("sha256").update(`${endpoint}\n${canonicalJson(body)}`, "utf8").digest("hex");
}

export type BeginOutcome =
  | { kind: "OK"; recordId: string }
  | { kind: "REPLAY"; httpStatus: number; summary: unknown }
  | { kind: "MISMATCH" }
  | { kind: "IN_PROGRESS" };

interface IdempotencyRow {
  id: string;
  fingerprint: string;
  status: string;
  httpStatus: number | null;
  summary: unknown;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Structural shape of the Prisma client surface this module touches — keeps
 * the function testable with the in-memory fakeDb and honest about scope.
 */
export interface IdempotencyDb {
  idempotencyRecord: {
    create(args: {
      data: {
        profileId: string;
        endpoint: string;
        key: string;
        fingerprint: string;
        status: string;
        expiresAt: Date;
      };
    }): Promise<{ id: string }>;
    findUnique(args: {
      where: { profileId_endpoint_key: { profileId: string; endpoint: string; key: string } };
    }): Promise<IdempotencyRow | null>;
    updateMany(args: {
      where: {
        profileId: string;
        endpoint: string;
        key: string;
        status?: string;
      };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    deleteMany(args: {
      where: { profileId: string; endpoint: string; key: string; status?: string };
    }): Promise<{ count: number }>;
  };
}

/**
 * Reserve the key for this request (or resolve what a retry should get).
 * The caller MUST `completeIdempotency` after a successful commit or
 * `releaseIdempotency` after a failure/rollback.
 */
export async function beginIdempotency(
  db: IdempotencyDb,
  args: { profileId: string; endpoint: string; key: string; fingerprint: string; now?: number },
): Promise<BeginOutcome> {
  const now = args.now ?? Date.now();
  const expiresAt = new Date(now + IDEMPOTENCY_RETENTION_MS);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const record = await db.idempotencyRecord.create({
        data: {
          profileId: args.profileId,
          endpoint: args.endpoint,
          key: args.key,
          fingerprint: args.fingerprint,
          status: "in_progress",
          expiresAt,
        },
      });
      return { kind: "OK", recordId: record.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await db.idempotencyRecord.findUnique({
      where: {
        profileId_endpoint_key: {
          profileId: args.profileId,
          endpoint: args.endpoint,
          key: args.key,
        },
      },
    });
    if (!existing) continue; // raced with a cleanup — retry the reservation

    if (existing.expiresAt.getTime() <= now) {
      // Retention elapsed (contract §1.6): replace the stale record once.
      await db.idempotencyRecord.deleteMany({
        where: { profileId: args.profileId, endpoint: args.endpoint, key: args.key, status: existing.status },
      });
      continue;
    }

    if (existing.fingerprint !== args.fingerprint) return { kind: "MISMATCH" };

    if (existing.status === "completed" && typeof existing.httpStatus === "number") {
      return { kind: "REPLAY", httpStatus: existing.httpStatus, summary: existing.summary };
    }

    // status === "in_progress"
    if (now - existing.createdAt.getTime() > IN_PROGRESS_STALE_MS) {
      // Crashed request: take the reservation over (the DB transaction was
      // the truth — it committed fully or rolled back fully).
      const taken = await db.idempotencyRecord.updateMany({
        where: { profileId: args.profileId, endpoint: args.endpoint, key: args.key, status: "in_progress" },
        data: { createdAt: new Date(now) },
      });
      if (taken.count === 1) return { kind: "OK", recordId: existing.id };
      continue; // someone else took it — loop resolves against the new row
    }
    return { kind: "IN_PROGRESS" };
  }
  return { kind: "IN_PROGRESS" };
}

/** Store a successful outcome so identical retries replay it (contract §1.6). */
export async function completeIdempotency(
  db: IdempotencyDb,
  args: { profileId: string; endpoint: string; key: string; httpStatus: number; summary: unknown },
): Promise<void> {
  await db.idempotencyRecord.updateMany({
    where: { profileId: args.profileId, endpoint: args.endpoint, key: args.key, status: "in_progress" },
    data: { status: "completed", httpStatus: args.httpStatus, summary: args.summary as never },
  });
}

/**
 * Drop an in-progress reservation after a failed/rolled-back attempt so the
 * same key can legitimately retry (no stored result exists to replay).
 */
export async function releaseIdempotency(
  db: IdempotencyDb,
  args: { profileId: string; endpoint: string; key: string },
): Promise<void> {
  await db.idempotencyRecord.deleteMany({
    where: { profileId: args.profileId, endpoint: args.endpoint, key: args.key, status: "in_progress" },
  });
}
