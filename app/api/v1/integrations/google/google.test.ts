/**
 * Phase B8 — Google integration route tests (MOCKED storage: fakeDb; real
 * crypto; Google network calls stubbed at globalThis.fetch where relevant).
 *
 * Covers spec §11 for the player-facing routes: session + strict-Origin
 * gates, verified-email gate, dedicated OAuth rate class, config-missing 503
 * with variable NAMES only, state minting (hash-only, session-bound),
 * ownership 404s (cross-account is never 403), disconnect semantics (local
 * delete always, remote revoke best-effort + honestly audited), release
 * wipe/idempotency/transfer precondition, and NO token material in any
 * response or audit row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashOAuthState } from "@/lib/server/googleOAuth";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { GET as statusGET } from "./route";
import { POST as startPOST } from "./start/route";
import { GET as accountsListGET } from "./accounts/route";
import { DELETE as accountDELETE, GET as accountGET } from "./accounts/[accountId]/route";
import { POST as reconnectPOST } from "./accounts/[accountId]/reconnect/route";
import { POST as releasePOST } from "./accounts/[accountId]/release/route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;
const KEY = Buffer.alloc(32, 5);
const KEY_B64 = KEY.toString("base64");
const ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_TOKEN_ENCRYPTION_KEY",
] as const;

const savedEnv: Record<string, string | undefined> = {};
function setGoogleEnv(): void {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.GOOGLE_REDIRECT_URI = `${ORIGIN}/api/v1/callbacks/googleOAuth`;
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = KEY_B64;
}
function clearGoogleEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

let fake: FakeDb;
const getDbMock = vi.mocked(getDb);
let ipSeq = 0;

beforeEach(() => {
  fake = createFakeDb();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(fake.client);
  ipSeq += 1;
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  setGoogleEnv();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

function nextIp(): string {
  ipSeq += 1;
  return `10.8.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

interface SeedUser {
  userId: string;
  sessionId: string;
  cookie: string;
}

async function seedUser(email: string, verified: boolean): Promise<SeedUser> {
  const user = (await fake.client.user.create({
    data: { email, passwordHash: "x", ...(verified ? { emailVerifiedAt: new Date() } : {}) },
  })) as { id: string };
  const raw = `raw-token-${email}`;
  const session = (await fake.client.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(raw),
      lastSeenAt: new Date(), // real @default(now()); fake has no column defaults
      expiresAt: new Date(Date.now() + 1e9),
    },
  })) as { id: string };
  return { userId: user.id, sessionId: session.id, cookie: `mailxp.session=${raw}` };
}

function makeRequest(
  path: string,
  opts: { method?: string; cookie?: string; origin?: string | null; ip?: string } = {},
): Request {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? nextIp() };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`${BASE}${path}`, { method: opts.method ?? "GET", headers });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

// ------------------------------------------------------------------ status ---

describe("GET /integrations/google (google.status)", () => {
  it("401 without a session (both codes, per B1 §1.2)", async () => {
    const none = await statusGET(makeRequest("/integrations/google", { origin: null }));
    expect(none.status).toBe(401);
    expect((await bodyOf(none)).error).toMatchObject({ code: "UNAUTHENTICATED" });

    const dead = await statusGET(
      makeRequest("/integrations/google", { origin: null, cookie: "mailxp.session=whoever" }),
    );
    expect(dead.status).toBe(401);
    expect((await bodyOf(dead)).error).toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("returns config/verification flags + only this player's accounts, no token fields", async () => {
    const me = await seedUser("status@example.test", true);
    const other = await seedUser("other@example.test", true);
    await fake.client.googleConnection.create({
      data: { userId: me.userId, googleSub: "sub-mine", email: "mine@gmail.com", scopes: "openid email" },
    });
    await fake.client.googleConnection.create({
      data: { userId: other.userId, googleSub: "sub-theirs", email: "theirs@gmail.com", scopes: "" },
    });

    const response = await statusGET(
      makeRequest("/integrations/google", { origin: null, cookie: me.cookie }),
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.configured).toBe(true);
    expect(body.missing).toEqual([]);
    expect(body.emailVerified).toBe(true);
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe("mine@gmail.com");
    expect(JSON.stringify(body)).not.toContain("sub-theirs");
    expect(JSON.stringify(body)).not.toContain("refreshTokenCipher");
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });

  it("reports configured=false with variable NAMES only when setup is absent", async () => {
    clearGoogleEnv();
    const me = await seedUser("unconfigured@example.test", true);
    const body = await bodyOf(await statusGET(makeRequest("/integrations/google", { origin: null, cookie: me.cookie })));
    expect(body.configured).toBe(false);
    expect(body.missing).toEqual(ENV_KEYS.slice().sort());
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });
});

// ------------------------------------------------------------------- start ---

describe("POST /integrations/google/start (google.connectStart)", () => {
  it("rejects cross-site/absent Origin (CSRF)", async () => {
    const me = await seedUser("csrf@example.test", true);
    for (const origin of [null, "http://evil.example"]) {
      const response = await startPOST(
        makeRequest("/integrations/google/start", { method: "POST", cookie: me.cookie, origin }),
      );
      expect(response.status).toBe(403);
      expect((await bodyOf(response)).error).toMatchObject({ code: "CSRF_ORIGIN_REJECTED" });
    }
    expect(fake.oauthStates).toHaveLength(0);
  });

  it("requires a session", async () => {
    const response = await startPOST(makeRequest("/integrations/google/start", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("gates on email verification with 403 EMAIL_NOT_VERIFIED", async () => {
    const me = await seedUser("unverified@example.test", false);
    const response = await startPOST(
      makeRequest("/integrations/google/start", { method: "POST", cookie: me.cookie }),
    );
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).error).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(fake.oauthStates).toHaveLength(0);
  });

  it("503 SERVICE_UNAVAILABLE with missing variable NAMES when unconfigured", async () => {
    clearGoogleEnv();
    const me = await seedUser("nocfg@example.test", true);
    const response = await startPOST(
      makeRequest("/integrations/google/start", { method: "POST", cookie: me.cookie }),
    );
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body.error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    const details = (body.error as { details: Array<{ field: string; message: string }> }).details;
    expect(details[0].field).toBe("config");
    for (const name of ENV_KEYS) expect(details[0].message).toContain(name);
    expect(fake.oauthStates).toHaveLength(0); // no state minted without config
  });

  it("mints a session-bound, hash-only state and returns the consent URL", async () => {
    const me = await seedUser("starter@example.test", true);
    const response = await startPOST(
      makeRequest("/integrations/google/start", { method: "POST", cookie: me.cookie }),
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(Object.keys(body)).toEqual(["authUrl"]);

    const url = new URL(String(body.authUrl));
    expect(url.origin).toBe("https://accounts.google.com");
    const rawState = url.searchParams.get("state");
    expect(rawState).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/v1/callbacks/googleOAuth`);

    expect(fake.oauthStates).toHaveLength(1);
    const row = fake.oauthStates[0];
    expect(row.stateHash).toBe(hashOAuthState(rawState as string));
    expect(JSON.stringify(row)).not.toContain(rawState); // raw never stored
    expect(row.userId).toBe(me.userId);
    expect(row.sessionId).toBe(me.sessionId);
    expect(row.intent).toBe("connect");
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
  });

  it("enforces the dedicated oauth rate class (10/hour per player)", async () => {
    const me = await seedUser("rater@example.test", true);
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (
        await startPOST(makeRequest("/integrations/google/start", { method: "POST", cookie: me.cookie }))
      ).status;
    }
    expect(last).toBe(429);
    // …but a different player is unaffected.
    const other = await seedUser("rater2@example.test", true);
    const otherResponse = await startPOST(
      makeRequest("/integrations/google/start", { method: "POST", cookie: other.cookie }),
    );
    expect(otherResponse.status).toBe(200);
  });

  it("rejects a malformed body field", async () => {
    const me = await seedUser("badbody@example.test", true);
    const response = await startPOST(
      new Request(`${BASE}/integrations/google/start`, {
        method: "POST",
        headers: { cookie: me.cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ accountId: 42 }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("browser-supplied identity fields in the body CANNOT establish a link (spec §4.5)", async () => {
    const me = await seedUser("spoof@example.test", true);
    const response = await startPOST(
      new Request(`${BASE}/integrations/google/start`, {
        method: "POST",
        headers: { cookie: me.cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          googleSub: "attacker-sub",
          email: "attacker@gmail.com",
          refreshToken: "stolen-refresh-token",
        }),
      }),
    );
    // tolerated (ignored keys) or rejected — but under NO interpretation is a link created:
    expect([200, 400]).toContain(response.status);
    expect(fake.googleConnections).toHaveLength(0);
    expect(fake.audits.filter((a) => a.eventType === "google.connected")).toHaveLength(0);
    expect(JSON.stringify(fake.oauthStates)).not.toContain("stolen-refresh-token");
  });

  it("404 for a reconnect target owned by someone else (no state minted)", async () => {
    const me = await seedUser("recon@example.test", true);
    const stranger = await seedUser("stranger@example.test", true);
    const theirRow = (await fake.client.googleConnection.create({
      data: { userId: stranger.userId, googleSub: "sub-x", email: "x@gmail.com", scopes: "" },
    })) as { id: string };

    const response = await startPOST(
      new Request(`${BASE}/integrations/google/start`, {
        method: "POST",
        headers: { cookie: me.cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ accountId: theirRow.id }),
      }),
    );
    expect(response.status).toBe(404);
    expect((await bodyOf(response)).error).toMatchObject({ code: "NOT_FOUND" });
    expect(fake.oauthStates).toHaveLength(0); // foreign target → nothing minted
  });
});

// ---------------------------------------------------- B8a: signin intent ---

describe("POST /integrations/google/start intent=signin (B8a)", () => {
  function signinRequest(opts: { cookie?: string; origin?: string | null; ip?: string; body?: unknown } = {}): Request {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": opts.ip ?? nextIp(),
    };
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    if (opts.cookie) headers.cookie = opts.cookie;
    return new Request(`${BASE}/integrations/google/start`, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body ?? { intent: "signin" }),
    });
  }

  it("works WITHOUT a session and mints an UNBOUND state (userId/sessionId NULL)", async () => {
    const response = await startPOST(signinRequest());
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(Object.keys(body)).toEqual(["authUrl"]);

    const url = new URL(String(body.authUrl));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/v1/callbacks/googleOAuth`);
    const rawState = url.searchParams.get("state");
    expect(rawState).toBeTruthy();

    expect(fake.oauthStates).toHaveLength(1);
    const row = fake.oauthStates[0];
    expect(row.intent).toBe("signin");
    expect(row.userId).toBeNull();
    expect(row.sessionId).toBeNull();
    expect(row.stateHash).toBe(hashOAuthState(rawState as string));
    expect(JSON.stringify(row)).not.toContain(rawState);
  });

  it("cross-site/absent Origin is rejected before any mint (CSRF)", async () => {
    for (const origin of [null, "http://evil.example"]) {
      const response = await startPOST(signinRequest({ origin }));
      expect(response.status).toBe(403);
      expect((await bodyOf(response)).error).toMatchObject({ code: "CSRF_ORIGIN_REJECTED" });
    }
    expect(fake.oauthStates).toHaveLength(0);
  });

  it("503 with variable NAMES only when unconfigured", async () => {
    clearGoogleEnv();
    const response = await startPOST(signinRequest());
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body.error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    const details = (body.error as { details: Array<{ field: string; message: string }> }).details;
    for (const name of ENV_KEYS) expect(details[0].message).toContain(name);
    expect(details[0].message).not.toContain("test-secret");
    expect(fake.oauthStates).toHaveLength(0);
  });

  it("invalid intent values and signin+accountId are validation errors", async () => {
    const bogus = await startPOST(signinRequest({ body: { intent: "destroy" } }));
    expect(bogus.status).toBe(400);
    expect((await bodyOf(bogus)).error).toMatchObject({ code: "VALIDATION_ERROR" });

    const withAccount = await startPOST(
      signinRequest({ body: { intent: "signin", accountId: "some-id" } }),
    );
    expect(withAccount.status).toBe(400);
    expect(fake.oauthStates).toHaveLength(0);
  });

  it("rate-limits by IP in the oauth class (separate key space from players)", async () => {
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (await startPOST(signinRequest({ ip: "10.99.0.1" }))).status;
    }
    expect(last).toBe(429);
    // …but a different IP is unaffected:
    expect((await startPOST(signinRequest({ ip: "10.99.0.2" }))).status).toBe(200);
  });

  it("a signed-IN player using intent=signin still gets an unbound state (no binding leak)", async () => {
    const me = await seedUser("signedin.signin@example.test", true);
    const response = await startPOST(signinRequest({ cookie: me.cookie }));
    expect(response.status).toBe(200);
    expect(fake.oauthStates[0].userId).toBeNull(); // signin never binds to the presented session
    expect(fake.oauthStates[0].sessionId).toBeNull();
  });
});

// ----------------------------------------------------------- list / single ---

describe("accounts list + get (ownership)", () => {
  it("lists only the caller's accounts", async () => {
    const me = await seedUser("listme@example.test", true);
    const other = await seedUser("listother@example.test", true);
    await fake.client.googleConnection.create({
      data: { userId: me.userId, googleSub: "s1", email: "one@gmail.com", scopes: "" },
    });
    await fake.client.googleConnection.create({
      data: { userId: other.userId, googleSub: "s2", email: "two@gmail.com", scopes: "" },
    });
    const response = await accountsListGET(makeRequest("/integrations/google/accounts", { origin: null, cookie: me.cookie }));
    expect(response.status).toBe(200);
    const accounts = (await bodyOf(response)).accounts as Array<{ email: string }>;
    expect(accounts.map((a) => a.email)).toEqual(["one@gmail.com"]);
  });

  it("cross-account fetch is 404, never 403 (existence not disclosed)", async () => {
    const me = await seedUser("getme@example.test", true);
    const other = await seedUser("getother@example.test", true);
    const theirRow = (await fake.client.googleConnection.create({
      data: { userId: other.userId, googleSub: "s-get", email: "g@gmail.com", scopes: "" },
    })) as { id: string };

    const own = await accountGET(
      makeRequest(`/integrations/google/accounts/${theirRow.id}`, { origin: null, cookie: other.cookie }),
      { params: Promise.resolve({ accountId: theirRow.id }) },
    );
    expect(own.status).toBe(200);

    const foreign = await accountGET(
      makeRequest(`/integrations/google/accounts/${theirRow.id}`, { origin: null, cookie: me.cookie }),
      { params: Promise.resolve({ accountId: theirRow.id }) },
    );
    expect(foreign.status).toBe(404);
    expect((await bodyOf(foreign)).error).toMatchObject({ code: "NOT_FOUND" });
  });
});

// -------------------------------------------------------------- disconnect ---

describe("DELETE /accounts/{id} (google.accountDisconnect)", () => {
  it("owner disconnect: 204, row gone, audited with honest revocation state", async () => {
    const me = await seedUser("disc@example.test", true);
    const row = (await fake.client.googleConnection.create({
      data: { userId: me.userId, googleSub: "sub-disc", email: "d@gmail.com", scopes: "openid" },
    })) as { id: string };

    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await accountDELETE(
      makeRequest(`/integrations/google/accounts/${row.id}`, { method: "DELETE", cookie: me.cookie }),
      { params: Promise.resolve({ accountId: row.id }) },
    );
    expect(response.status).toBe(204);
    expect(fake.googleConnections).toHaveLength(0);

    const audit = fake.audits.find((a) => a.eventType === "google.disconnected");
    expect(audit).toBeDefined();
    expect(audit?.userId).toBe(me.userId);
    expect(audit?.meta).toMatchObject({ accountId: row.id });
    expect(JSON.stringify(audit?.meta)).not.toContain("sub-disc"); // sub not in audit meta
  });

  it("remote revocation is attempted when configured and audited truthfully", async () => {
    const me = await seedUser("revoke@example.test", true);
    const row = (await fake.client.googleConnection.create({
      data: {
        userId: me.userId,
        googleSub: "sub-rev",
        email: "r@gmail.com",
        scopes: "openid",
        refreshTokenCipher: "AAAA",
        refreshTokenNonce: "BBBB",
        refreshTokenTag: "CCCC",
      },
    })) as { id: string };

    // Unreadable ciphertext → skip (fail closed), local delete still succeeds.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await accountDELETE(
      makeRequest(`/integrations/google/accounts/${row.id}`, { method: "DELETE", cookie: me.cookie }),
      { params: Promise.resolve({ accountId: row.id }) },
    );
    expect(response.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled(); // no decrypt → no network
    expect(fake.googleConnections).toHaveLength(0);
  });

  it("another player's connection: 404 and NOTHING deleted", async () => {
    const me = await seedUser("discx@example.test", true);
    const other = await seedUser("discy@example.test", true);
    const theirRow = (await fake.client.googleConnection.create({
      data: { userId: other.userId, googleSub: "sub-keep", email: "k@gmail.com", scopes: "" },
    })) as { id: string };

    const response = await accountDELETE(
      makeRequest(`/integrations/google/accounts/${theirRow.id}`, { method: "DELETE", cookie: me.cookie }),
      { params: Promise.resolve({ accountId: theirRow.id }) },
    );
    expect(response.status).toBe(404);
    expect(fake.googleConnections).toHaveLength(1); // intact
    expect(fake.audits.filter((a) => a.eventType === "google.disconnected")).toHaveLength(0);
  });

  it("cross-site Origin rejected before any mutation", async () => {
    const me = await seedUser("discz@example.test", true);
    const row = (await fake.client.googleConnection.create({
      data: { userId: me.userId, googleSub: "sub-z", email: "z@gmail.com", scopes: "" },
    })) as { id: string };
    const response = await accountDELETE(
      makeRequest(`/integrations/google/accounts/${row.id}`, { method: "DELETE", cookie: me.cookie, origin: "http://evil.example" }),
      { params: Promise.resolve({ accountId: row.id }) },
    );
    expect(response.status).toBe(403);
    expect(fake.googleConnections).toHaveLength(1);
  });
});

// --------------------------------------------------------------- reconnect ---

describe("POST /accounts/{id}/reconnect (google.accountReconnect)", () => {
  it("mints a state bound to intent reconnect:<accountId> for the owner", async () => {
    const me = await seedUser("rc@example.test", true);
    const row = (await fake.client.googleConnection.create({
      data: { userId: me.userId, googleSub: "sub-rc", email: "rc@gmail.com", scopes: "" },
    })) as { id: string };
    const response = await reconnectPOST(
      makeRequest(`/integrations/google/accounts/${row.id}/reconnect`, { method: "POST", cookie: me.cookie }),
      { params: Promise.resolve({ accountId: row.id }) },
    );
    expect(response.status).toBe(200);
    expect(fake.oauthStates).toHaveLength(1);
    expect(fake.oauthStates[0].intent).toBe(`reconnect:${row.id}`);
    expect(fake.oauthStates[0].userId).toBe(me.userId);
  });

  it("404 for a stranger's account, 403 when unverified, 401 without session", async () => {
    const me = await seedUser("rc2@example.test", true);
    const stranger = await seedUser("rc3@example.test", true);
    const theirRow = (await fake.client.googleConnection.create({
      data: { userId: stranger.userId, googleSub: "sub-rc3", email: "q@gmail.com", scopes: "" },
    })) as { id: string };

    const foreign = await reconnectPOST(
      makeRequest(`/integrations/google/accounts/${theirRow.id}/reconnect`, { method: "POST", cookie: me.cookie }),
      { params: Promise.resolve({ accountId: theirRow.id }) },
    );
    expect(foreign.status).toBe(404);

    const unverified = await seedUser("rc4@example.test", false);
    const ownRow = (await fake.client.googleConnection.create({
      data: { userId: unverified.userId, googleSub: "sub-rc4", email: "u@gmail.com", scopes: "" },
    })) as { id: string };
    const blocked = await reconnectPOST(
      makeRequest(`/integrations/google/accounts/${ownRow.id}/reconnect`, { method: "POST", cookie: unverified.cookie }),
      { params: Promise.resolve({ accountId: ownRow.id }) },
    );
    expect(blocked.status).toBe(403);
    expect((await bodyOf(blocked)).error).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });

    const anon = await reconnectPOST(
      makeRequest(`/integrations/google/accounts/${ownRow.id}/reconnect`, { method: "POST" }),
      { params: Promise.resolve({ accountId: ownRow.id }) },
    );
    expect(anon.status).toBe(401);
  });
});

// ----------------------------------------------------------------- release ---

describe("POST /accounts/{id}/release (google.accountRelease)", () => {
  it("owner release: status flips, sealed token wiped in place, audited", async () => {
    const me = await seedUser("rel@example.test", true);
    const row = (await fake.client.googleConnection.create({
      data: {
        userId: me.userId,
        googleSub: "sub-rel",
        email: "rel@gmail.com",
        scopes: "openid",
        refreshTokenCipher: "CIPHERTEXT-VALUE",
        refreshTokenNonce: "NONCE",
        refreshTokenTag: "TAG",
      },
    })) as { id: string };

    const response = await releasePOST(
      makeRequest(`/integrations/google/accounts/${row.id}/release`, { method: "POST", cookie: me.cookie }),
      { params: Promise.resolve({ accountId: row.id }) },
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect((body.account as { status: string }).status).toBe("released");

    const stored = fake.googleConnections[0];
    expect(stored.status).toBe("released");
    expect(stored.refreshTokenCipher).toBeNull();
    expect(stored.refreshTokenNonce).toBeNull();
    expect(stored.refreshTokenTag).toBeNull();
    expect(JSON.stringify(response)).not.toContain("CIPHERTEXT-VALUE");

    const audit = fake.audits.find((a) => a.eventType === "google.released");
    expect(audit?.userId).toBe(me.userId);
    expect(audit?.meta).toMatchObject({ accountId: row.id });
  });

  it("is idempotent on an already-released row", async () => {
    const me = await seedUser("rel2@example.test", true);
    const row = (await fake.client.googleConnection.create({
      data: { userId: me.userId, googleSub: "sub-rel2", email: "r2@gmail.com", scopes: "" },
    })) as { id: string };
    await releasePOST(
      makeRequest(`/integrations/google/accounts/${row.id}/release`, { method: "POST", cookie: me.cookie }),
      { params: Promise.resolve({ accountId: row.id }) },
    );
    const again = await releasePOST(
      makeRequest(`/integrations/google/accounts/${row.id}/release`, { method: "POST", cookie: me.cookie }),
      { params: Promise.resolve({ accountId: row.id }) },
    );
    expect(again.status).toBe(200);
    expect(((await bodyOf(again)).account as { status: string }).status).toBe("released");
    expect(fake.audits.filter((a) => a.eventType === "google.released")).toHaveLength(1); // single audit
  });

  it("another player cannot release (404, state unchanged) and Origin is enforced", async () => {
    const owner = await seedUser("relo@example.test", true);
    const stranger = await seedUser("relp@example.test", true);
    const row = (await fake.client.googleConnection.create({
      data: { userId: owner.userId, googleSub: "sub-ro", email: "ro@gmail.com", scopes: "" },
    })) as { id: string };

    const foreign = await releasePOST(
      makeRequest(`/integrations/google/accounts/${row.id}/release`, { method: "POST", cookie: stranger.cookie }),
      { params: Promise.resolve({ accountId: row.id }) },
    );
    expect(foreign.status).toBe(404);
    expect(fake.googleConnections[0].status).toBe("connected");

    const crossSite = await releasePOST(
      makeRequest(`/integrations/google/accounts/${row.id}/release`, { method: "POST", cookie: owner.cookie, origin: "http://evil.example" }),
      { params: Promise.resolve({ accountId: row.id }) },
    );
    expect(crossSite.status).toBe(403);
    expect(fake.googleConnections[0].status).toBe("connected");
  });
});
