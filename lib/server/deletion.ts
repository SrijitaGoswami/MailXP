/**
 * Account-deletion lifecycle processing (Phase B7, phase_b7.md §7).
 *
 * B4's me.delete already: sets User.deletionRequestedAt, revokes every
 * session, writes the auth.deletion_requested audit tombstone, and disables
 * login for pending accounts (login route returns the uniform 401). This
 * module performs the deferred PHYSICAL erasure when the worker runs the
 * account.deletion job.
 *
 * User decisions (2026-10-10, question round before B7 started):
 *   1. TIMING — immediate: erasure runs on the worker's next tick after the
 *      request (the contract's 202 already describes deletion as async).
 *      There is no grace period and no cancel flow in the contract.
 *   2. SCOPE — full personal wipe in ONE transaction: user, profile,
 *      sessions, auth tokens, inventory, DraftCoin ledger, idempotency
 *      records. DraftCoin is simulated (B14 real money does not exist yet),
 *      so the ledger is not a legal financial record. AuditEvent rows always
 *      survive — userId SetNull tombstones, per B4/contract (§2 me.delete:
 *      deletion audits are "retained as a non-personal tombstone").
 *
 * Safety properties (§7):
 *   - only accounts whose deletionRequestedAt marker is set are erased; the
 *     handler throws PermanentJobError("not_requested") otherwise, so a
 *     mis-routed job dead-letters WITHOUT touching the account;
 *   - idempotent: "not_found" (already erased) is a success no-op, so
 *     at-least-once redelivery never errors and never double-deletes;
 *   - failure mid-way rolls back the whole $transaction — durable state
 *     (the marker, the job row) stays put for a safe retry; the marker is
 *     never undone;
 *   - NO provider code: no Gmail/Google/Calendar side effects run HERE —
 *     B8 added a BEST-EFFORT remote revocation of stored Google refresh
 *     tokens before the wipe (revokeStoredGoogleCredentials); a failed or
 *     unavailable revoke never blocks erasure because the local rows are
 *     still deleted (fail closed locally, honestly reported);
 *   - Gmail messages were never mirrored locally, so nothing mail-related is
 *     deleted beyond local rows.
 */

import type { Prisma } from "@prisma/client";
import { recordAudit } from "@/lib/server/audit";
import { revokeGoogleToken } from "@/lib/server/googleOAuth";
import { PermanentJobError } from "@/lib/server/jobQueue";
import { logger } from "@/lib/server/logger";
import { loadTokenKey, openSecret } from "@/lib/server/secretBox";

export interface DeletionTxDb {
  user: {
    findUnique(args: {
      where: { id: string };
    }): Promise<{ id: string; deletionRequestedAt: Date | null } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  auditEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  session: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  authToken: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  inventoryItem: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  ledgerEntry: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  idempotencyRecord: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  // B8 (phase_b8.md §7): erasure must leave no Google credentials or OAuth
  // state behind — deleted explicitly alongside the other dependents.
  googleConnection: {
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
    findMany(args: { where: Record<string, unknown>; select: { id: boolean } }): Promise<Array<{ id: string }>>;
  };
  // Prisma exposes model OAuthState as `oAuthState` (first letter lowered).
  oAuthState: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  // B9: account deletion must erase synced email content + sync state
  // (phase_b9.md §5/§8). Deleted explicitly by connection below; the FK
  // cascade would also remove them on real PostgreSQL, but the explicit
  // deleteMany keeps the test double honest and the order observable.
  gmailMessage: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  gmailSyncState: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  // B10: AI analysis rows hang off each connection; usage counters and the
  // pause flag hang off the profile (phase_b10.md §5).
  emailAnalysis: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  aiDailyUsage: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  aiSettings: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  playerProfile: {
    findUnique(args: {
      where: { userId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

export interface DeletionDb {
  $transaction<T>(fn: (tx: DeletionTxDb) => Promise<T>): Promise<T>;
  /** B8: pre-erasure credential inventory for best-effort remote revocation. */
  googleConnection: {
    findMany(args: {
      where: Record<string, unknown>;
    }): Promise<
      Array<{
        id: string;
        refreshTokenCipher: string | null;
        refreshTokenNonce: string | null;
        refreshTokenTag: string | null;
      }>
    >;
  };
}

export type EraseOutcome =
  | { erased: true; reason: "erased" }
  | { erased: false; reason: "not_found" | "not_requested" };

/**
 * Physically erase one deletion-requested account, atomically.
 *
 * Works identically on real PostgreSQL and on the test double: dependent
 * rows are deleted EXPLICITLY in FK-safe order instead of relying on cascade
 * behavior (fakeDb has no FK engine), and audit tombstoning is done with an
 * explicit updateMany(userId -> null) that mirrors ON DELETE SET NULL —
 * including the erasure-evidence row, written with userId null from the
 * start so its final state matches what PostgreSQL would produce anyway.
 */
export async function eraseAccount(db: DeletionDb, input: { userId: string; requestId: string }): Promise<EraseOutcome> {
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) return { erased: false, reason: "not_found" } as const;
    if (user.deletionRequestedAt === null) return { erased: false, reason: "not_requested" } as const;

    // 1. Tombstone every existing audit row for this user first (mirrors the
    //    ON DELETE SET NULL the schema declares; explicit so the behavior is
    //    observable under the fake as well as real PostgreSQL).
    await tx.auditEvent.updateMany({ where: { userId: input.userId }, data: { userId: null } });

    // 2. Durable, non-personal evidence that erasure ran. userId is null
    //    (the user row is about to disappear); requestId is the job id, which
    //    links the action to the operational record.
    await recordAudit(tx as unknown as Prisma.TransactionClient, {
      userId: null,
      eventType: "auth.account_erased",
      requestId: input.requestId,
    });

    // 3. Dependents first (explicit order — valid on PG, sufficient on fake).
    const profile = await tx.playerProfile.findUnique({ where: { userId: input.userId }, select: { id: true } });
    if (profile) {
      await tx.inventoryItem.deleteMany({ where: { profileId: profile.id } });
      await tx.ledgerEntry.deleteMany({ where: { profileId: profile.id } });
      await tx.idempotencyRecord.deleteMany({ where: { profileId: profile.id } });
      // B10: AI daily usage counters and the global AI pause flag are
      // profile-scoped personal data — no row may outlive the account.
      await tx.aiDailyUsage.deleteMany({ where: { profileId: profile.id } });
      await tx.aiSettings.deleteMany({ where: { profileId: profile.id } });
    }
    await tx.playerProfile.deleteMany({ where: { userId: input.userId } });
    await tx.session.deleteMany({ where: { userId: input.userId } });
    await tx.authToken.deleteMany({ where: { userId: input.userId } });
    // B8: no Google credential or OAuth-state row may survive an erased user
    // (phase_b8.md §7). Cascade FKs would also remove them on real PostgreSQL;
    // explicit deletes keep the test double honest and the order observable.
    await tx.oAuthState.deleteMany({ where: { userId: input.userId } });
    // B9: erase synced email content + sync state for every mailbox this user
    // ever connected (including released rows whose connection the FK cascade
    // below would also remove). Delete the mail rows FIRST by connection id so
    // nothing personal survives the wipe (phase_b9.md §5/§8).
    const connections = await tx.googleConnection.findMany({
      where: { userId: input.userId },
      select: { id: true },
    });
    for (const connection of connections) {
      // B10: AI analysis of this mailbox's messages goes with them (MASTER
      // §4.3 "deletes retained email analysis"; spec §5 cleanup). Delete
      // analysis FIRST so nothing personal survives even without FK cascade.
      await tx.emailAnalysis.deleteMany({ where: { googleConnectionId: connection.id } });
      await tx.gmailMessage.deleteMany({ where: { googleConnectionId: connection.id } });
      await tx.gmailSyncState.deleteMany({ where: { googleConnectionId: connection.id } });
    }
    await tx.googleConnection.deleteMany({ where: { userId: input.userId } });

    // 4. The user row last.
    await tx.user.delete({ where: { id: input.userId } });
    return { erased: true, reason: "erased" } as const;
  });
}

/**
 * B8 — best-effort remote revocation before physical erasure.
 *
 * For every stored connection of the account: open the sealed refresh token
 * (fail closed — a missing/mismatched key or tampered ciphertext simply skips
 * that row) and ask Google to revoke it. NEVER blocks or fails the erasure:
 * the transaction below deletes the local rows either way, and the outcome is
 * logged as a category only (confirmed/skipped/failed — no tokens, no emails).
 */
async function revokeStoredGoogleCredentials(db: DeletionDb, userId: string, requestId: string): Promise<void> {
  let rows: Awaited<ReturnType<DeletionDb["googleConnection"]["findMany"]>>;
  try {
    rows = await db.googleConnection.findMany({ where: { userId } });
  } catch {
    logger.warn("deletion.google_revoke", { requestId, outcome: "inventory_failed" });
    return;
  }
  if (rows.length === 0) return;

  let key: Buffer;
  try {
    key = loadTokenKey(); // throws SERVER_ENV_* when the key is absent
  } catch {
    logger.warn("deletion.google_revoke", { requestId, outcome: "skipped_no_key", count: rows.length });
    return;
  }

  let confirmed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.refreshTokenCipher === null || row.refreshTokenNonce === null || row.refreshTokenTag === null) {
      skipped += 1;
      continue;
    }
    try {
      const token = openSecret(
        { cipher: row.refreshTokenCipher, nonce: row.refreshTokenNonce, tag: row.refreshTokenTag },
        key,
      );
      if (await revokeGoogleToken(token)) confirmed += 1;
      else skipped += 1;
    } catch {
      skipped += 1; // unreadable ciphertext — local row still gets deleted
    }
  }
  logger.info("deletion.google_revoke", { requestId, outcome: "done", count: rows.length, confirmed, skipped });
}

/**
 * The account.deletion JOB HANDLER (registered in worker.ts).
 * Validates the payload BEFORE any side effect; classifies outcomes:
 *   - marker missing   -> PermanentJobError("not_requested"): a non-requested
 *     account is NEVER erased, and the job dead-letters without retrying;
 *   - user gone        -> success no-op (idempotent redelivery after an
 *     earlier attempt already finished the job);
 *   - transient errors -> bubble up (classified by the dispatcher, retried
 *     with bounded backoff; the transaction rolled back, marker intact).
 */
export async function runAccountDeletion(db: DeletionDb, payload: unknown, requestId: string): Promise<void> {
  const userId = (payload as { userId?: unknown } | null | undefined)?.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new PermanentJobError("validation", "deletion: payload must carry a userId string");
  }
  // B8: revoke Google access first (best-effort, outside the wipe transaction
  // — never a network call inside a database transaction). Failures are logged
  // and do not stop the local erase.
  await revokeStoredGoogleCredentials(db, userId, requestId);
  const outcome = await eraseAccount(db, { userId, requestId });
  if (outcome.reason === "not_requested") {
    throw new PermanentJobError("not_requested", "deletion: account never requested deletion");
  }
}
