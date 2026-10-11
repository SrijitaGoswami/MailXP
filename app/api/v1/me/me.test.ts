/**
 * Phase B4 — /api/v1/me route tests (MOCKED storage: in-memory fake DB).
 * GET: identity only from the server session; response carries exactly the
 * contract fields — never password hashes, session ids, or token hashes.
 * DELETE: password re-auth, Origin check, per-player rate limit, atomic
 * 202 lifecycle marker, all sessions revoked, exactly one audit row across
 * retries, cookie cleared, no provider (Gmail) code anywhere by construction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashPassword } from "@/lib/server/password";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { DELETE as meDELETE, GET as meGET } from "./route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;
const VALID_PW = "a-very-good-passphrase";

let fake: FakeDb;
let ipSeq = 0;
const getDbMock = vi.mocked(getDb);

beforeEach(() => {
  fake = createFakeDb();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(fake.client);
  ipSeq += 1;
});

function nextIp(): string {
  ipSeq += 1;
  return `10.9.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

function cookieFor(response: Response): string {
  const match = /mailxp\.session=([^;]+)/i.exec(response.headers.get("set-cookie") ?? "");
  expect(match).toBeTruthy();
  return `mailxp.session=${match?.[1]}`;
}

async function registerUser(email = "me-user@example.com") {
  // Seed directly: the password register route is retired (Google-only), so
  // tests create the user + profile + session here. The DELETE route re-auths
  // against the stored hash, so we set a real bcrypt hash of VALID_PW.
  const passwordHash = await hashPassword(VALID_PW);
  const user = (await fake.client.user.create({ data: { email, passwordHash } })) as { id: string };
  await fake.client.playerProfile.create({ data: { userId: user.id, prefs: {} } });
  const raw = `me-seed-${email}-${Math.random().toString(36).slice(2)}`;
  await fake.client.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(raw),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 1e9),
    },
  });
  return { cookie: `mailxp.session=${raw}`, playerId: user.id };
}

function meRequest(method: "GET" | "DELETE", opts: { cookie?: string; body?: unknown; origin?: string | null } = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": nextIp() };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}/me`, {
    method,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    headers,
  });
}

describe("GET /api/v1/me", () => {
  it("401 UNAUTHENTICATED without a cookie", async () => {
    const response = await meGET(meRequest("GET"));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("401 SESSION_EXPIRED for a dead or unknown cookie", async () => {
    const unknown = await meGET(meRequest("GET", { cookie: "mailxp.session=forged-token-value" }));
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("SESSION_EXPIRED");

    const registered = await registerUser("expired@x.co");
    const raw = registered.cookie.replace("mailxp.session=", "");
    const row = fake.sessions.find((s) => s.tokenHash === hashSessionToken(raw));
    (row as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);
    const expired = await meGET(meRequest("GET", { cookie: registered.cookie }));
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe("SESSION_EXPIRED");
  });

  it("200: exactly the contract player fields — no secrets, ever", async () => {
    const registered = await registerUser("visible@x.co");
    const response = await meGET(meRequest("GET", { cookie: registered.cookie }));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as { player: Record<string, unknown> };
    expect(Object.keys(body.player).sort()).toEqual(["createdAt", "email", "emailVerified", "id"]);
    expect(body.player.id).toBe(registered.playerId);
    expect(body.player.emailVerified).toBe(false);
    // Leak checks against the whole payload:
    for (const forbidden of ["password", "$2", "tokenHash", "session", "mailxp.session"]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).not.toContain(String(fake.users[0].passwordHash));
  });

  it("identity comes from the server session only (no caller-supplied id accepted)", async () => {
    const registered = await registerUser("scope@x.co");
    const response = await meGET(
      new Request(`${BASE}/me?playerId=someone-else`, { headers: { cookie: registered.cookie, origin: ORIGIN } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { player: { id: string } };
    expect(body.player.id).toBe(registered.playerId); // session wins over the query
  });
});

describe("DELETE /api/v1/me", () => {
  it("403 without/with a cross Origin", async () => {
    const registered = await registerUser("del-csrf@x.co");
    const noOrigin = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: { password: VALID_PW }, origin: null }));
    expect(noOrigin.status).toBe(403);
    const cross = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: { password: VALID_PW }, origin: "https://evil.example" }));
    expect(cross.status).toBe(403);
    expect(fake.users[0].deletionRequestedAt).toBeNull(); // untouched
  });

  it("401 without a session; 400 without a password; 401 on wrong password (no mutation)", async () => {
    const noSession = await meDELETE(meRequest("DELETE", { body: { password: VALID_PW } }));
    expect(noSession.status).toBe(401);

    const registered = await registerUser("del-auth@x.co");
    const noPassword = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: {} }));
    expect(noPassword.status).toBe(400);

    const wrong = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: { password: "not-the-password" } }));
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("INVALID_CREDENTIALS");
    expect(fake.users[0].deletionRequestedAt).toBeNull();
    expect(fake.audits.filter((a) => a.eventType === "auth.deletion_requested")).toHaveLength(0);
  });

  it("202: marker set once, ALL sessions revoked, cookie cleared, single audit row", async () => {
    const registered = await registerUser("del-ok@x.co");
    const response = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: { password: VALID_PW } }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({});
    expect(response.headers.get("set-cookie")?.toLowerCase()).toContain("max-age=0");
    expect(fake.users[0].deletionRequestedAt).toBeTruthy();
    for (const session of fake.sessions) expect(session.revokedAt).toBeTruthy();
    expect(fake.audits.filter((a) => a.eventType === "auth.deletion_requested")).toHaveLength(1);

    // Retry-safety: the session is now dead → 401, NO duplicate work.
    const retry = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: { password: VALID_PW } }));
    expect(retry.status).toBe(401);
    expect(((await retry.json()) as { error: { code: string } }).error.code).toBe("SESSION_EXPIRED");
    expect(fake.audits.filter((a) => a.eventType === "auth.deletion_requested")).toHaveLength(1);
    expect(fake.users.length).toBe(1); // no destructive duplication
  });

  it("B7: appends exactly ONE outbox event atomically with the deletion marker", async () => {
    const registered = await registerUser("del-outbox@x.co");
    const userId = fake.users[0].id as string;

    const response = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: { password: VALID_PW } }));
    expect(response.status).toBe(202);

    // Exactly one event, correct type, minimal payload (internal id only),
    // pending for the worker's relay — written in the same tx as the marker.
    expect(fake.outboxEvents).toHaveLength(1);
    const event = fake.outboxEvents[0]!;
    expect(event.eventType).toBe("account.deletion_requested");
    expect(event.payload).toEqual({ userId });
    expect(event.status).toBe("pending");
    expect(event.eventVersion).toBe(1);

    // A retried request (dead session → 401) appends nothing more.
    const retry = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: { password: VALID_PW } }));
    expect(retry.status).toBe(401);
    expect(fake.outboxEvents).toHaveLength(1);
  });

  it("B7: guard path (marker already set) appends NO event — no duplicate work", async () => {
    const registered = await registerUser("del-outbox-guard@x.co");
    fake.users[0].deletionRequestedAt = new Date(Date.now() - 5000);
    // Simulate a race survivor: a still-valid session despite the marker.
    const raw = registered.cookie.replace("mailxp.session=", "");
    const row = fake.sessions.find((s) => s.tokenHash === hashSessionToken(raw));
    (row as { revokedAt: Date | null }).revokedAt = null;

    const response = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: { password: VALID_PW } }));
    expect(response.status).toBe(202);
    expect(fake.outboxEvents).toHaveLength(0); // claimed.count was 0 -> no append
    expect(fake.audits.filter((a) => a.eventType === "auth.deletion_requested")).toHaveLength(0);
  });

  it("idempotent even when a session coexists with an already-set marker (guard path)", async () => {
    const registered = await registerUser("del-guard@x.co");
    fake.users[0].deletionRequestedAt = new Date(Date.now() - 5000);
    // Simulate a race survivor: a still-valid session despite the marker.
    const raw = registered.cookie.replace("mailxp.session=", "");
    const row = fake.sessions.find((s) => s.tokenHash === hashSessionToken(raw));
    (row as { revokedAt: Date | null }).revokedAt = null;
    const response = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: { password: VALID_PW } }));
    expect(response.status).toBe(202);
    expect(fake.audits.filter((a) => a.eventType === "auth.deletion_requested")).toHaveLength(0); // no duplicate audit
  });

  it("rate: general class per player (60/min)", async () => {
    const registered = await registerUser("del-rate@x.co");
    // Rate is consumed after session resolution but BEFORE password work, so
    // password-less bodies (→ 400) cheaply drain the player's 60/min bucket.
    let saw429 = false;
    for (let i = 0; i < 61; i += 1) {
      const response = await meDELETE(meRequest("DELETE", { cookie: registered.cookie, body: {} }));
      if (response.status === 429) {
        saw429 = true;
        expect(response.headers.get("Retry-After")).toBeTruthy();
      } else {
        expect(response.status).toBe(400);
      }
    }
    expect(saw429).toBe(true); // 61st call is over the 60/min limit
    expect(fake.users[0].deletionRequestedAt).toBeNull(); // never re-authed → never mutated
  });
});
