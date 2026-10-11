/**
 * Phase B6 — `shop.purchase` route tests (MOCKED storage: in-memory fake DB
 * with real transaction-rollback semantics; sessions constructed directly).
 *
 * Covers phase_b6 §11 verification + contract §4/§1.6:
 * auth/origin/validation, 404 unknown item, atomic success (deduct + grant +
 * ledger row + audit row, version bump), 409 rejections carrying
 * authoritative state (ALREADY_OWNED / STALE_VERSION / INSUFFICIENT_FUNDS),
 * idempotent replay (one charge for a repeated key), IDEMPOTENCY_MISMATCH,
 * IDEMPOTENCY_IN_PROGRESS, reservation release on failure (honest retry
 * works), concurrent purchases (exactly one wins — balance never negative),
 * and per-player isolation.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_ENTRIES } from "@/lib/server/catalog";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import {
  ENDPOINT_SHOP_PURCHASE,
  requestFingerprint,
} from "@/lib/server/idempotency";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));
// SSE hub mocked: §12 requires proving `economy.updated` is emitted after a
// COMMITTED purchase only — failed/replayed requests must publish nothing.
vi.mock("@/lib/server/sseHub", () => ({ publishSse: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { publishSse } from "@/lib/server/sseHub";
import { POST as purchasePOST } from "./route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1/shop/purchases`;
const DEFAULT_PREFS = {
  masterVolume: 0.8,
  uiVolume: 0.9,
  gameVolume: 0.8,
  muted: false,
  motion: "full",
  touchControls: "auto",
};

const CHEAPEST = CATALOG_ENTRIES.reduce((min, entry) => (entry.price < min.price ? entry : min));
const PRICIEST = CATALOG_ENTRIES.reduce((max, entry) => (entry.price > max.price ? entry : max));
const OTHER = CATALOG_ENTRIES.find((entry) => entry.itemId !== CHEAPEST.itemId)!;

let fake: FakeDb;
const getDbMock = vi.mocked(getDb);

beforeEach(() => {
  fake = createFakeDb();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(fake.client);
  vi.mocked(publishSse).mockClear();
});

interface Account {
  userId: string;
  profileId: string;
  cookie: string;
  version: number;
}

async function makeAccount(
  email: string,
  overrides: { draftCoin?: number; version?: number } = {},
): Promise<Account> {
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
    data: {
      userId: user.id,
      prefs: DEFAULT_PREFS,
      draftCoin: overrides.draftCoin ?? 0,
      ...(overrides.version !== undefined ? { version: overrides.version } : {}),
    },
  })) as Record<string, unknown>;
  return {
    userId: user.id as string,
    profileId: profile.id as string,
    cookie: `mailxp.session=${token}`,
    version: profile.version as number,
  };
}

interface PostOpts {
  idemKey?: string | null; // null = omit header entirely
  origin?: string | null; // null = omit Origin; default = same-origin
}

function postPurchase(
  cookie: string | undefined,
  body: unknown,
  opts: PostOpts = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (opts.idemKey !== null) headers["idempotency-key"] = opts.idemKey ?? randomUUID();
  headers.origin = opts.origin === null ? undefined! : (opts.origin ?? ORIGIN);
  if (opts.origin === null) delete headers.origin;
  return purchasePOST(
    new Request(BASE, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

function errorOf(payload: unknown): { code: string; details?: Array<Record<string, unknown>> } {
  return (payload as { error: { code: string; details?: Array<Record<string, unknown>> } }).error;
}

describe("shop.purchase auth / origin", () => {
  it("401 UNAUTHENTICATED without a session cookie", async () => {
    const response = await postPurchase(undefined, { itemId: CHEAPEST.itemId, expectedVersion: 1 });
    expect(response.status).toBe(401);
    expect(errorOf(await response.json()).code).toBe("UNAUTHENTICATED");
  });

  it("403 CSRF_ORIGIN_REJECTED for a cross-origin POST", async () => {
    const account = await makeAccount("buy-origin@example.test");
    const response = await postPurchase(
      account.cookie,
      { itemId: CHEAPEST.itemId, expectedVersion: account.version },
      { origin: "http://evil.test" },
    );
    expect(response.status).toBe(403);
    expect(errorOf(await response.json()).code).toBe("CSRF_ORIGIN_REJECTED");
  });

  it("403 CSRF_ORIGIN_REJECTED when Origin is absent on this non-GET", async () => {
    const account = await makeAccount("buy-origin-none@example.test");
    const response = await postPurchase(
      account.cookie,
      { itemId: CHEAPEST.itemId, expectedVersion: account.version },
      { origin: null },
    );
    expect(response.status).toBe(403);
    expect(errorOf(await response.json()).code).toBe("CSRF_ORIGIN_REJECTED");
  });
});

describe("shop.purchase validation (400s)", () => {
  it.each([
    ["missing Idempotency-Key", { idemKey: null }],
    ["non-UUID Idempotency-Key", { idemKey: "not-a-uuid" }],
  ])("%s → 400 VALIDATION_ERROR", async (_name, opts) => {
    const account = await makeAccount("buy-key@example.test");
    const response = await postPurchase(
      account.cookie,
      { itemId: CHEAPEST.itemId, expectedVersion: account.version },
      opts as PostOpts,
    );
    expect(response.status).toBe(400);
    expect(errorOf(await response.json()).code).toBe("VALIDATION_ERROR");
    expect(fake.ledgers).toHaveLength(0); // rejected before any execution
  });

  it.each([
    ["unknown field (client-supplied price rejected)", { itemId: "x", expectedVersion: 1, price: 1 }],
    ["missing itemId", { expectedVersion: 1 }],
    ["empty itemId", { itemId: "", expectedVersion: 1 }],
    ["expectedVersion zero", { itemId: "x", expectedVersion: 0 }],
    ["expectedVersion string", { itemId: "x", expectedVersion: "1" }],
    ["expectedVersion missing", { itemId: "x" }],
  ])("%s → 400 VALIDATION_ERROR", async (_name, body) => {
    const account = await makeAccount("buy-body@example.test");
    const response = await postPurchase(account.cookie, body);
    expect(response.status).toBe(400);
    expect(errorOf(await response.json()).code).toBe("VALIDATION_ERROR");
    expect(fake.ledgers).toHaveLength(0);
  });
});

describe("shop.purchase rejections carry authoritative state", () => {
  it("404 unknown item — no mutation of balance, inventory, ledger or audit", async () => {
    const account = await makeAccount("buy-404@example.test", { draftCoin: 500 });
    const response = await postPurchase(account.cookie, {
      itemId: "no-such-item",
      expectedVersion: account.version,
    });
    expect(response.status).toBe(404);
    expect(errorOf(await response.json()).code).toBe("NOT_FOUND");

    const profile = fake.profiles.find((p) => p.id === account.profileId)!;
    expect(profile.draftCoin).toBe(500);
    expect(profile.version).toBe(account.version);
    expect(fake.inventory).toHaveLength(0);
    expect(fake.ledgers).toHaveLength(0);
    expect(fake.audits).toHaveLength(0);
    expect(fake.idempotency).toHaveLength(0); // reservation released
  });

  it("409 STALE_VERSION carries currentVersion + balance, mutates nothing", async () => {
    const account = await makeAccount("buy-stale@example.test", { draftCoin: 500, version: 7 });
    const response = await postPurchase(account.cookie, {
      itemId: CHEAPEST.itemId,
      expectedVersion: 3, // old
    });
    expect(response.status).toBe(409);
    const error = errorOf(await response.json());
    expect(error.code).toBe("STALE_VERSION");
    expect(error.details?.[0]).toMatchObject({ currentVersion: 7, currentBalance: 500 });
    expect(fake.ledgers).toHaveLength(0);
    expect(fake.idempotency).toHaveLength(0);
  });

  it("409 INSUFFICIENT_FUNDS carries balance + version, mutates nothing", async () => {
    const account = await makeAccount("buy-poor@example.test", { draftCoin: 1 });
    const response = await postPurchase(account.cookie, {
      itemId: PRICIEST.itemId,
      expectedVersion: account.version,
    });
    expect(response.status).toBe(409);
    const error = errorOf(await response.json());
    expect(error.code).toBe("INSUFFICIENT_FUNDS");
    expect(error.details?.[0]).toMatchObject({ currentBalance: 1, currentVersion: account.version });
    const profile = fake.profiles.find((p) => p.id === account.profileId)!;
    expect(profile.draftCoin).toBe(1);
    expect(fake.inventory).toHaveLength(0);
    expect(fake.ledgers).toHaveLength(0);
    expect(fake.idempotency).toHaveLength(0); // released → honest retry possible
    expect(publishSse).not.toHaveBeenCalled(); // §12: failed purchase → no success event
  });

  it("409 CONFLICT already owned carries state, grants nothing new", async () => {
    const account = await makeAccount("buy-owned@example.test", { draftCoin: 10_000 });
    fake.inventory.push({
      profileId: account.profileId,
      itemId: CHEAPEST.itemId,
      ownedSince: new Date(),
    });
    const response = await postPurchase(account.cookie, {
      itemId: CHEAPEST.itemId,
      expectedVersion: account.version,
    });
    expect(response.status).toBe(409);
    const error = errorOf(await response.json());
    expect(error.code).toBe("CONFLICT");
    expect(error.details?.[0]).toMatchObject({
      currentBalance: 10_000,
      currentVersion: account.version,
    });
    expect(fake.inventory).toHaveLength(1);
    expect(fake.ledgers).toHaveLength(0);
    const profile = fake.profiles.find((p) => p.id === account.profileId)!;
    expect(profile.draftCoin).toBe(10_000);
  });
});

describe("shop.purchase success (atomic)", () => {
  it("201: deducts balance, grants inventory, one negative ledger row, audit row, version bump", async () => {
    const account = await makeAccount("buy-ok@example.test", { draftCoin: 10_000 });
    const response = await postPurchase(account.cookie, {
      itemId: CHEAPEST.itemId,
      expectedVersion: account.version,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      transactionId: string;
      itemId: string;
      balance: number;
      version: number;
    };
    expect(body.itemId).toBe(CHEAPEST.itemId);
    expect(body.balance).toBe(10_000 - CHEAPEST.price);
    expect(body.version).toBe(account.version + 1);
    expect(body.transactionId).toBeTruthy();

    const profile = fake.profiles.find((p) => p.id === account.profileId)!;
    expect(profile.draftCoin).toBe(10_000 - CHEAPEST.price);
    expect(profile.version).toBe(account.version + 1);
    expect(profile.draftCoin).toBeGreaterThanOrEqual(0);

    expect(fake.inventory).toHaveLength(1);
    expect(fake.inventory[0]).toMatchObject({ profileId: account.profileId, itemId: CHEAPEST.itemId });

    expect(fake.ledgers).toHaveLength(1);
    expect(fake.ledgers[0]).toMatchObject({
      profileId: account.profileId,
      type: "purchase",
      amount: -CHEAPEST.price, // signed convention: purchases negative
      reason: `shop:purchase:${CHEAPEST.itemId}`,
      sourceRef: body.transactionId,
    });

    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ eventType: "economy.purchase", userId: account.userId });

    // §9/§12: exactly two player-scoped events, published after the commit.
    expect(vi.mocked(publishSse)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(publishSse)).toHaveBeenNthCalledWith(1, account.userId, "economy.updated", {
      balance: 10_000 - CHEAPEST.price,
      reason: "purchase",
      version: account.version + 1,
    });
    expect(vi.mocked(publishSse)).toHaveBeenNthCalledWith(2, account.userId, "profile.updated", {
      version: account.version + 1,
    });

    // The idempotency outcome is stored for replay (contract §1.6).
    expect(fake.idempotency).toHaveLength(1);
    expect(fake.idempotency[0]).toMatchObject({ status: "completed", httpStatus: 201 });
  });

  it("two players' purchases are fully isolated", async () => {
    const a = await makeAccount("buy-iso-a@example.test", { draftCoin: 10_000 });
    const b = await makeAccount("buy-iso-b@example.test", { draftCoin: 10_000 });

    const response = await postPurchase(a.cookie, {
      itemId: CHEAPEST.itemId,
      expectedVersion: a.version,
    });
    expect(response.status).toBe(201);

    const profileB = fake.profiles.find((p) => p.id === b.profileId)!;
    expect(profileB.draftCoin).toBe(10_000);
    expect(profileB.version).toBe(b.version);
    expect(fake.inventory.filter((item) => item.profileId === b.profileId)).toHaveLength(0);
    expect(fake.ledgers.filter((row) => row.profileId === b.profileId)).toHaveLength(0);
  });
});

describe("shop.purchase idempotency (§1.6)", () => {
  it("same key + same body replays the stored 201 — exactly one charge", async () => {
    const account = await makeAccount("buy-replay@example.test", { draftCoin: 10_000 });
    const key = randomUUID();
    const body = { itemId: CHEAPEST.itemId, expectedVersion: account.version };

    const first = await postPurchase(account.cookie, body, { idemKey: key });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await postPurchase(account.cookie, body, { idemKey: key });
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(firstBody);

    // ONE deduction, ONE grant, ONE ledger row, ONE audit row — and the
    // replay itself published NO events (only the first execution did).
    const profile = fake.profiles.find((p) => p.id === account.profileId)!;
    expect(profile.draftCoin).toBe(10_000 - CHEAPEST.price);
    expect(profile.version).toBe(account.version + 1);
    expect(fake.inventory).toHaveLength(1);
    expect(fake.ledgers).toHaveLength(1);
    expect(fake.audits).toHaveLength(1);
    expect(vi.mocked(publishSse)).toHaveBeenCalledTimes(2);
  });

  it("same key + different body → 409 IDEMPOTENCY_MISMATCH, no second execution", async () => {
    const account = await makeAccount("buy-mismatch@example.test", { draftCoin: 10_000 });
    const key = randomUUID();

    const first = await postPurchase(
      account.cookie,
      { itemId: CHEAPEST.itemId, expectedVersion: account.version },
      { idemKey: key },
    );
    expect(first.status).toBe(201);

    const second = await postPurchase(
      account.cookie,
      { itemId: OTHER.itemId, expectedVersion: account.version + 1 }, // different fingerprint
      { idemKey: key },
    );
    expect(second.status).toBe(409);
    expect(errorOf(await second.json()).code).toBe("IDEMPOTENCY_MISMATCH");

    expect(fake.inventory).toHaveLength(1); // only the first purchase executed
    expect(fake.ledgers).toHaveLength(1);
  });

  it("same key while the first request is executing → 409 IDEMPOTENCY_IN_PROGRESS", async () => {
    const account = await makeAccount("buy-inflight@example.test", { draftCoin: 10_000 });
    const key = randomUUID();
    const requestBody = { itemId: CHEAPEST.itemId, expectedVersion: account.version };
    fake.idempotency.push({
      profileId: account.profileId,
      endpoint: ENDPOINT_SHOP_PURCHASE,
      key,
      fingerprint: requestFingerprint(ENDPOINT_SHOP_PURCHASE, requestBody),
      status: "in_progress",
      httpStatus: null,
      summary: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const response = await postPurchase(account.cookie, requestBody, { idemKey: key });
    expect(response.status).toBe(409);
    expect(errorOf(await response.json()).code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(fake.ledgers).toHaveLength(0);
    expect(fake.inventory).toHaveLength(0);
  });

  it("failed attempt releases the key: the same key can honestly retry and succeed", async () => {
    const account = await makeAccount("buy-retry@example.test", { draftCoin: 0 });
    const key = randomUUID();
    const body = { itemId: CHEAPEST.itemId, expectedVersion: account.version };

    const denied = await postPurchase(account.cookie, body, { idemKey: key });
    expect(denied.status).toBe(409);
    expect(errorOf(await denied.json()).code).toBe("INSUFFICIENT_FUNDS");
    expect(fake.idempotency).toHaveLength(0);

    // Coins arrive (dev fixture would do exactly this) → retry with the SAME key.
    fake.profiles.find((p) => p.id === account.profileId)!.draftCoin = 10_000;
    const retry = await postPurchase(account.cookie, body, { idemKey: key });
    expect(retry.status).toBe(201);
    expect(fake.ledgers).toHaveLength(1);
  });
});

describe("shop.purchase concurrency (overspend guard)", () => {
  it("two racing purchases: exactly one wins — balance never goes negative", async () => {
    const account = await makeAccount("buy-race@example.test", { draftCoin: 10_000 });

    const [first, second] = await Promise.all([
      postPurchase(account.cookie, {
        itemId: CHEAPEST.itemId,
        expectedVersion: account.version,
      }),
      postPurchase(account.cookie, { itemId: OTHER.itemId, expectedVersion: account.version }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = first.status === 201 ? first : second;
    const winnerBody = (await winner.json()) as { itemId: string; balance: number; version: number };
    const winnerEntry = CATALOG_ENTRIES.find((e) => e.itemId === winnerBody.itemId)!;

    const profile = fake.profiles.find((p) => p.id === account.profileId)!;
    expect(profile.draftCoin).toBe(10_000 - winnerEntry.price);
    expect(profile.draftCoin).toBeGreaterThanOrEqual(0);
    expect(profile.version).toBe(account.version + 1); // bumped exactly once
    expect(fake.inventory).toHaveLength(1);
    expect(fake.ledgers).toHaveLength(1);

    const loser = first.status === 201 ? second : first;
    const loserError = errorOf(await loser.json());
    expect(loserError.code).toBe("STALE_VERSION"); // honest stateful rejection
    expect(loserError.details?.[0]).toMatchObject({ currentVersion: account.version + 1 });
  });
});
