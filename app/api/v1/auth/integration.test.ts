/**
 * Phase B4 — LIVE database integration suite.
 *
 * MOCKED vs LIVE: unlike routes.test.ts / me.test.ts (in-memory fake), this
 * file runs the real route handlers against the real mailxp_dev PostgreSQL
 * database through the real Prisma client — real SQL, unique constraints,
 * and interactive transactions. It PROVES contract flows end-to-end at the
 * storage layer.
 *
 * Self-skip: when the database is unreachable (or .env is absent) the suite
 * reports as skipped — it never silently passes.
 *
 * Cleanup: every user created here carries a unique run tag and is deleted
 * in afterAll (audit rows first, then users; sessions/tokens/profiles follow
 * via FK cascade). B7 adds worker processing: deletion-requested accounts may
 * be physically erased at any moment, so the DELETE flow accepts marker-set
 * OR erased, and afterAll also removes the worker's outbox/job rows plus the
 * tombstoned deletion audits left behind. No destructive database commands
 * are used.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/server/prisma";
import { hashPassword } from "@/lib/server/password";
import { hashSessionToken } from "@/lib/server/session";
import { generateAuthToken, hashAuthToken } from "@/lib/server/tokens";
import { POST as loginPOST } from "./login/route";
import { POST as logoutPOST } from "./logout/route";
import { POST as forgotPOST } from "./password/forgot/route";
import { POST as resetPOST } from "./password/reset/route";
import { POST as registerPOST } from "./register/route";
import { POST as resendPOST } from "./resend-verification/route";
import { POST as verifyPOST } from "./verify-email/route";
import { GET as meGET, DELETE as meDELETE } from "../me/route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;
const VALID_PW = "integration-grade-passphrase";
const NEW_PW = "brand-new-integration-pass";

const DB_UP = await (async () => {
  try {
    await getDb().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

const RUN_TAG = `b4-live-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
let ipSeq = 0;

// B7: DELETE /me now schedules physical erasure through the in-process
// worker, which may commit at ANY moment after the 202 — including between
// this suite's queries and before afterAll runs. Track the suite's deletions
// (user id + the 202's X-Request-Id) so assertions can accept either state
// and cleanup can remove the worker's job/outbox rows plus tombstoned audits.
const suiteDeletions: Array<{ userId: string; requestId: string }> = [];
const suiteStartedAt = new Date();

function nextIp(): string {
  ipSeq += 1;
  return `192.0.2.${ipSeq % 254 || 1}`; // unique per call so the in-process limiter never interferes
}

function mail(local: string): string {
  return `${RUN_TAG}-${local}@example.test`;
}

function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { body?: unknown; cookie?: string; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = { "x-forwarded-for": nextIp() };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    headers,
  });
}

function cookieFor(response: Response): string {
  const match = /mailxp\.session=([^;]+)/i.exec(response.headers.get("set-cookie") ?? "");
  expect(match).toBeTruthy();
  return `mailxp.session=${match?.[1]}`;
}

/**
 * Seed a user + profile + session + verification token DIRECTLY against the
 * real DB (the password register route is retired under Google-only). The
 * DELETE route re-auths against the stored hash, so we store a real bcrypt
 * hash of VALID_PW. Returns a session cookie + a raw verification token.
 */
async function register(email: string): Promise<{ cookie: string; token: string; playerId: string }> {
  const db = getDb();
  const passwordHash = await hashPassword(VALID_PW);
  const user = await db.user.create({ data: { email, passwordHash } });
  const raw = `live-seed-${email}-${Math.random().toString(36).slice(2)}`;
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(raw),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 1e9),
    },
  });
  const token = generateAuthToken();
  await db.authToken.create({
    data: {
      userId: user.id,
      purpose: "EMAIL_VERIFICATION",
      tokenHash: hashAuthToken(token),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { cookie: `mailxp.session=${raw}`, token, playerId: user.id };
}

afterAll(async () => {
  if (!DB_UP) return;
  const db = getDb();
  const users = await db.user.findMany({ where: { email: { contains: RUN_TAG } }, select: { id: true } });
  const survivingIds = users.map((u) => u.id);
  const suiteIds = [...new Set([...survivingIds, ...suiteDeletions.map((d) => d.userId)])];
  if (suiteIds.length > 0) {
    // B7 worker artifacts for this suite's accounts. Order matters: kill the
    // outbox events FIRST (so a concurrent relay tick cannot create a new
    // job), then the job rows themselves.
    for (const id of suiteIds) {
      await db.outboxEvent.deleteMany({ where: { payload: { equals: { userId: id } } } });
    }
    await db.job.deleteMany({
      where: { dedupeKey: { in: suiteIds.map((id) => `account.deletion:${id}`) } },
    });
  }
  if (suiteDeletions.length > 0) {
    // Tombstoned audits left by erasure: null userId + suite window + deletion
    // event types (safe: live users keep their userId, and the account owner
    // has not deleted their own account).
    await db.auditEvent.deleteMany({
      where: {
        userId: null,
        createdAt: { gte: suiteStartedAt },
        eventType: { in: ["auth.deletion_requested", "auth.account_erased"] },
      },
    });
  }
  if (survivingIds.length > 0) {
    await db.auditEvent.deleteMany({ where: { userId: { in: survivingIds } } }); // SetNull FK: clear first
    await db.user.deleteMany({ where: { id: { in: survivingIds } } }); // cascades sessions/tokens/profile
  }
});

describe.runIf(DB_UP)("live DB integration (mailxp_dev)", () => {
  it("register is retired (Google-only): 403 refusal writes NO real rows", async () => {
    const email = mail("reg");
    const response = await registerPOST(call("POST", "/auth/register", { body: { email, password: VALID_PW } }));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("GOOGLE_SIGNIN_REQUIRED");

    // Nothing was minted against the real store.
    const db = getDb();
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });

  it("login is retired (Google-only): 403 refusal even for a REAL seeded account", async () => {
    const email = mail("dup");
    const seeded = await register(email);
    const response = await loginPOST(call("POST", "/auth/login", { body: { email, password: VALID_PW } }));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("GOOGLE_SIGNIN_REQUIRED");
    expect(seeded.playerId).toBeTruthy();
  });

  it("a seeded session reads /me and logout revokes it for real", async () => {
    const email = mail("cycle");
    const seeded = await register(email);

    const me1 = await meGET(call("GET", "/me", { cookie: seeded.cookie }));
    expect(me1.status).toBe(200);
    const player = ((await me1.json()) as { player: Record<string, unknown> }).player;
    expect(Object.keys(player).sort()).toEqual(["createdAt", "email", "emailVerified", "id"]);

    const logout = await logoutPOST(call("POST", "/auth/logout", { cookie: seeded.cookie }));
    expect(logout.status).toBe(204);

    const me2 = await meGET(call("GET", "/me", { cookie: seeded.cookie }));
    expect(me2.status).toBe(401);
    expect(((await me2.json()) as { error: { code: string } }).error.code).toBe("SESSION_EXPIRED");
  });

  it("verification end-to-end: dev token → verify → replay dead; resend always 202", async () => {
    const email = mail("verify");
    const created = await register(email);

    const verify = await verifyPOST(call("POST", "/auth/verify-email", { body: { token: created.token } }));
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ player: { emailVerified: true } });

    const db = getDb();
    const user = await db.user.findUnique({ where: { email } });
    expect(user?.emailVerifiedAt).toBeTruthy();

    const replay = await verifyPOST(call("POST", "/auth/verify-email", { body: { token: created.token } }));
    expect(replay.status).toBe(404);

    // Known-but-verified and unknown emails → 202, empty body, real rows untouched.
    const resendKnown = await resendPOST(call("POST", "/auth/resend-verification", { body: { email } }));
    expect(resendKnown.status).toBe(202);
    expect(await resendKnown.json()).toEqual({});
    const resendUnknown = await resendPOST(call("POST", "/auth/resend-verification", { body: { email: mail("nope") } }));
    expect(resendUnknown.status).toBe(202);
    expect(await resendUnknown.json()).toEqual({});
  });

  it("forgot → reset: real password change, ALL sessions revoked, single-use token", async () => {
    const email = mail("reset");
    await register(email); // creates session A

    const forgot1 = await forgotPOST(call("POST", "/auth/password/forgot", { body: { email } }));
    expect(forgot1.status).toBe(202);
    const first = (await forgot1.json()) as { devDelivery?: { token: string; purpose: string } };
    expect(first.devDelivery?.purpose).toBe("password_reset");

    const forgot2 = await forgotPOST(call("POST", "/auth/password/forgot", { body: { email } }));
    const second = (await forgot2.json()) as { devDelivery?: { token: string } };
    expect(second.devDelivery?.token).toBeTruthy();
    expect(second.devDelivery?.token).not.toBe(first.devDelivery?.token); // supersedes prior
    const token = second.devDelivery?.token as string;

    const reset = await resetPOST(call("POST", "/auth/password/reset", { body: { token, password: NEW_PW } }));
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({});

    const db = getDb();
    const user = await db.user.findUnique({ where: { email } });
    expect(user?.passwordHash).not.toContain(NEW_PW);
    const sessions = await db.session.findMany({ where: { userId: user?.id } });
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) expect(session.revokedAt).toBeTruthy();

    // Login is retired — even a valid password can never enter (Google-only).
    expect((await loginPOST(call("POST", "/auth/login", { body: { email, password: NEW_PW } }))).status).toBe(403);

    // Single-use: replay → 404.
    expect((await resetPOST(call("POST", "/auth/password/reset", { body: { token, password: "another-good-pass" } }))).status).toBe(404);
  });

  it("login is uniformly refused against the real store (retired — Google-only)", async () => {
    const email = mail("uniform");
    await register(email);
    const known = await loginPOST(call("POST", "/auth/login", { body: { email, password: VALID_PW } }));
    const ghost = await loginPOST(call("POST", "/auth/login", { body: { email: mail("ghost"), password: "wrong-password-x" } }));
    expect(known.status).toBe(403);
    expect(ghost.status).toBe(403);
    expect(((await known.json()) as { error: { code: string } }).error.code).toBe("GOOGLE_SIGNIN_REQUIRED");
  });

  it("DELETE /me: real re-auth → 202, marker set, sessions revoked, retry 401, login blocked", async () => {
    const email = mail("delete");
    const created = await register(email);

    const wrongPw = await meDELETE(call("DELETE", "/me", { cookie: created.cookie, body: { password: "wrong-password-x" } }));
    expect(wrongPw.status).toBe(401);

    const deleted = await meDELETE(call("DELETE", "/me", { cookie: created.cookie, body: { password: VALID_PW } }));
    expect(deleted.status).toBe(202);
    expect(await deleted.json()).toEqual({});
    suiteDeletions.push({ userId: created.playerId, requestId: deleted.headers.get("x-request-id") ?? "" });

    const db = getDb();
    const user = await db.user.findUnique({ where: { email } });
    // B7: the worker may erase the account between the 202 and this query —
    // accept EITHER marker-set or fully-erased, never an inconsistent middle.
    expect(user === null || user.deletionRequestedAt !== null).toBe(true);
    // Query by the id captured at registration (survives erasure; `user?.id`
    // would be undefined after erasure and Prisma would drop the filter).
    const sessions = await db.session.findMany({ where: { userId: created.playerId } });
    for (const session of sessions) expect(session.revokedAt).toBeTruthy();

    // Login is retired — a password can never enter (Google-only), whatever
    // the account state.
    expect((await loginPOST(call("POST", "/auth/login", { body: { email, password: VALID_PW } }))).status).toBe(403);
    // …retry of the delete is safe (session dead → 401, no duplicate work)…
    const retry = await meDELETE(call("DELETE", "/me", { cookie: created.cookie, body: { password: VALID_PW } }));
    expect(retry.status).toBe(401);
    // …and exactly one audit row exists, correlated by the 202's requestId
    // (the row survives as a tombstone even if the worker already erased).
    const audits = await db.auditEvent.findMany({
      where: { requestId: deleted.headers.get("x-request-id") ?? "", eventType: "auth.deletion_requested" },
    });
    expect(audits).toHaveLength(1);
  });

  it("Origin rejection applies to the real handlers too", async () => {
    const email = mail("origin");
    const created = await register(email);
    const cross = await logoutPOST(call("POST", "/auth/logout", { cookie: created.cookie, origin: "https://evil.example" }));
    expect(cross.status).toBe(403);
    const sessions = await getDb().session.findMany({ where: { userId: created.playerId } });
    for (const session of sessions) expect(session.revokedAt).toBeNull(); // untouched
  });
});
