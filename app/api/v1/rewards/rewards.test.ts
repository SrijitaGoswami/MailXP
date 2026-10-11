/**
 * Phase B6 — rewards read routes (`rewards.rules`, `rewards.status`,
 * contract §7.5 "B6 surface"). MOCKED storage; sessions constructed directly.
 *
 * rules = fixed server config (user-confirmed values); status = today's UTC
 * cap progress derived from quest_reward ledger rows (purchase rows and other
 * players' rows never count).
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { ECONOMY_CONFIG, utcDayStart } from "@/lib/server/economy";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { GET as rulesGET } from "./rules/route";
import { GET as statusGET } from "./status/route";

const ORIGIN = "http://localhost:3000";
const DEFAULT_PREFS = {
  masterVolume: 0.8,
  uiVolume: 0.9,
  gameVolume: 0.8,
  muted: false,
  motion: "full",
  touchControls: "auto",
};

let fake: FakeDb;
const getDbMock = vi.mocked(getDb);

beforeEach(() => {
  fake = createFakeDb();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(fake.client);
});

async function makeAccount(email: string): Promise<{ profileId: string; cookie: string }> {
  const user = await fake.client.user.create({
    data: { email, passwordHash: "$2b$10$notarealhashmaterial0123456789abcdefghijklmn" },
  });
  const token = randomBytes(32).toString("base64url");
  await fake.client.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId: user.id,
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const profile = (await fake.client.playerProfile.create({
    data: { userId: user.id, prefs: DEFAULT_PREFS },
  })) as Record<string, unknown>;
  return { profileId: profile.id as string, cookie: `mailxp.session=${token}` };
}

function call(route: (req: Request) => Promise<Response>, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return route(new Request(`${ORIGIN}/api/v1/rewards`, { headers }));
}

describe("rewards.rules", () => {
  it("401 without a session", async () => {
    const response = await call(rulesGET);
    expect(response.status).toBe(401);
  });

  it("returns the user-confirmed B6 economy configuration", async () => {
    const account = await makeAccount("rules-ok@example.test");
    const response = await call(rulesGET, account.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      questRewardDraftCoin: 20,
      dailyCapDraftCoin: 100,
      resetUtcHour: 0,
    });
    // Config and route cannot drift apart silently.
    expect(ECONOMY_CONFIG.questRewardDraftCoin).toBe(20);
    expect(ECONOMY_CONFIG.dailyRewardCapDraftCoin).toBe(100);
  });
});

describe("rewards.status", () => {
  it("401 without a session", async () => {
    const response = await call(statusGET);
    expect(response.status).toBe(401);
  });

  it("fresh player: zero earned, full cap remaining, resets at next UTC midnight", async () => {
    const account = await makeAccount("status-fresh@example.test");
    const response = await call(statusGET, account.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      earnedToday: number;
      dailyCapDraftCoin: number;
      remainingToday: number;
      resetsAtUtc: string;
    };
    expect(body.earnedToday).toBe(0);
    expect(body.dailyCapDraftCoin).toBe(100);
    expect(body.remainingToday).toBe(100);
    expect(new Date(body.resetsAtUtc).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(body.resetsAtUtc).getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  it("sums only today's quest_reward rows for THIS player", async () => {
    const account = await makeAccount("status-sums@example.test");
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);

    fake.ledgers.push(
      // counts: two rewards today
      { profileId: account.profileId, type: "quest_reward", amount: 20, createdAt: today },
      { profileId: account.profileId, type: "quest_reward", amount: 20, createdAt: today },
      // does NOT count: yesterday's reward (UTC day window)
      { profileId: account.profileId, type: "quest_reward", amount: 100, createdAt: yesterday },
      // does NOT count: purchases are not rewards
      { profileId: account.profileId, type: "purchase", amount: -6, createdAt: today },
      // does NOT count: another player's reward
      { profileId: "profile-someone-else", type: "quest_reward", amount: 100, createdAt: today },
    );

    const response = await call(statusGET, account.cookie);
    const body = (await response.json()) as { earnedToday: number; remainingToday: number };
    expect(body.earnedToday).toBe(40);
    expect(body.remainingToday).toBe(60);
  });

  it("missing profile → zeros with full cap (no create-on-read)", async () => {
    const account = await makeAccount("status-noprofile@example.test");
    fake.profiles.length = 0;
    const response = await call(statusGET, account.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { earnedToday: number; remainingToday: number };
    expect(body.earnedToday).toBe(0);
    expect(body.remainingToday).toBe(100);
    expect(fake.profiles).toHaveLength(0);
  });

  it("utcDayStart normalizes any moment to 00:00Z of its UTC day", () => {
    const mid = new Date("2026-10-10T23:59:59.999Z");
    expect(utcDayStart(mid).toISOString()).toBe("2026-10-10T00:00:00.000Z");
    const after = new Date("2026-10-11T00:00:00.000Z");
    expect(utcDayStart(after).toISOString()).toBe("2026-10-11T00:00:00.000Z");
  });
});
