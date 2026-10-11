/**
 * Auth route tests (MOCKED storage: in-memory fake DB; real bcryptjs hashing
 * and real token generation/hashing).
 *
 * Google-only entrance (user decision 2026-10-11): password register/login are
 * RETIRED — both routes answer 403 GOOGLE_SIGNIN_REQUIRED so no dummy account
 * or password-entry is possible even via a direct API call. Every other auth
 * route (logout, verify-email, resend, forgot/reset) still needs a live user
 * + session to exercise, so this suite SEEDS them directly against the fakeDb
 * (the Google sign-in callback is the only path that creates accounts now).
 *
 * Covers: register/login refusal (+ origin still gated); logout revocation;
 * verification token invalid/expired/consumed/replay; resend/forgot always-202;
 * reset expiry/single-use/revokes-all; origin rejection on every mutation;
 * secrets never in logs/responses; request-ID propagation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashPassword } from "@/lib/server/password";
import { hashSessionToken } from "@/lib/server/session";
import { hashAuthToken, issueToken } from "@/lib/server/tokens";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { POST as loginPOST } from "./login/route";
import { POST as logoutPOST } from "./logout/route";
import { POST as forgotPOST } from "./password/forgot/route";
import { POST as resetPOST } from "./password/reset/route";
import { POST as registerPOST } from "./register/route";
import { POST as resendPOST } from "./resend-verification/route";
import { POST as verifyPOST } from "./verify-email/route";

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
  return `10.7.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

interface PostOpts {
  ip?: string;
  origin?: string | null;
  cookie?: string;
  requestId?: string;
}

function post(path: string, body: unknown, opts: PostOpts = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? nextIp() };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.requestId) headers["x-request-id"] = opts.requestId;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method: "POST",
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });
}

function setCookieOf(response: Response): string {
  const raw = response.headers.get("set-cookie");
  expect(raw).toBeTruthy();
  return (raw as string).toLowerCase();
}

function cookieFor(response: Response): string {
  const match = /mailxp\.session=([^;]+)/i.exec(response.headers.get("set-cookie") ?? "");
  expect(match).toBeTruthy();
  return `mailxp.session=${match?.[1]}`;
}

/**
 * Seed a user + profile + session + verification token DIRECTLY (the register
 * route is retired). Returns a session cookie, a raw verification token, and
 * the player id — the same shape the old registerUser produced, so downstream
 * route tests are unchanged.
 */
async function seedUser(
  email = "player1@example.com",
  opts: { verified?: boolean } = {},
): Promise<{ cookie: string; token: string; playerId: string }> {
  const passwordHash = await hashPassword(VALID_PW);
  const user = (await fake.client.user.create({
    data: { email, passwordHash, ...(opts.verified ? { emailVerifiedAt: new Date() } : {}) },
  })) as { id: string };
  await fake.client.playerProfile.create({ data: { userId: user.id, prefs: {} } });
  const raw = `seed-session-${email}-${Math.random().toString(36).slice(2)}`;
  await fake.client.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(raw),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 1e9),
    },
  });
  const verification = await issueToken(fake.client, user.id, "EMAIL_VERIFICATION");
  return { cookie: `mailxp.session=${raw}`, token: verification.token, playerId: user.id };
}

// --------------------------------------------------------------- register --

describe("POST /api/v1/auth/register (retired — Google-only)", () => {
  it("refuses with 403 GOOGLE_SIGNIN_REQUIRED and creates nothing", async () => {
    const response = await registerPOST(
      post("/auth/register", { email: "  Newbie@Example.COM ", password: VALID_PW }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("GOOGLE_SIGNIN_REQUIRED");
    expect(body.error.message).toContain("continue with Google");
    // No dummy account, no session, no profile, no token — nothing minted.
    expect(fake.users).toHaveLength(0);
    expect(fake.sessions).toHaveLength(0);
    expect(fake.profiles).toHaveLength(0);
    expect(fake.tokens).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("still rejects a missing/cross-site Origin with 403 BEFORE the refusal", async () => {
    const noOrigin = await registerPOST(post("/auth/register", { email: "a@x.co", password: VALID_PW }, { origin: null }));
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { error: { code: string } }).error.code).toBe("CSRF_ORIGIN_REJECTED");
    const cross = await registerPOST(
      post("/auth/register", { email: "a@x.co", password: VALID_PW }, { origin: "https://evil.example" }),
    );
    expect(cross.status).toBe(403);
    expect(fake.users).toHaveLength(0);
  });

  it("propagates a safe inbound X-Request-Id through the refusal", async () => {
    const fail = await registerPOST(post("/auth/register", { email: "bad" }, { requestId: "req-id-12345678" }));
    expect(fail.headers.get("X-Request-Id")).toBe("req-id-12345678");
    const body = (await fail.json()) as { error: { requestId: string } };
    expect(body.error.requestId).toBe("req-id-12345678");
  });
});

// ------------------------------------------------------------------ login --

describe("POST /api/v1/auth/login (retired — Google-only)", () => {
  it("refuses with 403 GOOGLE_SIGNIN_REQUIRED even for a REAL seeded account", async () => {
    await seedUser("known@example.com");
    const response = await loginPOST(
      post("/auth/login", { email: "known@example.com", password: VALID_PW }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("GOOGLE_SIGNIN_REQUIRED");
    // No session was issued for the password attempt.
    expect(fake.sessions).toHaveLength(1); // only the seeded one
  });

  it("never authenticates an unknown email either (uniform refusal)", async () => {
    const ghost = await loginPOST(post("/auth/login", { email: "ghost@example.com", password: "x" }));
    expect(ghost.status).toBe(403);
    expect(((await ghost.json()) as { error: { code: string } }).error.code).toBe("GOOGLE_SIGNIN_REQUIRED");
    expect(response(ghost).headers.get("set-cookie")).toBeNull();
  });

  it("still rejects a missing/cross-site Origin with 403 BEFORE the refusal", async () => {
    const noOrigin = await loginPOST(post("/auth/login", { email: "a@b.co", password: VALID_PW }, { origin: null }));
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { error: { code: string } }).error.code).toBe("CSRF_ORIGIN_REJECTED");
    const cross = await loginPOST(post("/auth/login", { email: "a@b.co", password: VALID_PW }, { origin: "https://evil.example" }));
    expect(cross.status).toBe(403);
  });
});

function response(r: Response): Response {
  return r;
}

// ---------------------------------------------------------------- logout --

describe("POST /api/v1/auth/logout", () => {
  it("no cookie at all → 401 UNAUTHENTICATED", async () => {
    const result = await logoutPOST(post("/auth/logout", undefined));
    expect(result.status).toBe(401);
    expect(((await result.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("valid session → 204, revoked server-side, cookie cleared, audited", async () => {
    const seeded = await seedUser("out@example.com");
    const result = await logoutPOST(post("/auth/logout", undefined, { cookie: seeded.cookie }));
    expect(result.status).toBe(204);
    const cleared = setCookieOf(result);
    expect(cleared).toContain("max-age=0");
    expect(cleared).toContain("httponly");
    const raw = seeded.cookie.replace("mailxp.session=", "");
    const row = fake.sessions.find((s) => s.tokenHash === hashSessionToken(raw));
    expect(row?.revokedAt).toBeTruthy();
    expect(fake.audits.filter((a) => a.eventType === "auth.logout")).toHaveLength(1);
  });

  it("already-dead session → 204 idempotent-tolerant, no duplicate audit", async () => {
    const seeded = await seedUser("twice@example.com");
    expect((await logoutPOST(post("/auth/logout", undefined, { cookie: seeded.cookie }))).status).toBe(204);
    expect((await logoutPOST(post("/auth/logout", undefined, { cookie: seeded.cookie }))).status).toBe(204);
    expect(fake.audits.filter((a) => a.eventType === "auth.logout")).toHaveLength(1);
  });

  it("cross-site Origin is rejected before anything else", async () => {
    const seeded = await seedUser("csrf@example.com");
    const result = await logoutPOST(post("/auth/logout", undefined, { cookie: seeded.cookie, origin: "https://evil.example" }));
    expect(result.status).toBe(403);
    const raw = seeded.cookie.replace("mailxp.session=", "");
    const row = fake.sessions.find((s) => s.tokenHash === hashSessionToken(raw));
    expect(row?.revokedAt).toBeNull(); // untouched
  });
});

// ----------------------------------------------------------- verify email --

describe("POST /api/v1/auth/verify-email", () => {
  it("valid token → 200, marks verified, invalidates other tokens, audits", async () => {
    const seeded = await seedUser("v@x.co");
    // A second outstanding token that must be invalidated by success:
    fake.tokens.push({
      id: "manual-2",
      userId: seeded.playerId,
      purpose: "EMAIL_VERIFICATION",
      tokenHash: hashAuthToken("second-outstanding-token"),
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
      createdAt: new Date(),
    });
    const result = await verifyPOST(post("/auth/verify-email", { token: seeded.token }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ player: { emailVerified: true } });
    expect(fake.users[0].emailVerifiedAt).toBeTruthy();
    const second = fake.tokens.find((t) => t.id === "manual-2");
    expect(second?.consumedAt).toBeTruthy(); // superseded/invalidated
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.email_verified");
  });

  it("replay (second use) → 404, unknown → 404, garbage → 404 — identical", async () => {
    const seeded = await seedUser("r@x.co");
    expect((await verifyPOST(post("/auth/verify-email", { token: seeded.token }))).status).toBe(200);
    const replay = await verifyPOST(
      post("/auth/verify-email", { token: seeded.token }, { requestId: "fixed-rid-verify" }),
    );
    const unknown = await verifyPOST(
      post("/auth/verify-email", { token: "no-such-token-abc" }, { requestId: "fixed-rid-verify" }),
    );
    expect(replay.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await replay.json()).toEqual(await unknown.json()); // no reason leakage
  });

  it("expired token → 404", async () => {
    const seeded = await seedUser("exp@x.co");
    const row = fake.tokens.find((t) => t.tokenHash === hashAuthToken(seeded.token));
    (row as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);
    const result = await verifyPOST(post("/auth/verify-email", { token: seeded.token }));
    expect(result.status).toBe(404);
    expect(fake.users[0].emailVerifiedAt).toBeNull();
  });

  it("already verified + fresh token → 409 CONFLICT", async () => {
    const seeded = await seedUser("conflict@x.co");
    await verifyPOST(post("/auth/verify-email", { token: seeded.token }));
    fake.tokens.push({
      id: "manual-3",
      userId: seeded.playerId,
      purpose: "EMAIL_VERIFICATION",
      tokenHash: hashAuthToken("another-valid-token"),
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
      createdAt: new Date(),
    });
    const result = await verifyPOST(post("/auth/verify-email", { token: "another-valid-token" }));
    expect(result.status).toBe(409);
    expect(((await result.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");
  });

  it("missing token → 400; cross Origin → 403", async () => {
    expect((await verifyPOST(post("/auth/verify-email", {}))).status).toBe(400);
    expect((await verifyPOST(post("/auth/verify-email", { token: "abc" }, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("verify rate: general class applies (60/min per IP)", async () => {
    const ip = nextIp();
    for (let i = 0; i < 60; i += 1) {
      expect((await verifyPOST(post("/auth/verify-email", { token: `tok-${i}` }, { ip }))).status).toBe(404);
    }
    expect((await verifyPOST(post("/auth/verify-email", { token: "tok-x" }, { ip }))).status).toBe(429);
  });
});

// ---------------------------------------------------- resend verification --

describe("POST /api/v1/auth/resend-verification", () => {
  it("unknown email → 202 with empty body (no enumeration)", async () => {
    const result = await resendPOST(post("/auth/resend-verification", { email: "ghost@x.co" }));
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual({});
  });

  it("known unverified → 202, new token supersedes, dev surfaces token, audited", async () => {
    const seeded = await seedUser("send@x.co");
    const result = await resendPOST(post("/auth/resend-verification", { email: "send@x.co" }));
    expect(result.status).toBe(202);
    const body = (await result.json()) as { devDelivery?: { token: string } };
    expect(body.devDelivery).toBeTruthy();
    expect(body.devDelivery?.token).not.toBe(seeded.token);
    // Prior outstanding token superseded (consumed):
    const firstRow = fake.tokens.find((t) => t.tokenHash === hashAuthToken(seeded.token));
    expect(firstRow?.consumedAt).toBeTruthy();
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.verification_resent");
  });

  it("already verified → 202 empty (nothing issued)", async () => {
    const seeded = await seedUser("done@x.co", { verified: true });
    const result = await resendPOST(post("/auth/resend-verification", { email: "done@x.co" }));
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual({});
  });

  it("unauthenticated without email → 400", async () => {
    expect((await resendPOST(post("/auth/resend-verification", {}))).status).toBe(400);
  });

  it("a live session supplies the identity (body email ignored)", async () => {
    const seeded = await seedUser("sess@x.co");
    const result = await resendPOST(
      post("/auth/resend-verification", { email: "somebody-else@x.co" }, { cookie: seeded.cookie }),
    );
    expect(result.status).toBe(202);
    const body = (await result.json()) as { devDelivery?: { token: string } };
    expect(body.devDelivery).toBeTruthy();
    // Token was minted for the SESSION user:
    const last = fake.tokens[fake.tokens.length - 1];
    expect(last.userId).toBe(seeded.playerId);
  });

  it("resend rate: 5/hour per email+IP", async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) {
      expect((await resendPOST(post("/auth/resend-verification", { email: "flood@x.co" }, { ip }))).status).toBe(202);
    }
    expect((await resendPOST(post("/auth/resend-verification", { email: "flood@x.co" }, { ip }))).status).toBe(429);
  });
});

// ---------------------------------------------------------- password flow --
// Password reset still works mechanically (it changes the stored hash and
// revokes sessions), but it is NOT a way in — login is retired. These tests
// assert the reset route's own behavior without relying on login.

describe("password forgot + reset", () => {
  it("forgot: unknown and known emails both 202 (no enumeration); known issues a 1h hashed token", async () => {
    const unknown = await forgotPOST(post("/auth/password/forgot", { email: "ghost@x.co" }));
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual({});

    await seedUser("resetme@x.co");
    const before = Date.now();
    const known = await forgotPOST(post("/auth/password/forgot", { email: "resetme@x.co" }));
    expect(known.status).toBe(202);
    const body = (await known.json()) as { devDelivery?: { purpose: string; token: string } };
    expect(body.devDelivery?.purpose).toBe("password_reset");
    expect(body.devDelivery?.token).toBeTruthy();

    const row = fake.tokens.find((t) => t.tokenHash === hashAuthToken(body.devDelivery?.token as string));
    expect(row).toBeTruthy();
    expect(row?.purpose).toBe("PASSWORD_RESET");
    expect(row?.tokenHash).not.toBe(body.devDelivery?.token);
    const ttl = (row?.expiresAt as Date).getTime() - before;
    expect(ttl).toBeGreaterThan(3_500_000); // ≈1h
    expect(ttl).toBeLessThan(3_660_000);
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.reset_requested");
  });

  it("forgot: missing email → 400; rate 5/hour per email+IP", async () => {
    expect((await forgotPOST(post("/auth/password/forgot", {}))).status).toBe(400);
    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) {
      expect((await forgotPOST(post("/auth/password/forgot", { email: "f@x.co" }, { ip }))).status).toBe(202);
    }
    expect((await forgotPOST(post("/auth/password/forgot", { email: "f@x.co" }, { ip }))).status).toBe(429);
  });

  it("reset: single-use token changes the hash and revokes ALL sessions", async () => {
    const seeded = await seedUser("changer@x.co");
    const before = String(fake.users[0].passwordHash);
    await forgotPOST(post("/auth/password/forgot", { email: "changer@x.co" }));
    const forgotBody = (await (await forgotPOST(post("/auth/password/forgot", { email: "changer@x.co" }))).json()) as {
      devDelivery?: { token: string };
    };
    const token = forgotBody.devDelivery?.token as string;

    const result = await resetPOST(post("/auth/password/reset", { token, password: "brand-new-passphrase" }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({});

    // All sessions (incl. the seeded one) revoked:
    for (const session of fake.sessions) expect(session.revokedAt).toBeTruthy();
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.password_reset");
    // The stored hash actually changed (login is retired, so verify directly):
    expect(String(fake.users[0].passwordHash)).not.toBe(before);

    // Token single-use: replay → 404.
    const replay = await resetPOST(post("/auth/password/reset", { token, password: "another-passphrase" }));
    expect(replay.status).toBe(404);
    expect(seeded.playerId).toBeTruthy();
  });

  it("reset: expired token → 404 and hash unchanged", async () => {
    await seedUser("keep@x.co");
    const before = String(fake.users[0].passwordHash);
    const forgotBody = (await (await forgotPOST(post("/auth/password/forgot", { email: "keep@x.co" }))).json()) as {
      devDelivery?: { token: string };
    };
    const token = forgotBody.devDelivery?.token as string;
    const row = fake.tokens.find((t) => t.tokenHash === hashAuthToken(token));
    (row as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);
    const result = await resetPOST(post("/auth/password/reset", { token, password: "brand-new-passphrase" }));
    expect(result.status).toBe(404);
    expect(String(fake.users[0].passwordHash)).toBe(before);
  });

  it("reset: weak password rejected by policy (400), token NOT consumed", async () => {
    await seedUser("weak@x.co");
    const forgotBody = (await (await forgotPOST(post("/auth/password/forgot", { email: "weak@x.co" }))).json()) as {
      devDelivery?: { token: string };
    };
    const token = forgotBody.devDelivery?.token as string;
    const result = await resetPOST(post("/auth/password/reset", { token, password: "password123" }));
    expect(result.status).toBe(400);
    const row = fake.tokens.find((t) => t.tokenHash === hashAuthToken(token));
    expect(row?.consumedAt).toBeNull(); // still usable after a policy rejection
    // and it still works with a good password:
    expect((await resetPOST(post("/auth/password/reset", { token, password: "acceptable-passphrase" }))).status).toBe(200);
  });

  it("reset: cross Origin → 403", async () => {
    const result = await resetPOST(
      post("/auth/password/reset", { token: "abc", password: VALID_PW }, { origin: "https://evil.example" }),
    );
    expect(result.status).toBe(403);
  });
});

// ------------------------------------------------- origin gate (all routes) --
describe("Origin gate across every auth mutation", () => {
  it("missing or cross-site Origin → 403 before any work happens", async () => {
    const mutations: Array<[string, unknown]> = [
      ["/auth/register", { email: "origin-loop@x.co", password: VALID_PW }],
      ["/auth/login", { email: "origin-loop@x.co", password: VALID_PW }],
      ["/auth/logout", undefined],
      ["/auth/verify-email", { token: "origin-loop-token" }],
      ["/auth/resend-verification", { email: "origin-loop@x.co" }],
      ["/auth/password/forgot", { email: "origin-loop@x.co" }],
      ["/auth/password/reset", { token: "origin-loop-token", password: VALID_PW }],
    ];
    const handlers: Record<string, (request: Request) => Promise<Response>> = {
      "/auth/register": registerPOST,
      "/auth/login": loginPOST,
      "/auth/logout": logoutPOST,
      "/auth/verify-email": verifyPOST,
      "/auth/resend-verification": resendPOST,
      "/auth/password/forgot": forgotPOST,
      "/auth/password/reset": resetPOST,
    };
    for (const [path, body] of mutations) {
      const handler = handlers[path] as (request: Request) => Promise<Response>;
      const missing = await handler(post(path, body, { origin: null }));
      expect([path, missing.status]).toEqual([path, 403]);
      const cross = await handler(post(path, body, { origin: "https://evil.example" }));
      expect([path, cross.status]).toEqual([path, 403]);
    }
    // The rejected attempts touched nothing:
    expect(fake.users).toHaveLength(0);
    expect(fake.sessions).toHaveLength(0);
    expect(fake.audits).toHaveLength(0);
  });
});

// ------------------------------------------------------- secrets hygiene --

describe("secrets never reach logs or responses", () => {
  it("passwords, hashes, and raw tokens stay out of console output", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
    ];
    try {
      const PASSWORD = "my-unique-secret-passphrase";
      // A password attempt is refused; a forgot/verify still must not leak.
      await loginPOST(post("/auth/login", { email: "hygiene@x.co", password: PASSWORD }));
      await registerPOST(post("/auth/register", { email: "hygiene@x.co", password: PASSWORD }));
      await forgotPOST(post("/auth/password/forgot", { email: "hygiene@x.co" }));
      await verifyPOST(post("/auth/verify-email", { token: "wrong-token-x" }));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const all = lines.join("\n");
    expect(all).not.toContain("my-unique-secret-passphrase");
    expect(all).not.toContain("wrong-token-x");
    expect(fake.users).toHaveLength(0); // refusal minted nothing
  });
});
