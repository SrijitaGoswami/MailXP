/**
 * Phase B8 — provider callback tests (spec §4.4–§4.12, MOCKED storage +
 * stubbed Google fetch; never any real network).
 *
 * The callback is the security boundary of the flow: state must be validated
 * and consumed EXACTLY once before any code exchange, wrong-user states must
 * be refused WITHOUT being burned, every outcome is a redirect carrying only
 * a safe token (no code/state/tokens/email in Location), the session cookie
 * is never touched, linking policy (conflict vs released-transfer) decides,
 * and audits record what actually happened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { createOAuthState, hashOAuthState } from "@/lib/server/googleOAuth";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { GET as callbackGET } from "./route";

const ORIGIN = "http://localhost:3000";
const CALLBACK = `${ORIGIN}/api/v1/callbacks/googleOAuth`;
const KEY = Buffer.alloc(32, 6);
const KEY_B64 = KEY.toString("base64");
const ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_TOKEN_ENCRYPTION_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function setGoogleEnv(): void {
  process.env.GOOGLE_CLIENT_ID = "cb-client";
  process.env.GOOGLE_CLIENT_SECRET = "cb-secret";
  process.env.GOOGLE_REDIRECT_URI = CALLBACK;
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = KEY_B64;
}
function clearGoogleEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

let fake: FakeDb;
const getDbMock = vi.mocked(getDb);

beforeEach(() => {
  fake = createFakeDb();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(fake.client);
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface SeedUser {
  userId: string;
  sessionId: string;
  cookie: string;
}

async function seedUser(email: string): Promise<SeedUser> {
  const user = (await fake.client.user.create({
    data: { email, passwordHash: "x", emailVerifiedAt: new Date() },
  })) as { id: string };
  const raw = `cb-raw-${email}`;
  const session = (await fake.client.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(raw),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 1e9),
    },
  })) as { id: string };
  return { userId: user.id, sessionId: session.id, cookie: `mailxp.session=${raw}` };
}

function callbackUrl(params: Record<string, string>): string {
  const url = new URL(CALLBACK);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function request(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

function locationOf(response: Response): string {
  return response.headers.get("location") ?? "";
}

/** Happy Google fetch: token endpoint + userinfo (values overridable). */
function happyFetch(
  options: {
    refreshToken?: string | null;
    emailVerified?: boolean;
    sub?: string;
    email?: string;
    scope?: string;
  } = {},
) {
  return vi.fn(async (url: unknown) => {
    const target = String(url);
    if (target.startsWith("https://oauth2.googleapis.com/token")) {
      const body: Record<string, unknown> = {
        access_token: "at-cb",
        scope: options.scope ?? "openid email",
      };
      if (options.refreshToken !== null) body.refresh_token = options.refreshToken ?? "rt-cb-secret";
      return jsonResponse(body);
    }
    if (target.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      return jsonResponse({
        sub: options.sub ?? "google-sub-cb",
        email: options.email ?? "Cb@gmail.com",
        email_verified: options.emailVerified ?? true,
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
}

// ------------------------------------------------------------ state gates ---

describe("state validation (spec §4.4)", () => {
  it("no session → 'session', state untouched (cannot be burned by others)", async () => {
    const owner = await seedUser("cb-owner@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(owner), intent: "connect" });
    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw })));
    expect(response.status).toBe(307);
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=session`);
    expect(fake.oauthStates[0].consumedAt).toBeNull();
  });

  it("missing state → 'state'", async () => {
    const me = await seedUser("cb-nostate@example.test");
    const response = await callbackGET(request(callbackUrl({ code: "c" }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=state`);
  });

  it("unknown state → 'state' (uniform with expired/replayed — no oracle)", async () => {
    const me = await seedUser("cb-unknown@example.test");
    const response = await callbackGET(
      request(callbackUrl({ code: "c", state: "made-up-state" }), me.cookie),
    );
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=state`);
  });

  it("another user's state → 'state' AND not consumed (victim can still use it)", async () => {
    const victim = await seedUser("cb-victim@example.test");
    const attacker = await seedUser("cb-attacker@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(victim), intent: "connect" });

    const blocked = await callbackGET(
      request(callbackUrl({ code: "c", state: raw }), attacker.cookie),
    );
    expect(locationOf(blocked)).toBe(`${ORIGIN}/?googleOAuth=state`);
    expect(fake.oauthStates[0].consumedAt).toBeNull();

    // …and the rightful owner's attempt proceeds past state validation:
    vi.stubGlobal("fetch", happyFetch());
    const owner = await callbackGET(request(callbackUrl({ code: "c", state: raw }), victim.cookie));
    expect(locationOf(owner)).toBe(`${ORIGIN}/?googleOAuth=connected`);
    expect(fake.googleConnections[0].userId).toBe(victim.userId);
  });

  it("same user but a different session → 'state', not consumed", async () => {
    const me = await seedUser("cb-othersession@example.test");
    const raw = await createOAuthState(fake.client, {
      userId: me.userId,
      sessionId: "session-from-another-device",
      intent: "connect",
    });
    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=state`);
    expect(fake.oauthStates[0].consumedAt).toBeNull();
  });

  it("expired state → 'state'", async () => {
    const me = await seedUser("cb-expired@example.test");
    const raw = await createOAuthState(
      fake.client,
      { userId: me.userId, sessionId: me.sessionId, intent: "connect" },
      Date.now() - 11 * 60 * 1000,
    );
    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=state`);
  });

  it("replay of a completed callback → 'state' (consumed exactly once)", async () => {
    const me = await seedUser("cb-replay@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    vi.stubGlobal("fetch", happyFetch());

    const first = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(first)).toBe(`${ORIGIN}/?googleOAuth=connected`);

    const second = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(second)).toBe(`${ORIGIN}/?googleOAuth=state`);
    expect(fake.googleConnections).toHaveLength(1); // no duplicate link
  });
});

/** Map a SeedUser onto the state-issue input. */
function ownerFor(user: SeedUser): { userId: string; sessionId: string } {
  return { userId: user.userId, sessionId: user.sessionId };
}

// ---------------------------------------------------------- failure paths ---

describe("failure outcomes (spec §4.11–§4.12)", () => {
  it("provider refusal (error=access_denied) → 'denied', no exchange, no link", async () => {
    const me = await seedUser("cb-denied@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await callbackGET(
      request(callbackUrl({ error: "access_denied", state: raw }), me.cookie),
    );
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=denied`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.googleConnections).toHaveLength(0);
    expect(fake.oauthStates[0].consumedAt).not.toBeNull(); // consumed, not reusable
  });

  it("valid state but no code → 'nocode'", async () => {
    const me = await seedUser("cb-nocode@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    const response = await callbackGET(request(callbackUrl({ state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=nocode`);
  });

  it("configuration disappeared mid-flow → 'config', no Google call", async () => {
    const me = await seedUser("cb-config@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    clearGoogleEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=config`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("token exchange failure → 'provider', no link row", async () => {
    const me = await seedUser("cb-provider@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("upstream details", { status: 400 })),
    );

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=provider`);
    expect(fake.googleConnections).toHaveLength(0);
  });

  it("unverified provider email → 'unverified', nothing stored (spec §4.6)", async () => {
    const me = await seedUser("cb-unverified@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    vi.stubGlobal("fetch", happyFetch({ emailVerified: false }));

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=unverified`);
    expect(fake.googleConnections).toHaveLength(0);
    expect(fake.audits).toHaveLength(0);
  });

  it("identity already connected to ANOTHER player → 'conflict', no transfer (§4.8)", async () => {
    const owner = await seedUser("cb-conf-owner@example.test");
    const intruder = await seedUser("cb-conf-intruder@example.test");
    await fake.client.googleConnection.create({
      data: { userId: owner.userId, googleSub: "google-sub-cb", email: "o@gmail.com", scopes: "openid" },
    });

    const raw = await createOAuthState(fake.client, { ...ownerFor(intruder), intent: "connect" });
    vi.stubGlobal("fetch", happyFetch());

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), intruder.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=conflict`);

    // nothing moved, nothing created:
    expect(fake.googleConnections).toHaveLength(1);
    expect(fake.googleConnections[0].userId).toBe(owner.userId);
    const conflictAudit = fake.audits.find((a) => a.eventType === "google.link_conflict");
    expect(conflictAudit?.userId).toBe(intruder.userId);
    expect(fake.audits.filter((a) => a.eventType === "google.connected")).toHaveLength(0);
  });

  it("reconnect target deleted/foreign → 'state' before any exchange", async () => {
    const me = await seedUser("cb-rc-gone@example.test");
    const raw = await createOAuthState(fake.client, {
      ...ownerFor(me),
      intent: "reconnect:does-not-exist",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=state`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ success path ---

describe("success path (spec §4.5/§4.7)", () => {
  it("links the identity, seals the refresh token, audits, redirects clean", async () => {
    const me = await seedUser("cb-success@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    vi.stubGlobal("fetch", happyFetch());

    const response = await callbackGET(request(callbackUrl({ code: "the-code", state: raw }), me.cookie));
    expect(response.status).toBe(307);
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=connected`);
    // no secrets anywhere in the redirect:
    expect(locationOf(response)).not.toContain("the-code");
    expect(locationOf(response)).not.toContain(raw);
    // session cookie untouched (no Set-Cookie on the redirect at all):
    expect(response.headers.get("set-cookie")).toBeNull();

    expect(fake.googleConnections).toHaveLength(1);
    const row = fake.googleConnections[0];
    expect(row.userId).toBe(me.userId);
    expect(row.googleSub).toBe("google-sub-cb");
    expect(row.email).toBe("cb@gmail.com"); // normalized
    expect(row.scopes).toBe("openid email"); // as granted by Google
    expect(JSON.stringify(row)).not.toContain("rt-cb-secret"); // sealed at rest

    const audit = fake.audits.find((a) => a.eventType === "google.connected");
    expect(audit?.userId).toBe(me.userId);
    expect(audit?.meta).toMatchObject({ accountId: row.id });
    expect(JSON.stringify(audit)).not.toContain("rt-cb-secret");
  });

  it("email is REJECTED when Google reports it unverified (status flow)", async () => {
    const me = await seedUser("cb-nomail@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          return jsonResponse({ access_token: "at", refresh_token: "rt" });
        }
        return jsonResponse({ sub: "s-x", email: "x@gmail.com", email_verified: false });
      }),
    );
    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=unverified`);
    expect(fake.googleConnections).toHaveLength(0);
  });

  it("reconnect intent refreshes the EXISTING row (google.reconnected)", async () => {
    const me = await seedUser("cb-reconnect@example.test");
    const existing = (await fake.client.googleConnection.create({
      data: { userId: me.userId, googleSub: "google-sub-cb", email: "old@gmail.com", scopes: "openid" },
    })) as { id: string };
    const raw = await createOAuthState(fake.client, {
      ...ownerFor(me),
      intent: `reconnect:${existing.id}`,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          return jsonResponse({ access_token: "at", refresh_token: "rt-fresh", scope: "openid email" });
        }
        return jsonResponse({ sub: "google-sub-cb", email: "Cb@gmail.com", email_verified: true });
      }),
    );

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=connected`);
    expect(fake.googleConnections).toHaveLength(1); // updated, not duplicated
    expect(fake.googleConnections[0].scopes).toBe("openid email");
    expect(fake.audits.find((a) => a.eventType === "google.reconnected")).toBeDefined();
    expect(fake.audits.filter((a) => a.eventType === "google.connected")).toHaveLength(0);
  });

  it("consent without a refresh token still links (null — never fabricated)", async () => {
    const me = await seedUser("cb-norefresh@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    vi.stubGlobal("fetch", happyFetch({ refreshToken: null }));

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=connected`);
    expect(fake.googleConnections[0].refreshTokenCipher).toBeNull();
  });

  it("state row is stored hash-only end-to-end (raw never in the database)", async () => {
    const me = await seedUser("cb-hashonly@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    expect(fake.oauthStates[0].stateHash).toBe(hashOAuthState(raw));
    expect(JSON.stringify(fake.oauthStates)).not.toContain(raw);
  });

  it("browser-supplied email/sub query params are IGNORED — identity comes only from provider", async () => {
    const me = await seedUser("cb-spoof@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    vi.stubGlobal("fetch", happyFetch());

    const response = await callbackGET(
      request(
        callbackUrl({ code: "c", state: raw, email: "evil@attacker.test", sub: "attacker-sub" }),
        me.cookie,
      ),
    );
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=connected`);
    expect(fake.googleConnections[0]).toMatchObject({
      googleSub: "google-sub-cb", // from userinfo — NOT the attacker-supplied sub
      email: "cb@gmail.com", // from userinfo — NOT the attacker-supplied email
      userId: me.userId,
    });
  });

  it("every failure Location carries ONLY the safe outcome token", async () => {
    const me = await seedUser("cb-cleanloc@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    clearGoogleEnv();
    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    const location = locationOf(response);
    expect(location).toBe(`${ORIGIN}/?googleOAuth=config`);
    expect(location).not.toContain("code=");
    expect(location).not.toContain(raw);
    expect(location).not.toContain("cb-secret");
  });
});

// ------------------------------------------------------------ B8a: signin ---

describe("signin branch (phase_b8a.md §3.4)", () => {
  async function signinState(): Promise<string> {
    return createOAuthState(fake.client, { userId: null, sessionId: null, intent: "signin" });
  }

  it("creates a verified account, links, audits, sets the session cookie — clean Location", async () => {
    const raw = await signinState();
    vi.stubGlobal("fetch", happyFetch({ email: "New.Player@gmail.com" }));

    const response = await callbackGET(request(callbackUrl({ code: "the-code", state: raw })));
    expect(response.status).toBe(307);
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=signin`);
    // Location leaks nothing; only the SIGN-IN success sets a cookie:
    expect(locationOf(response)).not.toContain("the-code");
    expect(locationOf(response)).not.toContain(raw);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("mailxp.session=");
    expect(cookie.toLowerCase()).toContain("httponly");

    // account: born verified, profiled, unusable password (bcrypt of a
    // discarded secret), NO other user touched
    expect(fake.users).toHaveLength(1);
    const user = fake.users[0];
    expect(user.email).toBe("new.player@gmail.com");
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(String(user.passwordHash)).toMatch(/^\$2/);
    expect(fake.profiles).toHaveLength(1);

    // connection: linked + sealed refresh token, granted scopes as returned
    expect(fake.googleConnections).toHaveLength(1);
    expect(fake.googleConnections[0]).toMatchObject({
      userId: user.id,
      googleSub: "google-sub-cb",
      email: "new.player@gmail.com",
      scopes: "openid email",
    });
    expect(JSON.stringify(fake.googleConnections[0])).not.toContain("rt-cb-secret");

    // audits: account creation + link, no secrets in meta
    expect(fake.audits.filter((a) => a.eventType === "auth.register_google")).toHaveLength(1);
    expect(fake.audits.filter((a) => a.eventType === "google.connected")).toHaveLength(1);
    expect(JSON.stringify(fake.audits)).not.toContain("rt-cb-secret");
  });

  it("email match signs INTO the existing password account; rotation revokes the old session", async () => {
    const me = await seedUser("cb.signin.existing@example.test");
    const raw = await signinState();
    vi.stubGlobal("fetch", happyFetch({ sub: "sub-existing", email: "CB.SIGNIN.EXISTING@example.test" }));

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw }), me.cookie));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=signin`);

    expect(fake.users).toHaveLength(1); // no duplicate account
    expect(fake.users[0].id).toBe(me.userId);
    // rotation parity with auth.login: the presented session is revoked…
    const oldSession = fake.sessions.find((s) => s.id === me.sessionId);
    expect(oldSession?.revokedAt).not.toBeNull();
    // …and a FRESH session cookie is issued (≠ the presented one)
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).not.toContain("cb-raw-cb.signin.existing@example.test");

    expect(fake.audits.filter((a) => a.eventType === "auth.login_google")).toHaveLength(1);
    expect(fake.audits.filter((a) => a.eventType === "auth.register_google")).toHaveLength(0);
    // the identity is linked to the same account in the same click:
    expect(fake.googleConnections[0].userId).toBe(me.userId);
  });

  it("a CONNECTED googleSub wins over a same-email DIFFERENT account (stable subject)", async () => {
    const owner = await seedUser("cb.signin.owner@example.test");
    await fake.client.googleConnection.create({
      data: { userId: owner.userId, googleSub: "google-sub-cb", email: "cb@gmail.com", scopes: "openid" },
    });
    const impostor = await seedUser("cb@gmail.com"); // same email as the sub's recorded one
    const raw = await signinState();
    vi.stubGlobal("fetch", happyFetch()); // sub google-sub-cb, email Cb@gmail.com

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw })));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=signin`);
    expect(fake.users).toHaveLength(2); // nobody created
    expect(fake.googleConnections[0].userId).toBe(owner.userId); // sub owner kept
    expect(fake.audits.filter((a) => a.eventType === "auth.login_google")[0]?.userId).toBe(owner.userId);
    expect(impostor.userId).toBeTruthy();
  });

  it("deletion-pending account → 'account', nothing created, no session", async () => {
    const doomed = (await fake.client.user.create({
      data: {
        email: "cb.signin.doomed@example.test",
        passwordHash: "x",
        deletionRequestedAt: new Date(),
      },
    })) as { id: string };
    const raw = await signinState();
    vi.stubGlobal("fetch", happyFetch({ sub: "sub-doomed", email: "cb.signin.doomed@example.test" }));

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw })));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=account`);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fake.users).toHaveLength(1); // the doomed row, untouched
    expect(fake.googleConnections).toHaveLength(0);
    expect(fake.sessions).toHaveLength(0);
    expect(doomed.id).toBeTruthy();
  });

  it("B8b: email match to an account with a DIFFERENT active connection → 'conflict', no second mailbox", async () => {
    // The matched MailXP account already has a connected googleSub that is NOT
    // the one signing in (phase_b8b.md §4). Sign-in must not attach a second
    // connection, silently switch Gmail, or create a duplicate account — the
    // whole transaction rolls back and the user gets a safe `conflict`.
    const me = await seedUser("cb.signin.multiple@example.test");
    await fake.client.googleConnection.create({
      data: { userId: me.userId, googleSub: "sub-already", email: "cb.signin.multiple@example.test", scopes: "openid" },
    });
    const raw = await signinState();
    // A DIFFERENT googleSub signs in but its verified email matches the account.
    vi.stubGlobal("fetch", happyFetch({ sub: "sub-incoming", email: "cb.signin.multiple@example.test" }));

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw })));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=conflict`);
    expect(response.headers.get("set-cookie")).toBeNull(); // no session issued

    // Still exactly ONE connection, still the original sub — nothing added.
    expect(fake.googleConnections).toHaveLength(1);
    expect(fake.googleConnections[0].googleSub).toBe("sub-already");
    expect(fake.googleConnections[0].userId).toBe(me.userId);
    expect(fake.users).toHaveLength(1); // no duplicate account
    // The conflicting attempt is audited (accountId-free, no secrets).
    expect(fake.audits.filter((a) => a.eventType === "google.link_conflict").length).toBeGreaterThan(0);
    expect(JSON.stringify(fake.audits)).not.toContain("sub-incoming");
  });

  it("replay of a completed signin → 'state', no second account", async () => {
    const raw = await signinState();
    vi.stubGlobal("fetch", happyFetch({ sub: "sub-replay", email: "replay@gmail.com" }));

    const first = await callbackGET(request(callbackUrl({ code: "c", state: raw })));
    expect(locationOf(first)).toBe(`${ORIGIN}/?googleOAuth=signin`);
    const second = await callbackGET(request(callbackUrl({ code: "c", state: raw })));
    expect(locationOf(second)).toBe(`${ORIGIN}/?googleOAuth=state`);
    expect(fake.users).toHaveLength(1);
    expect(fake.googleConnections).toHaveLength(1);
  });

  it("provider refusal → 'denied' — no account created, state burned", async () => {
    const raw = await signinState();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await callbackGET(request(callbackUrl({ error: "access_denied", state: raw })));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=denied`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.users).toHaveLength(0);
    expect(fake.oauthStates[0].consumedAt).not.toBeNull();
  });

  it("unverified provider email → 'unverified', NO account created (§4.6 holds for signin)", async () => {
    const raw = await signinState();
    vi.stubGlobal("fetch", happyFetch({ emailVerified: false, email: "unverified@gmail.com" }));

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw })));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=unverified`);
    expect(fake.users).toHaveLength(0);
    expect(fake.audits).toHaveLength(0);
  });

  it("token exchange failure → 'provider', no account created", async () => {
    const raw = await signinState();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("upstream", { status: 400 })),
    );

    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw })));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=provider`);
    expect(fake.users).toHaveLength(0);
  });

  it("a LINK-bound state never enters the signin branch (session gate still applies)", async () => {
    const me = await seedUser("cb.signin.cross@example.test");
    const raw = await createOAuthState(fake.client, { ...ownerFor(me), intent: "connect" });
    // no cookie: the link branch requires the initiating session → 'session',
    // and the state is NOT burned by the unauthenticated attempt.
    const response = await callbackGET(request(callbackUrl({ code: "c", state: raw })));
    expect(locationOf(response)).toBe(`${ORIGIN}/?googleOAuth=session`);
    expect(fake.oauthStates[0].consumedAt).toBeNull();
  });
});
