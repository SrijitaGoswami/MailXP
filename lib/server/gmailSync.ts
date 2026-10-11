/**
 * Gmail sync engine (Phase B9, spec §6) — the durable `gmail.sync` job.
 *
 * Runs on the B7 worker, NEVER inline in a route or UI request (spec §6). The
 * browser only ever *enqueues* a sync; this handler does the provider work.
 *
 * Safety properties (spec §4/§6):
 * - Re-checks connection STATUS and OWNERSHIP at the top of every run: a job
 *   that outlives a disconnect/release re-reads the row and becomes a harmless
 *   no-op (dead-lettered as `not_requested`) — the browser cannot choose a
 *   trusted connection/user (spec §4).
 * - Uses ONLY the granted scopes stored on the connection. If `gmail.modify`
 *   (or `gmail.readonly`) was not granted, it does NOT widen silently — it
 *   marks the mailbox `reconnect_required` (spec §4).
 * - Refresh token is opened server-side (secretBox) and exchanged for a
 *   short-lived access token that lives only for this run. A revoked/expired
 *   token (`invalid_grant`) → `reconnect_required`, no retry storm (spec §4).
 * - The history cursor advances ONLY after the corresponding message changes
 *   are durably committed in the SAME transaction. A partial failure rolls the
 *   cursor back with the data, so the last committed cursor is never corrupted
 *   (spec §6).
 * - An EXPIRED cursor (Gmail 404 on history.list) triggers a CONTROLLED resync
 *   (clear cursor → re-enqueue a fresh initial sync), not an endless loop
 *   (spec §6).
 * - Coalescing is enforced by the Job.dedupeKey `gmail.sync:<connectionId>` —
 *   repeated "sync now" taps / retries collapse to one live row (spec §6).
 *
 * No Gmail mutations happen here (send/draft/label/mark-read are B11).
 */

import { PermanentJobError } from "@/lib/server/jobQueue";
import { logger } from "@/lib/server/logger";
import { loadTokenKey } from "@/lib/server/secretBox";
import { openStoredRefreshToken } from "@/lib/server/googleOAuth";
import {
  GmailApiError,
  GmailReconnectRequiredError,
  getMessage,
  getProfile,
  listHistory,
  listMessages,
  refreshAccessToken,
  type FetchFn,
} from "@/lib/server/gmailApi";
import { extractMessage } from "@/lib/server/gmailMime";
import { appendAnalysisEventsForMessages } from "@/lib/server/aiAnalysis";
import { publishSse } from "@/lib/server/sseHub";

/** Bounded page sizes so a huge mailbox never loads unbounded (spec §5). */
export const SYNC_PAGE_SIZE = 50;
export const SYNC_BATCH_DETAILS = 10;
/** Reconciliation delay when a mailbox is backed off or delayed (spec §6). */
export const RECONCILE_DELAY_MS = 5 * 60 * 1000;

// Structural DB shapes so the engine runs on real Prisma and the test fake.
// Narrow on purpose — only the methods this handler touches.

interface ConnectionRow {
  id: string;
  userId: string;
  status: string;
  scopes: string;
  refreshTokenCipher: string | null;
  refreshTokenNonce: string | null;
  refreshTokenTag: string | null;
}

interface SyncStateRow {
  id: string;
  googleConnectionId: string;
  status: string;
  historyId: string | null;
  historyWindowDays: number;
}

interface GmailSyncTx {
  gmailMessage: {
    upsert(args: {
      where: { googleConnectionId_gmailMessageId: { googleConnectionId: string; gmailMessageId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ id: string; internalDate: Date }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  gmailSyncState: {
    update(args: { where: { googleConnectionId: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface GmailSyncDb {
  $transaction<T>(fn: (tx: GmailSyncTx) => Promise<T>): Promise<T>;
  googleConnection: {
    findUnique(args: { where: { id: string } }): Promise<ConnectionRow | null>;
  };
  gmailSyncState: {
    findUnique(args: { where: { googleConnectionId: string } }): Promise<SyncStateRow | null>;
    update(args: { where: { googleConnectionId: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  gmailMessage: {
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

export type SyncMode = "initial" | "incremental";

export interface SyncPayload {
  googleConnectionId: string;
}

/** A granted scope check — accept the read scopes this app was consented for. */
function hasReadScope(scopes: string): boolean {
  return (
    scopes.includes("https://www.googleapis.com/auth/gmail.modify") ||
    scopes.includes("https://www.googleapis.com/auth/gmail.readonly")
  );
}

const GMAIL_SCOPE_ERROR = "GmailApiError";

function classify(error: unknown): string {
  if (error instanceof GmailApiError) return error.category;
  return "unexpected";
}

/**
 * Persist one batch of extracted messages and (optionally) the new cursor in a
 * SINGLE transaction — the cursor never advances past uncommitted data (spec
 * §6). Upserts are keyed on (connectionId, gmailMessageId) so redelivery is
 * idempotent (spec §5/§6).
 */
async function commitMessages(
  db: GmailSyncDb,
  connectionId: string,
  extracted: Array<{ gmailMessageId: string; data: Record<string, unknown> }>,
  nextCursor: string | null,
): Promise<void> {
  await db.$transaction(async (tx) => {
    for (const message of extracted) {
      await tx.gmailMessage.upsert({
        where: {
          googleConnectionId_gmailMessageId: {
            googleConnectionId: connectionId,
            gmailMessageId: message.gmailMessageId,
          },
        },
        create: { googleConnectionId: connectionId, gmailMessageId: message.gmailMessageId, ...message.data },
        update: message.data,
      });
    }
    if (nextCursor !== null) {
      await tx.gmailSyncState.update({
        where: { googleConnectionId: connectionId },
        data: { historyId: nextCursor, lastSuccessAt: new Date(), lastErrorClass: null },
      });
    }
  });
}

async function markStatus(db: GmailSyncDb, connectionId: string, data: Record<string, unknown>): Promise<void> {
  try {
    await db.gmailSyncState.update({ where: { googleConnectionId: connectionId }, data });
  } catch {
    // A missing sync-state row (race: released mid-run) is not worth failing
    // the whole job over — the connection re-check already guards real work.
  }
}

export interface SyncRunResult {
  outcome: "synced" | "noop" | "reconnect_required" | "resync_scheduled";
  imported: number;
  removed: number;
  mode: SyncMode | null;
}
/**
 * Run one sync for a connection. Throws GmailApiError/GmailReconnectRequiredError
 * (classified by the dispatcher for retry) or PermanentJobError (dead-letter).
 */
export async function runGmailSync(
  db: GmailSyncDb,
  payload: unknown,
  requestId: string,
  fetchFn: FetchFn = fetch,
): Promise<SyncRunResult> {
  const googleConnectionId = (payload as SyncPayload | null | undefined)?.googleConnectionId;
  if (typeof googleConnectionId !== "string" || googleConnectionId === "") {
    throw new PermanentJobError("validation", "gmail.sync: payload must carry a googleConnectionId");
  }

  // 1. Re-check connection + ownership BEFORE any provider call (spec §4). A
  //    released/disconnected mailbox makes this job a harmless no-op.
  const connection = await db.googleConnection.findUnique({ where: { id: googleConnectionId } });
  if (!connection || connection.status !== "connected") {
    throw new PermanentJobError("not_requested", "gmail.sync: mailbox no longer connected");
  }

  // 2. Scope gate — never widen silently (spec §4).
  if (!hasReadScope(connection.scopes)) {
    await markStatus(db, googleConnectionId, { status: "reconnect_required", lastErrorClass: "scope" });
    logger.warn("gmail.sync", { requestId, connectionId: googleConnectionId, outcome: "scope_missing" });
    return { outcome: "reconnect_required", imported: 0, removed: 0, mode: null };
  }

  // 3. Open the sealed refresh token (fail closed → reconnect-required).
  let refreshToken: string | null = null;
  try {
    refreshToken = openStoredRefreshToken(connection as never, loadTokenKey());
  } catch {
    refreshToken = null;
  }
  if (refreshToken === null) {
    await markStatus(db, googleConnectionId, { status: "reconnect_required", lastErrorClass: "credentials" });
    return { outcome: "reconnect_required", imported: 0, removed: 0, mode: null };
  }

  // 4. Refresh an in-memory access token (never persisted).
  let accessToken: string;
  try {
    const config = requireTokenConfig();
    const refreshed = await refreshAccessToken(config, refreshToken, fetchFn);
    accessToken = refreshed.accessToken;
  } catch (error) {
    if (error instanceof GmailReconnectRequiredError) {
      await markStatus(db, googleConnectionId, { status: "reconnect_required", lastErrorClass: "revoked" });
      logger.warn("gmail.sync", { requestId, connectionId: googleConnectionId, outcome: "token_revoked" });
      return { outcome: "reconnect_required", imported: 0, removed: 0, mode: null };
    }
    // Transient refresh failure — mark error and let the dispatcher retry.
    await markStatus(db, googleConnectionId, { status: "error", lastErrorClass: classify(error) });
    throw error;
  }

  const state = await db.gmailSyncState.findUnique({ where: { googleConnectionId: googleConnectionId } });
  const mode: SyncMode = state?.historyId == null ? "initial" : "incremental";
  await markStatus(db, googleConnectionId, { status: "running", lastErrorClass: null });

  try {
    const result =
      mode === "initial"
        ? await runInitialSync(db, googleConnectionId, state, accessToken, fetchFn)
        : await runIncrementalSync(db, googleConnectionId, state as SyncStateRow, accessToken, fetchFn);

    // An expired cursor was handled by clearing it and flagging a controlled
    // resync — report that honestly rather than a misleading `synced` (§6).
    if (result.resyncScheduled === true) {
      logger.info("gmail.sync", {
        requestId,
        connectionId: googleConnectionId,
        outcome: "resync_scheduled",
        mode,
      });
      return { outcome: "resync_scheduled", imported: result.imported, removed: result.removed, mode };
    }

    await markStatus(db, googleConnectionId, {
      status: "synced",
      lastSyncedAt: new Date(),
      lastErrorClass: null,
      nextReconcileAt: null,
    });

    // Emit a minimal pointer AFTER the durable commit (spec §9) — clients refetch.
    if (result.imported > 0 || result.removed > 0) {
      publishSse(connection.userId, "gmail.inbox.updated", { connectionId: googleConnectionId });
    }
    logger.info("gmail.sync", {
      requestId,
      connectionId: googleConnectionId,
      outcome: "synced",
      mode,
      imported: result.imported,
      removed: result.removed,
    });
    return { outcome: "synced", imported: result.imported, removed: result.removed, mode };
  } catch (error) {
    await markStatus(db, googleConnectionId, { status: "error", lastErrorClass: classify(error) });
    throw error;
  }
}

async function runInitialSync(
  db: GmailSyncDb,
  connectionId: string,
  state: SyncStateRow | null,
  accessToken: string,
  fetchFn: FetchFn,
): Promise<{ imported: number; removed: number; resyncScheduled?: boolean }> {
  const windowDays = state?.historyWindowDays ?? 30;
  const cutoffSeconds = Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000);

  let imported = 0;
  let pageToken: string | undefined;
  // Page IDs, then fetch details in bounded batches (spec §5).
  do {
    const page = await listMessages(accessToken, { newerThanUnixSeconds: cutoffSeconds, pageToken, maxResults: SYNC_PAGE_SIZE }, fetchFn);
    pageToken = page.nextPageToken;

    const extracted: Array<{ gmailMessageId: string; data: Record<string, unknown> }> = [];
    for (let offset = 0; offset < page.messages.length; offset += SYNC_BATCH_DETAILS) {
      const slice = page.messages.slice(offset, offset + SYNC_BATCH_DETAILS);
      for (const ref of slice) {
        const raw = await getMessage(accessToken, ref.id, fetchFn);
        const fields = extractMessage(raw);
        extracted.push({
          gmailMessageId: raw.id,
          data: {
            gmailThreadId: fields.threadId,
            internalDate: fields.internalDateMs !== null ? new Date(fields.internalDateMs) : new Date(cutoffSeconds * 1000),
            sender: fields.sender,
            subject: fields.subject,
            snippet: fields.snippet,
            bodyText: fields.bodyText,
            isUnread: fields.isUnread,
            labels: fields.labelIds,
            attachments: fields.attachments,
            syncedAt: new Date(),
          },
        });
      }
    }
    // Durable commit for this page. The cursor is fetched separately (below) and
    // only persisted once we have the authoritative post-import historyId.
    await commitMessages(db, connectionId, extracted, null);
    imported += extracted.length;
  } while (pageToken !== undefined);

  // Seed the cursor from the mailbox profile AFTER the import, so incremental
  // sync starts from a consistent point. Committed durably on its own.
  const profile = await getProfile(accessToken, fetchFn);
  await commitMessages(db, connectionId, [], profile.historyId);
  return { imported, removed: 0 };
}

async function runIncrementalSync(
  db: GmailSyncDb,
  connectionId: string,
  state: SyncStateRow,
  accessToken: string,
  fetchFn: FetchFn,
): Promise<{ imported: number; removed: number; resyncScheduled?: boolean }> {
  let imported = 0;
  let removed = 0;
  let pageToken: string | undefined;
  let latestCursor = state.historyId as string;

  do {
    let page;
    try {
      page = await listHistory(accessToken, { startHistoryId: latestCursor, pageToken, maxResults: SYNC_PAGE_SIZE }, fetchFn);
    } catch (error) {
      // Expired/unknown cursor → Gmail 404. Trigger a CONTROLLED resync (spec §6):
      // clear the cursor so the NEXT run re-seeds via initial sync. We flag it so
      // the caller reports `resync_scheduled` instead of a misleading `synced`.
      if (error instanceof GmailApiError && (error.category === "not_found" || error.category === "forbidden")) {
        await markStatus(db, connectionId, { historyId: null, status: "pending" });
        return { imported, removed, resyncScheduled: true };
      }
      throw error;
    }
    pageToken = page.nextPageToken;
    latestCursor = page.historyId;

    // Fetch details for added messages, delete removed ones, then commit the
    // cursor with the data in ONE transaction.
    const extracted: Array<{ gmailMessageId: string; data: Record<string, unknown> }> = [];
    for (let offset = 0; offset < page.addedMessageIds.length; offset += SYNC_BATCH_DETAILS) {
      const slice = page.addedMessageIds.slice(offset, offset + SYNC_BATCH_DETAILS);
      for (const id of slice) {
        try {
          const raw = await getMessage(accessToken, id, fetchFn);
          const fields = extractMessage(raw);
          extracted.push({
            gmailMessageId: raw.id,
            data: {
              gmailThreadId: fields.threadId,
              internalDate: fields.internalDateMs !== null ? new Date(fields.internalDateMs) : new Date(),
              sender: fields.sender,
              subject: fields.subject,
              snippet: fields.snippet,
              bodyText: fields.bodyText,
              isUnread: fields.isUnread,
              labels: fields.labelIds,
              attachments: fields.attachments,
              syncedAt: new Date(),
            },
          });
        } catch (error) {
          // A single vanished message (deleted between history and fetch) must
          // not abort the whole page.
          if (error instanceof GmailApiError && error.category === "not_found") continue;
          throw error;
        }
      }
    }

    await db.$transaction(async (tx) => {
      const importedIds: Array<{ id: string; internalDate: Date }> = [];
      for (const message of extracted) {
        const row = await tx.gmailMessage.upsert({
          where: {
            googleConnectionId_gmailMessageId: { googleConnectionId: connectionId, gmailMessageId: message.gmailMessageId },
          },
          create: { googleConnectionId: connectionId, gmailMessageId: message.gmailMessageId, ...message.data },
          update: message.data,
        });
        importedIds.push({ id: row.id, internalDate: row.internalDate });
      }
      if (page.removedMessageIds.length > 0) {
        await tx.gmailMessage.deleteMany({
          where: { googleConnectionId: connectionId, gmailMessageId: { in: page.removedMessageIds } },
        });
      }
      await tx.gmailSyncState.update({
        where: { googleConnectionId: connectionId },
        data: { historyId: latestCursor, lastSuccessAt: new Date(), lastErrorClass: null },
      });

      // B10 auto-enqueue (phase_b10.md §3.4, user decision 2026-10-11): write
      // one ai.analysis_requested outbox event per OLDEST imported message,
      // inside the same transaction (transactional outbox). The relay turns
      // each into a coalesced ai.analysis job; pause/cap are re-checked at
      // job execution time, so a paused player schedules nothing billable.
      // Bounded per sync run (AUTO_ENQUEUE_MAX) so a huge historical import
      // cannot create unbounded job rows.
      importedIds.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());
      await appendAnalysisEventsForMessages(
        tx as unknown as { outboxEvent: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> } },
        importedIds.map((entry) => entry.id),
      );
    });

    imported += extracted.length;
    removed += page.removedMessageIds.length;
  } while (pageToken !== undefined);

  return { imported, removed };
}

let cachedTokenConfig: { clientId: string; clientSecret: string } | null = null;
function requireTokenConfig(): { clientId: string; clientSecret: string } {
  if (cachedTokenConfig) return cachedTokenConfig;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GmailApiError("config");
  }
  cachedTokenConfig = { clientId, clientSecret };
  return cachedTokenConfig;
}

export { GMAIL_SCOPE_ERROR };
