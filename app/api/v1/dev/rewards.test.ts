/**
 * Phase B6 — dev reward fixture route tests (MOCKED storage).
 *
 * Covers: production gate (404, no work), auth/origin/idempotency-key
 * validation, successful issuance (+20 ledger row, balance, version, SSE-worthy
 * state), UTC daily cap (capped → awarded 0, no row, no balance change),
 * idempotent replay (one reward per key), and per-player isolation.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));
// §12: prove economy.updated only fires for a REAL grant — capped claims and
// failures publish nothing.
vi.mock("@/lib/server/sseHub", () => ({ publishSse: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { publishSse } from "@/lib/server/sseHub";
import { POST as devPOST } from "./rewards/route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1/dev/rewards`;
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
  vi.mocked(publishSse).mockClear();
});

async function makeAccount(
  email: string,
): Promise<{ userId: string; profileId: string; cookie: string }> {
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
  return {
    userId: user.id as string,
    profileId: profile.id as string,
    cookie: `mailxp.session=${token}`,
  };
}

function claim(cookie?: string, opts: { idemKey?: string; origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    origin: opts.origin ?? ORIGIN,
    "idempotency-key": opts.idemKey ?? randomUUID(),
  };
  if (cookie) headers.cookie = cookie;
  return devPOST(new Request(BASE, { method: "POST", headers }));
}

function errorOf(payload: unknown): { code: string } {
  return (payload as { error: { code: string } }).error;
}

describe("dev.reward_fixture production gate", () => {
  it("404 in production — before session, rate or any mutation", async () => {
    // Manual save/restore: deterministic regardless of vitest stub APIs.
    const env = process.env as Record<string, string | undefined>;
    const savedNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const account = await makeAccount("dev-prod@example.test");
      const response = await claim(account.cookie);
      expect(response.status).toBe(404);
      expect(errorOf(await response.json()).code).toBe("NOT_FOUND");

      const profile = fake.profiles.find((p) => p.id === account.profileId)!;
      expect(profile.draftCoin).toBe(0);
      expect(fake.ledgers).toHaveLength(0);
      expect(fake.idempotency).toHaveLength(0); // never even reserved
    } finally {
      env.NODE_ENV = savedNodeEnv;
    }
  });
});

describe("dev.reward_fixture validation", () => {
  it("401 without a session", async () => {
    const response = await claim(undefined);
    expect(response.status).toBe(401);
  });

  it("403 cross-origin", async () => {
    const account = await makeAccount("dev-origin@example.test");
    const response = await claim(account.cookie, { origin: "http://evil.test" });
    expect(response.status).toBe(403);
  });

  it("400 without a valid Idempotency-Key", async () => {
    const account = await makeAccount("dev-key@example.test");
    const headers = { origin: ORIGIN, cookie: account.cookie }; // no key header
    const response = await devPOST(new Request(BASE, { method: "POST", headers }));
    expect(response.status).toBe(400);
    expect(errorOf(await response.json()).code).toBe("VALIDATION_ERROR");
    expect(fake.ledgers).toHaveLength(0);
  });
});

describe("dev.reward_fixture issuance", () => {
  it("grants the fixed reward: +20 ledger row, balance, version bump", async () => {
    const account = await makeAccount("dev-ok@example.test");
    const response = await claim(account.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      awarded: number;
      capped: boolean;
      balance: number;
      version: number;
    };
    expect(body).toEqual({ awarded: 20, capped: false, balance: 20, version: 2 });

    expect(fake.ledgers).toHaveLength(1);
    expect(fake.ledgers[0]).toMatchObject({
      profileId: account.profileId,
      type: "quest_reward",
      amount: 20,
      reason: "dev.fixture",
    });
    const profile = fake.profiles.find((p) => p.id === account.profileId)!;
    expect(profile.draftCoin).toBe(20);
    expect(profile.version).toBe(2);
    expect(fake.idempotency[0]).toMatchObject({ status: "completed", httpStatus: 200 });

    // §9/§12: player-scoped events after commit — grant → two events.
    expect(vi.mocked(publishSse)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(publishSse)).toHaveBeenNthCalledWith(1, account.userId, "economy.updated", {
      balance: 20,
      reason: "reward",
      version: 2,
    });
    expect(vi.mocked(publishSse)).toHaveBeenNthCalledWith(2, account.userId, "profile.updated", {
      version: 2,
    });
  });

  it("same key replays the stored outcome — one reward only", async () => {
    const account = await makeAccount("dev-replay@example.test");
    const key = randomUUID();
    const first = await claim(account.cookie, { idemKey: key });
    const firstBody = await first.json();
    const second = await claim(account.cookie, { idemKey: key });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);

    expect(fake.ledgers).toHaveLength(1);
    const profile = fake.profiles.find((p) => p.id === account.profileId)!;
    expect(profile.draftCoin).toBe(20);
    expect(profile.version).toBe(2);
  });

  it("UTC daily cap: at 100 earned today the next claim awards 0 and writes nothing", async () => {
    const account = await makeAccount("dev-cap@example.test");
    fake.ledgers.push(
      { profileId: account.profileId, type: "quest_reward", amount: 40, createdAt: new Date() },
      { profileId: account.profileId, type: "quest_reward", amount: 60, createdAt: new Date() },
    );
    const profile = fake.profiles.find((p) => p.id === account.profileId)!;
    profile.draftCoin = 100;

    const response = await claim(account.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { awarded: number; capped: boolean; balance: number };
    expect(body).toEqual({ awarded: 0, capped: true, balance: 100, version: 1 });
    expect(fake.ledgers).toHaveLength(2); // no new row past the cap
    expect(profile.draftCoin).toBe(100);
    expect(profile.version).toBe(1); // no state change → no SSE either
    expect(publishSse).not.toHaveBeenCalled();
  });

  it("reward does not count OTHER players toward this player's cap", async () => {
    const account = await makeAccount("dev-iso@example.test");
    fake.ledgers.push({
      profileId: "profile-someone-else",
      type: "quest_reward",
      amount: 100,
      createdAt: new Date(),
    });
    const response = await claim(account.cookie);
    const body = (await response.json()) as { awarded: number };
    expect(body.awarded).toBe(20);
  });
});
