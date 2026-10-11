/**
 * Phase B5 — `game.preferencesUpdate` route tests (MOCKED storage: in-memory
 * fake DB; sessions constructed directly — auth is covered by B4 suites).
 *
 * Covers phase_b5 §7/§11: Origin rejection before any work, 401s, the
 * six-key allowlist (unknown keys AND balance/inventory fields rejected),
 * exact type/bounds validation, expectedVersion → 409 STALE_VERSION with the
 * contract's current-version details, atomic conditional writes under
 * concurrency, version increment, per-player scoping, the general rate class,
 * SSE emission after commit, and secret exclusion.
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashSessionToken } from "@/lib/server/session";
import { resetSseHub, subscribeSse } from "@/lib/server/sseHub";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { PATCH as preferencesPATCH } from "./preferences/route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1/game/preferences`;
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
  resetSseHub();
});

interface Account {
  userId: string;
  profileId: string;
  cookie: string;
}

async function makeAccount(email: string): Promise<Account> {
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
    data: { userId: user.id, prefs: DEFAULT_PREFS },
  })) as Record<string, unknown>;
  return { userId: user.id as string, profileId: profile.id as string, cookie: `mailxp.session=${token}` };
}

interface PatchOpts {
  origin?: string | null;
}

/** Convenience wrapper: builds the Request, invokes the route handler. */
function patchPrefs(cookie: string | undefined, body: unknown, opts: PatchOpts = {}): Promise<Response> {
  return preferencesPATCH(patch(cookie, body, opts));
}

function patch(cookie: string | undefined, body: unknown, opts: PatchOpts = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (cookie) headers.cookie = cookie;
  return new Request(BASE, {
    method: "PATCH",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("game.preferencesUpdate guards", () => {
  it("rejects a missing Origin before any work (403 CSRF_ORIGIN_REJECTED)", async () => {
    const account = await makeAccount("prefs-origin@example.test");
    const response = await patchPrefs(account.cookie, { preferences: { muted: true }, expectedVersion: 1 }, { origin: null });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CSRF_ORIGIN_REJECTED");
    const row = fake.profiles[0] as Record<string, unknown>;
    expect((row.prefs as Record<string, unknown>).muted).toBe(false);
    expect(row.version).toBe(1); // untouched
  });

  it("rejects a cross-site Origin (403)", async () => {
    const account = await makeAccount("prefs-cross@example.test");
    const response = await patchPrefs(
      account.cookie,
      { preferences: { muted: true }, expectedVersion: 1 },
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
  });

  it("401 UNAUTHENTICATED / SESSION_EXPIRED without a valid session", async () => {
    const none = await patchPrefs(undefined, { preferences: { muted: true }, expectedVersion: 1 });
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");

    const dead = await patchPrefs("mailxp.session=deadbeef", { preferences: { muted: true }, expectedVersion: 1 });
    expect(dead.status).toBe(401);
    expect(((await dead.json()) as { error: { code: string } }).error.code).toBe("SESSION_EXPIRED");
  });
});

describe("game.preferencesUpdate validation (400s)", () => {
  const cases: Array<[string, unknown]> = [
    ["missing expectedVersion", { preferences: { muted: true } }],
    ["expectedVersion non-integer", { preferences: { muted: true }, expectedVersion: 1.5 }],
    ["expectedVersion string", { preferences: { muted: true }, expectedVersion: "1" }],
    ["preferences missing", { expectedVersion: 1 }],
    ["preferences array", { preferences: [], expectedVersion: 1 }],
    ["preferences empty", { preferences: {}, expectedVersion: 1 }],
    ["unknown key rejected", { preferences: { theme: "dark" }, expectedVersion: 1 }],
    ["balance sneaked in", { preferences: { draftCoin: 9999 }, expectedVersion: 1 }],
    ["inventory sneaked in", { preferences: { ownedItems: ["forest"] }, expectedVersion: 1 }],
    ["owner id sneaked in", { preferences: { playerId: "someone" }, expectedVersion: 1 }],
    ["muted wrong type", { preferences: { muted: "yes" }, expectedVersion: 1 }],
    ["volume out of bounds", { preferences: { masterVolume: 1.5 }, expectedVersion: 1 }],
    ["volume wrong type", { preferences: { uiVolume: "loud" }, expectedVersion: 1 }],
    ["motion invalid enum", { preferences: { motion: "hyper" }, expectedVersion: 1 }],
    ["touchControls invalid enum", { preferences: { touchControls: "maybe" }, expectedVersion: 1 }],
  ];

  for (const [name, body] of cases) {
    it(`400 VALIDATION_ERROR: ${name}`, async () => {
      const account = await makeAccount("prefs-validation@example.test");
      const response = await patchPrefs(account.cookie, body);
      expect(response.status).toBe(400);
      const parsed = (await response.json()) as { error: { code: string; details?: Array<{ field: string }> } };
      expect(parsed.error.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(parsed.error.details)).toBe(true);
      const row = fake.profiles[0] as Record<string, unknown>;
      expect(row.version).toBe(1); // rejected writes never mutate
      expect(row.prefs).toEqual(DEFAULT_PREFS);
    });
  }

  it("malformed JSON body → 400", async () => {
    const account = await makeAccount("prefs-malformed@example.test");
    const response = await patchPrefs(account.cookie, "{not json");
    expect(response.status).toBe(400);
  });
});

describe("game.preferencesUpdate success and concurrency", () => {
  it("partial patch merges, increments version, returns the contract body", async () => {
    const account = await makeAccount("prefs-success@example.test");
    const response = await patchPrefs(account.cookie, {
      preferences: { muted: true, motion: "reduced" },
      expectedVersion: 1,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      preferences: Record<string, unknown>;
      version: number;
    };
    expect(body.version).toBe(2);
    expect(body.preferences).toEqual({ ...DEFAULT_PREFS, muted: true, motion: "reduced" });

    const row = fake.profiles.find((p) => p.id === account.profileId) as Record<string, unknown>;
    expect(row.version).toBe(2);
    expect(row.prefs).toEqual({ ...DEFAULT_PREFS, muted: true, motion: "reduced" });
    expect(JSON.stringify(body)).not.toContain("$2b$10$"); // no internals
  });

  it("stale expectedVersion → 409 STALE_VERSION with currentVersion, no mutation", async () => {
    const account = await makeAccount("prefs-stale@example.test");
    const first = await patchPrefs(account.cookie, { preferences: { muted: true }, expectedVersion: 1 });
    expect(first.status).toBe(200);

    const second = await patchPrefs(account.cookie, { preferences: { muted: false }, expectedVersion: 1 });
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      error: { code: string; details?: Array<{ field: string; currentVersion?: number }> };
    };
    expect(body.error.code).toBe("STALE_VERSION");
    expect(body.error.details?.[0]?.field).toBe("expectedVersion");
    expect(body.error.details?.[0]?.currentVersion).toBe(2);

    const row = fake.profiles.find((p) => p.id === account.profileId) as Record<string, unknown>;
    expect(row.version).toBe(2); // loser did not overwrite
    expect((row.prefs as Record<string, unknown>).muted).toBe(true);
  });

  it("concurrent writers with the same expectedVersion: exactly one wins", async () => {
    const account = await makeAccount("prefs-race@example.test");
    const [a, b] = await Promise.all([
      patchPrefs(account.cookie, { preferences: { masterVolume: 0.1 }, expectedVersion: 1 }),
      patchPrefs(account.cookie, { preferences: { masterVolume: 0.9 }, expectedVersion: 1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const row = fake.profiles.find((p) => p.id === account.profileId) as Record<string, unknown>;
    expect(row.version).toBe(2); // one increment, no silent overwrite
  });

  it("player A's patch never touches player B's profile (isolation)", async () => {
    const a = await makeAccount("prefs-iso-a@example.test");
    const b = await makeAccount("prefs-iso-b@example.test");
    const response = await patchPrefs(a.cookie, { preferences: { muted: true }, expectedVersion: 1 });
    expect(response.status).toBe(200);

    const rowB = fake.profiles.find((p) => p.id === b.profileId) as Record<string, unknown>;
    expect(rowB.version).toBe(1);
    expect(rowB.prefs).toEqual(DEFAULT_PREFS);
  });

  it("404 when the user has no profile row (no create-on-write)", async () => {
    const account = await makeAccount("prefs-noprofile@example.test");
    fake.profiles.length = 0;
    const response = await patchPrefs(account.cookie, { preferences: { muted: true }, expectedVersion: 1 });
    expect(response.status).toBe(404);
    expect(fake.profiles).toHaveLength(0);
  });
});

describe("game.preferencesUpdate rate limit and SSE", () => {
  it("61st mutation in a minute → 429 with Retry-After", async () => {
    const account = await makeAccount("prefs-rate@example.test");
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await patchPrefs(account.cookie, { preferences: { masterVolume: 0.5 }, expectedVersion: 1 });
      if (last.status === 429) break;
    }
    expect(last).not.toBeNull();
    expect((last as Response).status).toBe(429);
    expect((last as Response).headers.get("Retry-After")).toBeTruthy();
  });

  it("publishes profile.updated {version} to that player's stream after commit", async () => {
    const account = await makeAccount("prefs-sse@example.test");
    const received: string[] = [];
    const sub = subscribeSse(account.userId, (chunk) => received.push(chunk));
    expect(sub.ok).toBe(true);

    const response = await patchPrefs(account.cookie, { preferences: { muted: true }, expectedVersion: 1 });
    expect(response.status).toBe(200);

    expect(received).toHaveLength(1);
    expect(received[0]).toContain("event: profile.updated");
    expect(received[0]).toContain('data: {"version":2}');
    (sub as { unsubscribe: () => void }).unsubscribe();
  });
});
