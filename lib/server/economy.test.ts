/**
 * Phase B6 — economy service unit tests (MOCKED storage: in-memory fake DB
 * with real transaction-rollback semantics).
 *
 * Covers: config values, UTC window math, daily-cap enforcement inside the
 * issuing transaction (today vs. yesterday, capped → no write), missing
 * profile, and a forced mid-transaction failure proving NOTHING persists
 * (deduct + grant + ledger + audit all roll back together).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { CATALOG_ENTRIES } from "./catalog";
import {
  dailyRewardStatus,
  ECONOMY_CONFIG,
  issueQuestReward,
  nextUtcReset,
  purchaseShopItem,
  utcDayStart,
  type EconomyDb,
} from "./economy";

const CHEAPEST = CATALOG_ENTRIES.reduce((min, entry) => (entry.price < min.price ? entry : min));

const PREFS = {
  masterVolume: 0.8,
  uiVolume: 0.9,
  gameVolume: 0.8,
  muted: false,
  motion: "full",
  touchControls: "auto",
};

let fake: FakeDb;
let db: EconomyDb;

beforeEach(() => {
  fake = createFakeDb();
  db = fake.client as unknown as EconomyDb;
});

async function makeProfile(draftCoin: number, version = 1): Promise<string> {
  const user = await fake.client.user.create({
    data: {
      email: `eco-${Math.random().toString(36).slice(2)}@example.test`,
      passwordHash: "$2b$10$notarealhashmaterial0123456789abcdefghijklmn",
    },
  });
  const profile = (await fake.client.playerProfile.create({
    data: { userId: user.id, prefs: PREFS, draftCoin, version },
  })) as Record<string, unknown>;
  return profile.id as string;
}

describe("ECONOMY_CONFIG (user-confirmed at B6)", () => {
  it("fixed reward 20, daily cap 100, reset at UTC midnight", () => {
    expect(ECONOMY_CONFIG.questRewardDraftCoin).toBe(20);
    expect(ECONOMY_CONFIG.dailyRewardCapDraftCoin).toBe(100);
    expect(ECONOMY_CONFIG.rewardResetUtcHour).toBe(0);
  });
});

describe("UTC window helpers", () => {
  it("utcDayStart truncates to 00:00:00.000Z of the same UTC day", () => {
    expect(utcDayStart(new Date("2026-01-31T23:59:59.999Z")).toISOString()).toBe(
      "2026-01-31T00:00:00.000Z",
    );
    expect(utcDayStart(new Date("2026-02-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });

  it("nextUtcReset is exactly 24 h after the current day's start", () => {
    const now = new Date("2026-03-15T10:30:00.000Z");
    expect(nextUtcReset(now).toISOString()).toBe("2026-03-16T00:00:00.000Z");
  });
});

describe("issueQuestReward", () => {
  it("grants the fixed amount atomically: balance + ledger + version", async () => {
    const profileId = await makeProfile(5);
    const outcome = await issueQuestReward(db, { profileId, reason: "test.reward" });
    expect(outcome).toMatchObject({ ok: true, awarded: 20, capped: false, balance: 25, version: 2 });
    expect(fake.ledgers).toHaveLength(1);
    expect(fake.ledgers[0]).toMatchObject({
      type: "quest_reward",
      amount: 20,
      reason: "test.reward",
      profileId,
    });
    const profile = fake.profiles.find((p) => p.id === profileId)!;
    expect(profile.draftCoin).toBe(25);
    expect(profile.version).toBe(2);
  });

  it("missing profile → null (nothing created)", async () => {
    const outcome = await issueQuestReward(db, { profileId: "profile-ghost", reason: "test.reward" });
    expect(outcome).toBeNull();
    expect(fake.ledgers).toHaveLength(0);
  });

  it("cap: at 90 earned today the next reward is capped (awarded 0, no write)", async () => {
    const profileId = await makeProfile(90);
    fake.ledgers.push({
      profileId,
      type: "quest_reward",
      amount: 90,
      createdAt: new Date(),
    });
    const outcome = await issueQuestReward(db, { profileId, reason: "test.reward" });
    expect(outcome).toMatchObject({ ok: true, awarded: 0, capped: true, balance: 90, version: 1 });
    expect(fake.ledgers).toHaveLength(1); // no new row past the cap
    const profile = fake.profiles.find((p) => p.id === profileId)!;
    expect(profile.draftCoin).toBe(90);
    expect(profile.version).toBe(1); // no state change
  });

  it("cap window is per UTC day: yesterday's earnings do not count", async () => {
    const profileId = await makeProfile(90);
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    fake.ledgers.push({ profileId, type: "quest_reward", amount: 90, createdAt: yesterday });
    const outcome = await issueQuestReward(db, { profileId, reason: "test.reward" });
    expect(outcome).toMatchObject({ awarded: 20, capped: false, balance: 110 });
  });

  it("cap counts only quest_reward rows: purchases never block earning", async () => {
    const profileId = await makeProfile(0);
    fake.ledgers.push({ profileId, type: "purchase", amount: -100, createdAt: new Date() });
    const outcome = await issueQuestReward(db, { profileId, reason: "test.reward" });
    expect(outcome).toMatchObject({ awarded: 20, capped: false });
  });
});

describe("dailyRewardStatus", () => {
  it("sums today's rewards and reports remaining + reset instant", async () => {
    const profileId = await makeProfile(0);
    fake.ledgers.push(
      { profileId, type: "quest_reward", amount: 20, createdAt: new Date() },
      { profileId, type: "quest_reward", amount: 20, createdAt: new Date() },
      { profileId, type: "purchase", amount: -6, createdAt: new Date() },
    );
    const status = await dailyRewardStatus(db, { profileId });
    expect(status.earnedToday).toBe(40);
    expect(status.dailyCapDraftCoin).toBe(100);
    expect(status.remainingToday).toBe(60);
    expect(new Date(status.resetsAtUtc).getTime()).toBeGreaterThan(Date.now());
  });

  it("earnedToday never exceeds the cap in remaining math (floor at 0)", async () => {
    const profileId = await makeProfile(0);
    fake.ledgers.push({ profileId, type: "quest_reward", amount: 500, createdAt: new Date() });
    const status = await dailyRewardStatus(db, { profileId });
    expect(status.remainingToday).toBe(0);
  });
});

describe("purchaseShopItem atomicity", () => {
  it("pre-checks: unknown item / stale version / insufficient funds / already owned", async () => {
    const profileId = await makeProfile(1000, 5);

    expect(await purchaseShopItem(db, { profileId, itemId: "no-such", expectedVersion: 5 })).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });

    const stale = await purchaseShopItem(db, {
      profileId,
      itemId: CHEAPEST.itemId,
      expectedVersion: 4,
    });
    expect(stale).toMatchObject({ ok: false, reason: "STALE_VERSION", currentVersion: 5, balance: 1000 });

    fake.profiles.find((p) => p.id === profileId)!.draftCoin = 0;
    const poor = await purchaseShopItem(db, {
      profileId,
      itemId: CHEAPEST.itemId,
      expectedVersion: 5,
    });
    expect(poor).toMatchObject({ ok: false, reason: "INSUFFICIENT_FUNDS", balance: 0, currentVersion: 5 });

    fake.inventory.push({ profileId, itemId: CHEAPEST.itemId, ownedSince: new Date() });
    const owned = await purchaseShopItem(db, {
      profileId,
      itemId: CHEAPEST.itemId,
      expectedVersion: 5,
    });
    expect(owned).toMatchObject({ ok: false, reason: "ALREADY_OWNED", currentVersion: 5 });
    expect(fake.ledgers).toHaveLength(0); // no partial writes anywhere
  });

  it("forced mid-transaction failure rolls back deduct, grant, ledger AND audit", async () => {
    const profileId = await makeProfile(10_000, 1);

    // Break the ledger write (step 3 of the transaction) exactly once.
    const original = fake.client.ledgerEntry.create.bind(fake.client.ledgerEntry);
    fake.client.ledgerEntry.create = (() => {
      throw new Error("forced ledger failure");
    }) as typeof fake.client.ledgerEntry.create;

    await expect(
      purchaseShopItem(db, {
        profileId,
        itemId: CHEAPEST.itemId,
        expectedVersion: 1,
        requestId: "req-rollback",
        userId: "user-1",
      }),
    ).rejects.toThrow("forced ledger failure");

    fake.client.ledgerEntry.create = original;

    // NOTHING persisted: balance, version, inventory, ledger, audit all intact.
    const profile = fake.profiles.find((p) => p.id === profileId)!;
    expect(profile.draftCoin).toBe(10_000);
    expect(profile.version).toBe(1);
    expect(fake.inventory).toHaveLength(0);
    expect(fake.ledgers).toHaveLength(0);
    expect(fake.audits).toHaveLength(0);
  });
});
