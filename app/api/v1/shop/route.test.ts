/**
 * Phase B6 — `shop.catalog` route tests (MOCKED storage: in-memory fake DB;
 * sessions constructed directly — auth flows are covered by B4 suites).
 *
 * Covers contract §4 shop.catalog: 401s, contract item shape (no internal
 * columns), server-truth prices from the canonical catalog, `available`
 * driven by ownership, stable catalogVersion, GET-Origin policy
 * (absent allowed / cross-origin rejected).
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_ENTRIES } from "@/lib/server/catalog";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { GET as shopGET } from "./route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1/shop`;
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

interface Account {
  userId: string;
  profileId: string;
  cookie: string;
}

async function makeAccount(email: string): Promise<Account> {
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

function getShop(cookie?: string, headers: Record<string, string> = {}): Promise<Response> {
  const all: Record<string, string> = { ...headers };
  if (cookie) all.cookie = cookie;
  return shopGET(new Request(BASE, { headers: all }));
}

describe("shop.catalog auth", () => {
  it("401 UNAUTHENTICATED without a session cookie", async () => {
    const response = await getShop();
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("401 SESSION_EXPIRED for a dead cookie", async () => {
    const response = await getShop("mailxp.session=deadbeef");
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("SESSION_EXPIRED");
  });
});

describe("shop.catalog origin (GET policy)", () => {
  it("absent Origin is allowed for this same-origin GET (B5 GET policy)", async () => {
    const account = await makeAccount("shop-origin-none@example.test");
    const response = await getShop(account.cookie);
    expect(response.status).toBe(200);
  });

  it("cross-origin GET is rejected with 403", async () => {
    const account = await makeAccount("shop-origin-x@example.test");
    const response = await getShop(account.cookie, { origin: "http://evil.test" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "CSRF_ORIGIN_REJECTED",
    );
  });
});

describe("shop.catalog content", () => {
  it("returns every canonical item with the contract shape and no internal columns", async () => {
    const account = await makeAccount("shop-shape@example.test");
    const response = await getShop(account.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      catalogVersion: string;
    };

    expect(body.items).toHaveLength(CATALOG_ENTRIES.length);
    expect(body.items[0] && Object.keys(body.items[0]).sort()).toEqual(
      ["available", "itemId", "kind", "name", "price"].sort(),
    );
    expect(JSON.stringify(body)).not.toContain("profileId");
    expect(typeof body.catalogVersion).toBe("string");
    expect(body.catalogVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it("prices are server truth: identical to the canonical catalog, positive integers", async () => {
    const account = await makeAccount("shop-prices@example.test");
    const response = await getShop(account.cookie);
    const body = (await response.json()) as { items: Array<{ itemId: string; price: number }> };

    const serverPrices = new Map(body.items.map((item) => [item.itemId, item.price]));
    for (const entry of CATALOG_ENTRIES) {
      expect(serverPrices.get(entry.itemId)).toBe(entry.price);
      expect(entry.price).toBeGreaterThan(0);
    }
  });

  it("owned items report available=false; unowned report true", async () => {
    const account = await makeAccount("shop-owned@example.test");
    const ownedEntry = CATALOG_ENTRIES[0];
    fake.inventory.push({
      profileId: account.profileId,
      itemId: ownedEntry.itemId,
      ownedSince: new Date(),
    });

    const response = await getShop(account.cookie);
    const body = (await response.json()) as {
      items: Array<{ itemId: string; available: boolean }>;
    };
    const owned = body.items.find((item) => item.itemId === ownedEntry.itemId);
    const unowned = body.items.find((item) => item.itemId !== ownedEntry.itemId);
    expect(owned?.available).toBe(false);
    expect(unowned?.available).toBe(true);
  });

  it("missing profile → full catalog with everything available (no create-on-read)", async () => {
    const account = await makeAccount("shop-noprofile@example.test");
    fake.profiles.length = 0;
    const response = await getShop(account.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ available: boolean }> };
    expect(body.items.every((item) => item.available)).toBe(true);
    expect(fake.profiles).toHaveLength(0);
  });

  it("catalogVersion is stable across calls for an unchanged catalog", async () => {
    const account = await makeAccount("shop-version@example.test");
    const first = (await (await getShop(account.cookie)).json()) as { catalogVersion: string };
    const second = (await (await getShop(account.cookie)).json()) as { catalogVersion: string };
    expect(first.catalogVersion).toBe(second.catalogVersion);
  });
});
