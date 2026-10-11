/**
 * Phase B5 — `game.ledger` route tests (MOCKED storage: in-memory fake DB;
 * sessions constructed directly — auth is covered by B4 suites).
 *
 * Covers phase_b5 §8/§11: 401s, the honest EMPTY list (B6 writes the rows —
 * no fake entries), §1.5 cursor pagination (default 25 / max 100, opaque
 * cursor, createdAt DESC + id DESC, nextCursor null at end), invalid
 * limit/cursor/params → 400, per-player isolation, item shape, and the
 * missing-profile anomaly path (empty, never create-on-read).
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { GET as ledgerGET } from "./ledger/route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1/game/ledger`;
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
  return { userId: user.id as string, profileId: profile.id as string, cookie: `mailxp.session=${token}` };
}

function getLedger(cookie?: string, query = ""): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return ledgerGET(new Request(`${BASE}${query}`, { headers }));
}

function seed(profileId: string, index: number, createdAt: string): Record<string, unknown> {
  const row = {
    id: `led-${String(index).padStart(4, "0")}`,
    profileId,
    type: index % 2 === 0 ? "quest_reward" : "purchase",
    amount: index % 2 === 0 ? 25 : -40,
    reason: index % 2 === 0 ? "Daily Inbox Zero" : "Outfit: courier",
    sourceRef: index % 2 === 0 ? `reward-${index}` : `purchase-${index}`,
    createdAt: new Date(createdAt),
  };
  fake.ledgers.push(row);
  return row as unknown as Record<string, unknown>;
}

describe("game.ledger auth", () => {
  it("401 UNAUTHENTICATED without a session cookie", async () => {
    const response = await getLedger();
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("401 SESSION_EXPIRED for a dead cookie", async () => {
    const response = await getLedger("mailxp.session=deadbeef");
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("SESSION_EXPIRED");
  });
});

describe("game.ledger content", () => {
  it("returns an honest empty list before B6 writes any rows", async () => {
    const account = await makeAccount("ledger-empty@example.test");
    const response = await getLedger(account.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it("missing profile → empty list without creating a row", async () => {
    const account = await makeAccount("ledger-noprofile@example.test");
    fake.profiles.length = 0;
    const response = await getLedger(account.cookie);
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ items: [], nextCursor: null });
    expect(fake.profiles).toHaveLength(0);
  });

  it("never returns another player's entries (session-scoped caller)", async () => {
    const a = await makeAccount("ledger-iso-a@example.test");
    const b = await makeAccount("ledger-iso-b@example.test");
    seed(a.profileId, 1, "2026-02-01T00:00:00.000Z");
    seed(b.profileId, 2, "2026-02-02T00:00:00.000Z");

    const response = await getLedger(a.cookie);
    const body = (await response.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("led-0001");
  });

  it("exposes exactly the contract item shape (no internal columns)", async () => {
    const account = await makeAccount("ledger-shape@example.test");
    seed(account.profileId, 4, "2026-03-01T12:00:00.000Z");

    const response = await getLedger(account.cookie);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ["amount", "createdAt", "id", "reason", "sourceRef", "type"].sort(),
    );
    expect(body.items[0]).toEqual({
      id: "led-0004",
      type: "quest_reward",
      amount: 25,
      reason: "Daily Inbox Zero",
      sourceRef: "reward-4",
      createdAt: "2026-03-01T12:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("profileId");
  });
});

describe("game.ledger pagination (§1.5)", () => {
  it("newest-first with stable id tie-break, then walks the cursor to the end", async () => {
    const account = await makeAccount("ledger-page@example.test");
    const sameStamp = "2026-04-01T00:00:00.000Z";
    // Same createdAt on three rows → id DESC tie-break decides their order.
    seed(account.profileId, 1, "2026-03-31T00:00:00.000Z");
    seed(account.profileId, 2, sameStamp);
    seed(account.profileId, 3, sameStamp);
    seed(account.profileId, 4, "2026-04-02T00:00:00.000Z");

    const first = await getLedger(account.cookie, "?limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(firstBody.items.map((i) => i.id)).toEqual(["led-0004", "led-0003"]);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await getLedger(account.cookie, `?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`);
    const secondBody = (await second.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(secondBody.items.map((i) => i.id)).toEqual(["led-0002", "led-0001"]);
    expect(secondBody.nextCursor).toBeNull(); // end of list
  });

  it("defaults to limit 25: pages 25 then the remainder", async () => {
    const account = await makeAccount("ledger-default@example.test");
    for (let i = 1; i <= 30; i += 1) {
      seed(account.profileId, i, new Date(Date.UTC(2026, 4, i)).toISOString());
    }

    const first = await getLedger(account.cookie);
    const firstBody = (await first.json()) as { items: unknown[]; nextCursor: string | null };
    expect(firstBody.items).toHaveLength(25);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await getLedger(account.cookie, `?cursor=${encodeURIComponent(firstBody.nextCursor as string)}`);
    const secondBody = (await second.json()) as { items: unknown[]; nextCursor: string | null };
    expect(secondBody.items).toHaveLength(5);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("clients can dedupe: overlapping pages are stable under id ordering", async () => {
    const account = await makeAccount("ledger-dedupe@example.test");
    seed(account.profileId, 1, "2026-05-01T00:00:00.000Z");
    seed(account.profileId, 2, "2026-05-02T00:00:00.000Z");

    const full = (await (await getLedger(account.cookie)).json()) as { items: Array<{ id: string }> };
    const paged = (await (await getLedger(account.cookie, "?limit=1")).json()) as {
      items: Array<{ id: string }>;
      nextCursor: string;
    };
    const rest = (await (
      await getLedger(account.cookie, `?limit=10&cursor=${encodeURIComponent(paged.nextCursor)}`)
    ).json()) as { items: Array<{ id: string }> };
    const combined = [...paged.items, ...rest.items].map((i) => i.id);
    expect(combined).toEqual(full.items.map((i) => i.id)); // dedupe by id is sufficient
  });
});

describe("game.ledger validation (400s)", () => {
  it.each([
    ["limit=0", "?limit=0"],
    ["limit=101", "?limit=101"],
    ["limit=abc", "?limit=abc"],
    ["limit=-5", "?limit=-5"],
    ["malformed cursor", "?cursor=not-a-cursor"],
    ["cursor wrong JSON", `?cursor=${encodeURIComponent(Buffer.from("{}").toString("base64url"))}`],
    ["unsupported query param", "?page=2"],
  ])("%s → 400 VALIDATION_ERROR", async (_name, query) => {
    const account = await makeAccount("ledger-invalid@example.test");
    const response = await getLedger(account.cookie, query);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("limit=100 (the contract max) is accepted", async () => {
    const account = await makeAccount("ledger-max@example.test");
    seed(account.profileId, 1, "2026-06-01T00:00:00.000Z");
    const response = await getLedger(account.cookie, "?limit=100");
    expect(response.status).toBe(200);
  });
});
