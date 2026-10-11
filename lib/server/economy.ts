/**
 * Server-authoritative economy (Phase B6, contract §4 + phase_b6.md §6/§9).
 *
 * - Prices/items resolve from the canonical catalog only (lib/server/catalog).
 * - `purchaseShopItem` runs ONE database transaction: version + affordability
 *   guard (conditional update — concurrent requests cannot overspend), the
 *   inventory grant, and exactly one purchase ledger row (amount = -price,
 *   per the schema's signed-amount convention: credits positive, purchases
 *   negative). Any failure rolls the whole thing back.
 * - `issueQuestReward` is the ONLY earning path (internal — no player-facing
 *   route per contract §7.5): fixed amount from ECONOMY_CONFIG, UTC daily cap
 *   enforced inside the same transaction as the credit (MASTER §8.3: actions
 *   past the cap complete but earn nothing further that UTC day).
 * - XP/level: deliberately untouched (phase_b6.md §9 — no XP rule is assigned
 *   to B6; the server columns stay at their defaults until a later phase).
 */

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { recordAudit } from "@/lib/server/audit";
import { findCatalogEntry } from "@/lib/server/catalog";
import type { IdempotencyDb } from "@/lib/server/idempotency";

/** The user-confirmed B6 economy values (MASTER §227 decision item). */
export const ECONOMY_CONFIG = {
  /** DraftCoin granted per verified qualifying action (B11 until then: dev fixture). */
  questRewardDraftCoin: 20,
  /** Per-player DraftCoin reward cap per UTC day (MASTER §8.3). */
  dailyRewardCapDraftCoin: 100,
  /** Cap reset moment (UTC). */
  rewardResetUtcHour: 0,
} as const;

/** Start of the UTC day containing `now` (cap window, MASTER §8.3). */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Next UTC midnight after `now` (for `resetsAtUtc` in rewards.status). */
export function nextUtcReset(now: Date): Date {
  const start = utcDayStart(now);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

// ------------------------------------------------------------------ purchase --

export type PurchaseOutcome =
  | { ok: true; transactionId: string; itemId: string; balance: number; version: number }
  | {
      ok: false;
      reason: "NOT_FOUND" | "ALREADY_OWNED" | "STALE_VERSION" | "INSUFFICIENT_FUNDS";
      /** Authoritative state so the optimistic client can roll back (§4 note). */
      balance?: number;
      currentVersion?: number;
    };

export interface InventoryRow {
  itemId: string;
}

export interface ProfileWithInventory {
  id: string;
  draftCoin: number;
  version: number;
  inventoryItems: InventoryRow[];
}

export interface EconomyDb {
  $transaction<T>(fn: (tx: EconomyTxDb) => Promise<T>): Promise<T>;
  idempotencyRecord: IdempotencyDb["idempotencyRecord"];
  playerProfile: {
    findUnique(args: {
      where: { id: string };
      include: { inventoryItems: true };
    }): Promise<ProfileWithInventory | null>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  inventoryItem: {
    create(args: { data: { profileId: string; itemId: string } }): Promise<{ itemId: string }>;
  };
  ledgerEntry: {
    create(args: {
      data: {
        profileId: string;
        type: string;
        amount: number;
        reason: string;
        sourceRef: string | null;
      };
    }): Promise<{ id: string }>;
    aggregate(args: {
      where: { profileId: string; type: string; createdAt: { gte: Date } };
      _sum: { amount: true };
    }): Promise<{ _sum: { amount: number | null } }>;
  };
}

export interface EconomyTxDb
  extends Pick<EconomyDb, "inventoryItem" | "ledgerEntry" | "idempotencyRecord"> {
  playerProfile: Pick<EconomyDb["playerProfile"], "findUnique" | "updateMany">;
}

class ProfileRaceError extends Error {
  constructor() {
    super("economy: profile changed during transaction");
    this.name = "ProfileRaceError";
  }
}

/**
 * Atomic shop purchase. Preconditions are checked (and reported with
 * authoritative state for client rollback), then the transaction re-guards
 * them conditionally so two concurrent purchases can never both pass.
 */
export async function purchaseShopItem(
  db: EconomyDb,
  args: {
    profileId: string;
    itemId: string;
    expectedVersion: number;
    /** Correlation id for the audit row (absent in direct unit tests). */
    requestId?: string;
    /** Acting user for the audit row (B1 §1.9: id only — never PII). */
    userId?: string;
    /**
     * Reserved idempotency key (route called beginIdempotency first). Its
     * completed outcome is stored INSIDE this transaction (phase_b6 §6 step 9)
     * so a crash can never leave a committed purchase without a replayable
     * result — all-or-nothing with the money movement itself.
     */
    idempotency?: { endpoint: string; key: string };
  },
): Promise<PurchaseOutcome> {
  const entry = findCatalogEntry(args.itemId);
  if (!entry) return { ok: false, reason: "NOT_FOUND" };

  const profile = await db.playerProfile.findUnique({
    where: { id: args.profileId },
    include: { inventoryItems: true },
  });
  // Anomaly path (profile always exists — B4 creates it): treat as unknown item scope.
  if (!profile) return { ok: false, reason: "NOT_FOUND" };

  const owned = profile.inventoryItems.some((item) => item.itemId === args.itemId);
  if (owned) {
    return { ok: false, reason: "ALREADY_OWNED", balance: profile.draftCoin, currentVersion: profile.version };
  }
  if (profile.version !== args.expectedVersion) {
    return { ok: false, reason: "STALE_VERSION", balance: profile.draftCoin, currentVersion: profile.version };
  }
  if (profile.draftCoin < entry.price) {
    return {
      ok: false,
      reason: "INSUFFICIENT_FUNDS",
      balance: profile.draftCoin,
      currentVersion: profile.version,
    };
  }

  const transactionId = randomUUID();

  try {
    await db.$transaction(async (tx) => {
      // 1. Deduct + bump version, CONDITIONALLY (guards against a concurrent
      //    request that spent or bumped between our read and this write).
      const deducted = await tx.playerProfile.updateMany({
        where: {
          id: args.profileId,
          version: args.expectedVersion,
          draftCoin: { gte: entry.price },
        },
        data: { draftCoin: { decrement: entry.price }, version: { increment: 1 } },
      });
      if (deducted.count !== 1) throw new ProfileRaceError();
      // 2. Grant ownership (composite PK makes a duplicate grant impossible).
      await tx.inventoryItem.create({ data: { profileId: args.profileId, itemId: args.itemId } });
      // 3. Exactly one ledger row — signed: purchases are negative (schema §B5).
      await tx.ledgerEntry.create({
        data: {
          profileId: args.profileId,
          type: "purchase",
          amount: -entry.price,
          reason: `shop:purchase:${args.itemId}`,
          sourceRef: transactionId,
        },
      });
      // 4. Durable audit row (contract §4 side effect: "audit
      //    economy.purchase") — inside the same transaction so the audit
      //    cannot diverge from the money movement. meta carries no PII.
      if (args.requestId) {
        await recordAudit(tx as unknown as Prisma.TransactionClient, {
          userId: args.userId ?? null,
          eventType: "economy.purchase",
          requestId: args.requestId,
          meta: { itemId: args.itemId, price: entry.price, transactionId },
        });
      }
      // 5. Idempotency outcome (phase_b6 §6 step 9) — same transaction: the
      //    replayable 201 body exists only if every step above succeeded.
      if (args.idempotency) {
        await tx.idempotencyRecord.updateMany({
          where: {
            profileId: args.profileId,
            endpoint: args.idempotency.endpoint,
            key: args.idempotency.key,
            status: "in_progress",
          },
          data: {
            status: "completed",
            httpStatus: 201,
            summary: {
              transactionId,
              itemId: args.itemId,
              balance: profile.draftCoin - entry.price,
              version: args.expectedVersion + 1,
            },
          },
        });
      }
    });
  } catch (error) {
    if (error instanceof ProfileRaceError) {
      // The transaction rolled back — classify against fresh authoritative
      // state so the client still gets a stateful, honest rejection.
      const fresh = await db.playerProfile.findUnique({
        where: { id: args.profileId },
        include: { inventoryItems: true },
      });
      if (!fresh) return { ok: false, reason: "NOT_FOUND" };
      if (fresh.inventoryItems.some((item) => item.itemId === args.itemId)) {
        return { ok: false, reason: "ALREADY_OWNED", balance: fresh.draftCoin, currentVersion: fresh.version };
      }
      if (fresh.version !== args.expectedVersion) {
        return { ok: false, reason: "STALE_VERSION", balance: fresh.draftCoin, currentVersion: fresh.version };
      }
      return {
        ok: false,
        reason: "INSUFFICIENT_FUNDS",
        balance: fresh.draftCoin,
        currentVersion: fresh.version,
      };
    }
    throw error;
  }

  return {
    ok: true,
    transactionId,
    itemId: args.itemId,
    balance: profile.draftCoin - entry.price,
    version: args.expectedVersion + 1,
  };
}

// -------------------------------------------------------------------- rewards --

export interface RewardOutcome {
  ok: true;
  /** Actually granted (0 when the daily cap was already reached). */
  awarded: number;
  capped: boolean;
  balance: number;
  version: number;
  /** Ledger sourceRef of the grant; null when capped (no row is written). */
  transactionId: string | null;
}

/**
 * Issue one quest reward through the ONLY earning path. Internal verification
 * is the caller's job (B11 provider evidence; dev fixture until then) — this
 * function only enforces amount, atomicity and the UTC daily cap.
 */
export async function issueQuestReward(
  db: EconomyDb,
  args: {
    profileId: string;
    reason: string;
    sourceRef?: string;
    /**
     * Reserved idempotency key: the outcome is completed INSIDE this
     * transaction (both capped and granted branches), mirroring the purchase
     * path — a crash never leaves a committed reward without a replay result.
     */
    idempotency?: { endpoint: string; key: string };
  },
): Promise<RewardOutcome | null> {
  const reward = ECONOMY_CONFIG.questRewardDraftCoin;
  const cap = ECONOMY_CONFIG.dailyRewardCapDraftCoin;
  const sourceRef = args.sourceRef ?? randomUUID();
  const now = new Date();

  return db.$transaction(async (tx) => {
    const profile = await tx.playerProfile.findUnique({
      where: { id: args.profileId },
      include: { inventoryItems: true },
    });
    if (profile === null) return null;

    const dayStart = utcDayStart(now);
    const summed = await tx.ledgerEntry.aggregate({
      where: { profileId: args.profileId, type: "quest_reward", createdAt: { gte: dayStart } },
      _sum: { amount: true },
    });
    const earnedToday = summed._sum.amount ?? 0;

    const complete = async (summary: Record<string, unknown>): Promise<void> => {
      if (!args.idempotency) return;
      await tx.idempotencyRecord.updateMany({
        where: {
          profileId: args.profileId,
          endpoint: args.idempotency.endpoint,
          key: args.idempotency.key,
          status: "in_progress",
        },
        data: { status: "completed", httpStatus: 200, summary },
      });
    };

    if (earnedToday + reward > cap) {
      // MASTER §8.3: past the cap the action still "succeeds" — earns nothing.
      await complete({
        awarded: 0,
        capped: true,
        balance: profile.draftCoin,
        version: profile.version,
      });
      return { ok: true, awarded: 0, capped: true, balance: profile.draftCoin, version: profile.version, transactionId: null };
    }

    const credited = await tx.playerProfile.updateMany({
      where: { id: args.profileId, version: profile.version },
      data: { draftCoin: { increment: reward }, version: { increment: 1 } },
    });
    if (credited.count !== 1) throw new ProfileRaceError();
    await tx.ledgerEntry.create({
      data: {
        profileId: args.profileId,
        type: "quest_reward",
        amount: reward,
        reason: args.reason,
        sourceRef,
      },
    });
    await complete({
      awarded: reward,
      capped: false,
      balance: profile.draftCoin + reward,
      version: profile.version + 1,
    });
    return {
      ok: true,
      awarded: reward,
      capped: false,
      balance: profile.draftCoin + reward,
      version: profile.version + 1,
      transactionId: sourceRef,
    };
  });
}

export interface DailyRewardStatus {
  earnedToday: number;
  dailyCapDraftCoin: number;
  remainingToday: number;
  resetsAtUtc: string;
}

/** rewards.status (contract §7.5): today's cap progress for the player. */
export async function dailyRewardStatus(
  db: EconomyDb,
  args: { profileId: string; now?: Date },
): Promise<DailyRewardStatus> {
  const now = args.now ?? new Date();
  const summed = await db.ledgerEntry.aggregate({
    where: { profileId: args.profileId, type: "quest_reward", createdAt: { gte: utcDayStart(now) } },
    _sum: { amount: true },
  });
  const earnedToday = summed._sum.amount ?? 0;
  const cap = ECONOMY_CONFIG.dailyRewardCapDraftCoin;
  return {
    earnedToday,
    dailyCapDraftCoin: cap,
    remainingToday: Math.max(0, cap - earnedToday),
    resetsAtUtc: nextUtcReset(now).toISOString(),
  };
}
