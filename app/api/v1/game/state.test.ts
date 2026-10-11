/**
 * Phase B5 — `game.state` route tests (MOCKED storage: in-memory fake DB;
 * sessions constructed directly since auth itself is covered by the B4
 * suites). Live database coverage for these routes ships in the B4 LIVE
 * integration file's style later in this phase if needed — these are mocks.
 *
 * Covers phase_b5 §11: unauthenticated requests, player A/B isolation,
 * response shape + profile defaults, inventory mapping, secret exclusion,
 * and safe missing/malformed profile handling (no create-on-read).
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { GET as stateGET } from "./state/route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1/game/state`;
const DEFAULT_PREFS = {
  masterVolume: 0.8,
  uiVolume: 0.9,
  gameVolume: 0.8,
  muted: false,
  motion: "full",
  touchControls: "auto",
};
const SECRET_HASH = "$2b$10$SUPERSECRETHASHMATERIAL0123456789abcdefghijklmn";

let fake: FakeDb;
const getDbMock = vi.mocked(getDb);

beforeEach(() => {
  fake = createFakeDb();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(fake.client);
});

interface Account {
  userId: string;
  profileId: string;
  cookie: string;
}

async function makeAccount(
  email: string,
  profileData: Record<string, unknown> = {},
): Promise<Account> {
  const user = await fake.client.user.create({
    data: { email, passwordHash: SECRET_HASH },
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
    data: { userId: user.id, prefs: DEFAULT_PREFS, ...profileData },
  })) as Record<string, unknown>;
  return { userId: user.id as string, profileId: profile.id as string, cookie: `mailxp.session=${token}` };
}

function getState(cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return stateGET(new Request(BASE, { headers }));
}

describe("game.state auth", () => {
  it("401 UNAUTHENTICATED without a session cookie", async () => {
    const response = await getState();
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("401 SESSION_EXPIRED for a dead cookie", async () => {
    const response = await getState("mailxp.session=deadbeefdeadbeefdeadbeefdeadbeef");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SESSION_EXPIRED");
  });
});

describe("game.state shape and defaults", () => {
  it("returns the contract shape with B4-profile defaults", async () => {
    const account = await makeAccount("state-defaults@example.test");
    const response = await getState(account.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      [
        "draftCoin",
        "equippedOutfit",
        "level",
        "ownedItems",
        "placedDecor",
        "playerId",
        "preferences",
        "stats",
        "version",
        "xp",
      ].sort(),
    );
    expect(body.playerId).toBe(account.userId);
    expect(body.draftCoin).toBe(0);
    expect(body.xp).toBe(0);
    expect(body.level).toBe(1);
    expect(body.stats).toEqual({ mailCount: 0 });
    expect(body.ownedItems).toEqual([]);
    expect(body.equippedOutfit).toBe("worker");
    expect(body.placedDecor).toEqual([]);
    expect(body.preferences).toEqual(DEFAULT_PREFS);
    expect(body.version).toBe(1);
    // X-Request-Id correlation header on success (B3/B4 policy).
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("maps inventory (ownedSince ISO, deterministic order) and profile fields", async () => {
    const account = await makeAccount("state-inventory@example.test", {
      draftCoin: 42,
      xp: 210,
      level: 3,
      stats: { mailCount: 7 },
      equippedOutfit: "tech",
      placedDecor: [{ itemId: "plant-1", x: 120, y: 340 }],
    });
    fake.inventory.push(
      { profileId: account.profileId, itemId: "courier", ownedSince: new Date("2026-01-02T00:00:00.000Z") },
      { profileId: account.profileId, itemId: "tech", ownedSince: new Date("2026-01-01T00:00:00.000Z") },
    );

    const response = await getState(account.cookie);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.draftCoin).toBe(42);
    expect(body.xp).toBe(210);
    expect(body.level).toBe(3);
    expect(body.stats).toEqual({ mailCount: 7 });
    expect(body.equippedOutfit).toBe("tech");
    expect(body.placedDecor).toEqual([{ itemId: "plant-1", x: 120, y: 340 }]);
    expect(body.ownedItems).toEqual([
      { itemId: "tech", ownedSince: "2026-01-01T00:00:00.000Z" },
      { itemId: "courier", ownedSince: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  it("player A's session never returns player B's data (isolation)", async () => {
    const a = await makeAccount("iso-a@example.test", { draftCoin: 5 });
    const b = await makeAccount("iso-b@example.test", { draftCoin: 999, equippedOutfit: "forest" });

    const responseA = await getState(a.cookie);
    const bodyA = (await responseA.json()) as Record<string, unknown>;
    expect(bodyA.playerId).toBe(a.userId);
    expect(bodyA.draftCoin).toBe(5);
    expect(JSON.stringify(bodyA)).not.toContain(b.userId);
    expect(JSON.stringify(bodyA)).not.toContain("999");
  });
});

describe("game.state excludes internals", () => {
  it("never leaks password hashes, tokens, emails, or profile ids", async () => {
    const account = await makeAccount("secrets@example.test");
    const response = await getState(account.cookie);
    const text = JSON.stringify(await response.json());

    expect(text).not.toContain(SECRET_HASH);
    expect(text).not.toContain("$2b$10$");
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("tokenHash");
    expect(text).not.toContain("password");
    expect(text).not.toContain("secrets@example.test");
    expect(text).not.toContain("emailVerifiedAt");
    expect(text).not.toContain(account.profileId); // internal row id stays server-side
  });
});

describe("game.state anomaly paths", () => {
  it("missing profile → computed defaults, WITHOUT creating a row", async () => {
    const account = await makeAccount("no-profile@example.test");
    await fake.client.playerProfile.updateMany({
      where: { id: account.profileId },
      data: { draftCoin: -1 }, // touch to prove we find it, then remove it
    });
    fake.profiles.length = 0; // simulate the anomaly: user without a profile

    const response = await getState(account.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.draftCoin).toBe(0);
    expect(body.version).toBe(1);
    expect(body.preferences).toEqual(DEFAULT_PREFS);
    expect(fake.profiles).toHaveLength(0); // no create-on-read (phase §6)
  });

  it("malformed prefs/stats/decor JSON coerces to safe defaults", async () => {
    const account = await makeAccount("malformed@example.test");
    const row = fake.profiles.find((p) => p.id === account.profileId) as Record<string, unknown>;
    row.prefs = { muted: "yes", masterVolume: 99 };
    row.stats = "garbage";
    row.placedDecor = { not: "an array" };

    const response = await getState(account.cookie);
    const body = (await response.json()) as Record<string, unknown>;
    // Volumes clamp (profile.ts sanitize semantics): 99 → 1; wrong types fall
    // back to defaults; stats/decor become safe empty values.
    expect(body.preferences).toEqual({ ...DEFAULT_PREFS, masterVolume: 1 });
    expect(body.stats).toEqual({ mailCount: 0 });
    expect(body.placedDecor).toEqual([]);
  });
});
