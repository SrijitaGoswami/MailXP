/**
 * Phase B8 — Google OAuth domain tests (spec §4/§6/§11, MOCKED storage via
 * fakeDb + injected fetch; no network, real crypto).
 *
 * Covers: config presence (names only), state hash-only storage / expiry /
 * single-use / session+user binding, authorization URL + scopes, code
 * exchange and identity validation (verified-email enforcement), linking
 * policy (create / re-link / conflict / released-transfer), token sealing at
 * rest, DTO redaction, and best-effort revocation semantics.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import {
  buildAuthUrl,
  consumeOAuthState,
  consumeSignInState,
  createOAuthState,
  exchangeCode,
  fetchGoogleIdentity,
  generateOAuthState,
  GoogleProviderError,
  GoogleUnverifiedEmailError,
  googleConfigStatus,
  GOOGLE_SCOPES,
  hashOAuthState,
  linkGoogleIdentity,
  openStoredRefreshToken,
  peekOAuthState,
  requireGoogleConfig,
  resolveSignInTarget,
  revokeGoogleToken,
  toGoogleAccountDto,
} from "@/lib/server/googleOAuth";
import { verifyPassword } from "@/lib/server/password";
import { loadTokenKey } from "@/lib/server/secretBox";

const KEY = Buffer.alloc(32, 3);
const CONFIG = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:3000/api/v1/callbacks/googleOAuth",
  encryptionKey: KEY,
};

let fake: FakeDb;

beforeEach(() => {
  fake = createFakeDb();
});

async function makeUser(email: string): Promise<string> {
  const user = (await fake.client.user.create({
    data: { email, passwordHash: "x" },
  })) as { id: string };
  return user.id;
}

// ------------------------------------------------------------------ config ---

describe("configuration (spec §9)", () => {
  it("reports configured=true when all four variables are present", () => {
    const status = googleConfigStatus({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: "http://localhost:3000/api/v1/callbacks/googleOAuth",
      GOOGLE_TOKEN_ENCRYPTION_KEY: KEY.toString("base64"),
    });
    expect(status).toEqual({ configured: true, missing: [] });
  });

  it("lists MISSING VARIABLE NAMES only — never values", () => {
    const status = googleConfigStatus({ GOOGLE_CLIENT_ID: "super-secret-id" });
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual([
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
      "GOOGLE_TOKEN_ENCRYPTION_KEY",
    ]);
    expect(JSON.stringify(status)).not.toContain("super-secret-id");
  });

  it("requireGoogleConfig throws SERVER_ENV_* naming variables, not values", () => {
    let thrown: Error | null = null;
    try {
      requireGoogleConfig({ GOOGLE_CLIENT_ID: "id-value-123" });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("SERVER_ENV_MISSING");
    expect(thrown?.message).toContain("GOOGLE_TOKEN_ENCRYPTION_KEY");
    expect(thrown?.message).not.toContain("id-value-123");
  });
});

// ------------------------------------------------------------------- state ---

describe("OAuth state (spec §4.2/§4.4)", () => {
  const BOUND = { userId: "", sessionId: "session-A" };

  beforeEach(async () => {
    BOUND.userId = await makeUser("state@example.test");
  });

  it("stores ONLY the hash — the raw state never reaches the database", async () => {
    const raw = await createOAuthState(fake.client, { ...BOUND, intent: "connect" });
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256-bit base64url
    const row = fake.oauthStates[0];
    expect(row.stateHash).toBe(hashOAuthState(raw));
    expect(JSON.stringify(row)).not.toContain(raw);
    expect(row.consumedAt).toBeNull();
  });

  it("consumes exactly once — replay fails", async () => {
    const raw = await createOAuthState(fake.client, { ...BOUND, intent: "connect" });
    const first = await consumeOAuthState(fake.client, raw, BOUND);
    expect(first.ok).toBe(true);
    const replay = await consumeOAuthState(fake.client, raw, BOUND);
    expect(replay).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a different user's session WITHOUT consuming the state", async () => {
    const raw = await createOAuthState(fake.client, { ...BOUND, intent: "connect" });
    const attacker = await consumeOAuthState(fake.client, raw, { userId: "someone-else", sessionId: BOUND.sessionId });
    expect(attacker).toEqual({ ok: false, reason: "invalid" });
    const row = fake.oauthStates[0];
    expect(row.consumedAt).toBeNull(); // victim's state survives the attempt
    // and the rightful owner can still use it:
    expect((await consumeOAuthState(fake.client, raw, BOUND)).ok).toBe(true);
  });

  it("rejects a mismatched session id (same user, other tab/device)", async () => {
    const raw = await createOAuthState(fake.client, { ...BOUND, intent: "connect" });
    const other = await consumeOAuthState(fake.client, raw, { userId: BOUND.userId, sessionId: "session-B" });
    expect(other).toEqual({ ok: false, reason: "invalid" });
    expect(fake.oauthStates[0].consumedAt).toBeNull();
  });

  it("rejects expired states", async () => {
    const raw = await createOAuthState(fake.client, { ...BOUND, intent: "connect" }, Date.now() - 11 * 60 * 1000);
    expect(await consumeOAuthState(fake.client, raw, BOUND)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects missing/unknown states uniformly (no oracle)", async () => {
    expect(await consumeOAuthState(fake.client, "", BOUND)).toEqual({ ok: false, reason: "missing" });
    expect(await consumeOAuthState(fake.client, generateOAuthState(), BOUND)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("a raced double-claim yields exactly one winner", async () => {
    const raw = await createOAuthState(fake.client, { ...BOUND, intent: "connect" });
    const [a, b] = await Promise.all([
      consumeOAuthState(fake.client, raw, BOUND),
      consumeOAuthState(fake.client, raw, BOUND),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- auth URL ---

describe("buildAuthUrl (spec §4.3/§5)", () => {
  it("carries the server-configured redirect, code flow, offline consent, and state", () => {
    const url = new URL(buildAuthUrl(CONFIG, "raw-state-value"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri); // never browser-supplied
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("raw-state-value");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent"); // refresh token on every connect
  });

  it("requests exactly the approved least-privilege scopes — identity + gmail.modify, no Calendar", () => {
    const url = new URL(buildAuthUrl(CONFIG, "s"));
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toEqual([...GOOGLE_SCOPES]);
    expect(scopes).toContain("openid");
    expect(scopes).toContain("email");
    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(scopes.some((scope) => scope.includes("calendar"))).toBe(false);
    expect(scopes.some((scope) => scope.includes("mail.readonly"))).toBe(false);
  });

  it("never embeds the client secret in the browser-visible URL", () => {
    expect(buildAuthUrl(CONFIG, "s")).not.toContain(CONFIG.clientSecret);
  });
});

// ------------------------------------------------------- provider round-trip ---

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("exchangeCode (spec §4.4)", () => {
  it("posts the code server-side and returns access + refresh + granted scopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "at-1", refresh_token: "rt-1", scope: "openid email gmail.modify" }),
    );
    const result = await exchangeCode(CONFIG, "code-1", fetchMock as unknown as typeof fetch);
    expect(result).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      grantedScopes: "openid email gmail.modify",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("code")).toBe("code-1");
    expect(body.get("client_secret")).toBe(CONFIG.clientSecret); // secret stays server-side
    expect(body.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("represents a consent without a refresh token as null (no fabrication)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: "at-1" }));
    const result = await exchangeCode(CONFIG, "c", fetchMock as unknown as typeof fetch);
    expect(result.refreshToken).toBeNull();
  });

  it("non-2xx and shape errors throw GoogleProviderError WITHOUT provider bodies", async () => {
    const failing = vi.fn().mockResolvedValue(new Response("token_revoked_detail_secret", { status: 400 }));
    const error = await exchangeCode(CONFIG, "c", failing as unknown as typeof fetch).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleProviderError);
    expect(String(error.message)).not.toContain("token_revoked_detail_secret");

    const noToken = vi.fn().mockResolvedValue(jsonResponse({ refresh_token: "rt" }));
    await expect(exchangeCode(CONFIG, "c", noToken as unknown as typeof fetch)).rejects.toBeInstanceOf(
      GoogleProviderError,
    );
  });

  it("network failure classifies as a provider error", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(exchangeCode(CONFIG, "c", offline as unknown as typeof fetch)).rejects.toBeInstanceOf(
      GoogleProviderError,
    );
  });
});

describe("fetchGoogleIdentity (spec §4.5/§4.6)", () => {
  it("accepts a provider-verified identity and normalizes the email", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ sub: "google-sub-1", email: "  Player@Gmail.com ", email_verified: true }));
    const identity = await fetchGoogleIdentity("at-1", fetchMock as unknown as typeof fetch);
    expect(identity).toEqual({ sub: "google-sub-1", email: "player@gmail.com" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer at-1");
  });

  it("REJECTS an unverified provider email", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ sub: "s", email: "x@example.test", email_verified: false }));
    await expect(fetchGoogleIdentity("at", fetchMock as unknown as typeof fetch)).rejects.toBeInstanceOf(
      GoogleUnverifiedEmailError,
    );
  });

  it("rejects a missing/invalid provider payload (never trusts browser input)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ email: "x@example.test", email_verified: true }));
    await expect(fetchGoogleIdentity("at", fetchMock as unknown as typeof fetch)).rejects.toBeInstanceOf(
      GoogleProviderError,
    );
    const http500 = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchGoogleIdentity("at", http500 as unknown as typeof fetch)).rejects.toBeInstanceOf(
      GoogleProviderError,
    );
  });
});

describe("revokeGoogleToken (spec §6)", () => {
  it("reports true ONLY on provider confirmation", async () => {
    const ok = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    expect(await revokeGoogleToken("rt", ok as unknown as typeof fetch)).toBe(true);
    const rejected = vi.fn().mockResolvedValue(new Response("", { status: 400 }));
    expect(await revokeGoogleToken("rt", rejected as unknown as typeof fetch)).toBe(false);
  });

  it("never throws on network failure (best-effort by contract)", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("offline"));
    await expect(revokeGoogleToken("rt", offline as unknown as typeof fetch)).resolves.toBe(false);
  });
});

// ------------------------------------------------------------------ linking ---

describe("linkGoogleIdentity (spec §4.7–§4.9)", () => {
  const IDENTITY = { sub: "sub-1", email: "player@gmail.com" };

  it("creates a new link with a SEALED refresh token (ciphertext ≠ plaintext)", async () => {
    const userId = await makeUser("linker@example.test");
    const result = await linkGoogleIdentity(fake.client, {
      userId,
      identity: IDENTITY,
      refreshToken: "rt-plaintext",
      grantedScopes: "openid email",
      encryptionKey: KEY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("linked");
    const row = fake.googleConnections[0];
    expect(row.googleSub).toBe("sub-1");
    expect(row.userId).toBe(userId);
    expect(row.refreshTokenCipher).not.toBe("rt-plaintext");
    expect(JSON.stringify(row)).not.toContain("rt-plaintext");
    expect(openStoredRefreshToken(row as never, loadTokenKey({ GOOGLE_TOKEN_ENCRYPTION_KEY: KEY.toString("base64") }))).toBe(
      "rt-plaintext",
    );
  });

  it("re-linking the same player refreshes credentials (reconnected)", async () => {
    const userId = await makeUser("same@example.test");
    await linkGoogleIdentity(fake.client, {
      userId,
      identity: IDENTITY,
      refreshToken: "rt-old",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    const second = await linkGoogleIdentity(fake.client, {
      userId,
      identity: IDENTITY,
      refreshToken: "rt-new",
      grantedScopes: "openid email gmail.modify",
      encryptionKey: KEY,
    });
    expect(second.ok && second.outcome).toBe("reconnected");
    expect(fake.googleConnections).toHaveLength(1);
    expect(openStoredRefreshToken(fake.googleConnections[0] as never, KEY)).toBe("rt-new");
  });

  it("an identity held by ANOTHER player is a conflict — no transfer, no silent sign-in", async () => {
    const owner = await makeUser("owner@example.test");
    const intruder = await makeUser("intruder@example.test");
    await linkGoogleIdentity(fake.client, {
      userId: owner,
      identity: IDENTITY,
      refreshToken: "rt-owner",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    const attempt = await linkGoogleIdentity(fake.client, {
      userId: intruder,
      identity: IDENTITY,
      refreshToken: "rt-intruder",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    expect(attempt).toEqual({ ok: false, reason: "conflict" });
    expect(fake.googleConnections).toHaveLength(1);
    expect(fake.googleConnections[0].userId).toBe(owner); // untouched
    expect(openStoredRefreshToken(fake.googleConnections[0] as never, KEY)).toBe("rt-owner");
  });

  it("a RELEASED identity transfers to the new player (the documented path)", async () => {
    const first = await makeUser("first@example.test");
    const second = await makeUser("second@example.test");
    const created = await linkGoogleIdentity(fake.client, {
      userId: first,
      identity: IDENTITY,
      refreshToken: "rt-1",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await fake.client.googleConnection.update({
      where: { id: created.account.id },
      data: { status: "released", refreshTokenCipher: null, refreshTokenNonce: null, refreshTokenTag: null },
    });

    const transfer = await linkGoogleIdentity(fake.client, {
      userId: second,
      identity: IDENTITY,
      refreshToken: "rt-2",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    expect(transfer.ok && transfer.outcome).toBe("transferred");
    expect(fake.googleConnections[0].userId).toBe(second);
    expect(fake.googleConnections[0].status).toBe("connected");
    expect(openStoredRefreshToken(fake.googleConnections[0] as never, KEY)).toBe("rt-2");
  });

  it("null refresh token keeps existing sealed material (never wipes on re-consent loss)", async () => {
    const userId = await makeUser("keep@example.test");
    const first = await linkGoogleIdentity(fake.client, {
      userId,
      identity: IDENTITY,
      refreshToken: "rt-keep",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    expect(first.ok).toBe(true);
    await linkGoogleIdentity(fake.client, {
      userId,
      identity: IDENTITY,
      refreshToken: null,
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    expect(openStoredRefreshToken(fake.googleConnections[0] as never, KEY)).toBe("rt-keep");
  });

  it("googleSub uniqueness is enforced at the database layer (P2002)", async () => {
    const a = await makeUser("a@example.test");
    const b = await makeUser("b@example.test");
    await fake.client.googleConnection.create({
      data: { userId: a, googleSub: "dup-sub", email: "d@example.test", scopes: "" },
    });
    await expect(
      fake.client.googleConnection.create({
        data: { userId: b, googleSub: "dup-sub", email: "d@example.test", scopes: "" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

// ------------------------------------------------ B8b: one Gmail per user ---

describe("B8b: one connected Gmail per MailXP user (phase_b8b.md §3/§5)", () => {
  it("a user who already has a DIFFERENT connected sub is refused — no second mailbox", async () => {
    const userId = await makeUser("one-mailbox@example.test");
    const first = await linkGoogleIdentity(fake.client, {
      userId,
      identity: { sub: "sub-a", email: "a@gmail.com" },
      refreshToken: "rt-a",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    expect(first.ok).toBe(true);

    const attempt = await linkGoogleIdentity(fake.client, {
      userId,
      identity: { sub: "sub-b", email: "b@gmail.com" },
      refreshToken: "rt-b",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    expect(attempt).toEqual({ ok: false, reason: "conflict" });
    // Still exactly ONE row, still sub-a, credentials untouched.
    expect(fake.googleConnections).toHaveLength(1);
    expect(fake.googleConnections[0].googleSub).toBe("sub-a");
    expect(openStoredRefreshToken(fake.googleConnections[0] as never, KEY)).toBe("rt-a");
  });

  it("reconnecting the SAME sub is still allowed (reconnect/update in place)", async () => {
    const userId = await makeUser("reconnect-ok@example.test");
    await linkGoogleIdentity(fake.client, {
      userId,
      identity: { sub: "sub-same", email: "same@gmail.com" },
      refreshToken: "rt-1",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    const again = await linkGoogleIdentity(fake.client, {
      userId,
      identity: { sub: "sub-same", email: "same@gmail.com" },
      refreshToken: "rt-2",
      grantedScopes: "openid email gmail.modify",
      encryptionKey: KEY,
    });
    expect(again.ok && again.outcome).toBe("reconnected");
    expect(fake.googleConnections).toHaveLength(1);
  });

  it("after an explicit release the same user MAY connect a different sub (switch flow)", async () => {
    const userId = await makeUser("switch@example.test");
    const first = await linkGoogleIdentity(fake.client, {
      userId,
      identity: { sub: "sub-old", email: "old@gmail.com" },
      refreshToken: "rt-old",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Explicit release: status flipped + sealed columns wiped in place (the
    // route's exact semantics) — this is the sanctioned precondition.
    await fake.client.googleConnection.update({
      where: { id: first.account.id },
      data: { status: "released", refreshTokenCipher: null, refreshTokenNonce: null, refreshTokenTag: null },
    });

    const attempt = await linkGoogleIdentity(fake.client, {
      userId,
      identity: { sub: "sub-new", email: "new@gmail.com" },
      refreshToken: "rt-new",
      grantedScopes: "openid",
      encryptionKey: KEY,
    });
    expect(attempt.ok).toBe(true);
    expect(fake.googleConnections.filter((r) => r.status === "connected")).toHaveLength(1);
    expect(fake.googleConnections.find((r) => r.status === "connected")?.googleSub).toBe("sub-new");
  });

  it("the database invariant rejects a second CONNECTED row for one user (P2002)", async () => {
    const userId = await makeUser("db-invariant@example.test");
    await fake.client.googleConnection.create({
      data: { userId, googleSub: "inv-1", email: "i1@gmail.com", scopes: "" },
    });
    await expect(
      fake.client.googleConnection.create({
        data: { userId, googleSub: "inv-2", email: "i2@gmail.com", scopes: "" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("released historical rows for one user do NOT trip the invariant", async () => {
    const userId = await makeUser("history@example.test");
    const a = await fake.client.googleConnection.create({
      data: { userId, googleSub: "hist-1", email: "h1@gmail.com", scopes: "" },
    });
    await fake.client.googleConnection.update({
      where: { id: a.id },
      data: { status: "released", refreshTokenCipher: null, refreshTokenNonce: null, refreshTokenTag: null },
    });
    // A released row + a new connected row coexist legally.
    await expect(
      fake.client.googleConnection.create({
        data: { userId, googleSub: "hist-2", email: "h2@gmail.com", scopes: "" },
      }),
    ).resolves.toBeTruthy();
    expect(fake.googleConnections.filter((r) => r.userId === userId)).toHaveLength(2);
    expect(fake.googleConnections.filter((r) => r.userId === userId && r.status === "connected")).toHaveLength(1);
  });
});

// -------------------------------------------------------------------- DTOs ---

describe("toGoogleAccountDto (spec §4.10 — no token leakage)", () => {
  it("emits only public fields, splitting granted scopes", async () => {
    const userId = await makeUser("dto@example.test");
    await linkGoogleIdentity(fake.client, {
      userId,
      identity: { sub: "sub-dto", email: "dto@gmail.com" },
      refreshToken: "rt-secret",
      grantedScopes: "openid email",
      encryptionKey: KEY,
    });
    const dto = toGoogleAccountDto(fake.googleConnections[0] as never);
    expect(dto).toEqual({
      id: fake.googleConnections[0].id,
      email: "dto@gmail.com",
      status: "connected",
      scopes: ["openid", "email"],
      connectedAt: expect.any(String),
    });
    expect(JSON.stringify(dto)).not.toContain("rt-secret");
    expect(JSON.stringify(dto)).not.toContain("Cipher");
    expect(Object.keys(dto).sort()).toEqual(["connectedAt", "email", "id", "scopes", "status"]);
  });

  it("released rows surface as 'released'", async () => {
    const userId = await makeUser("rel@example.test");
    await fake.client.googleConnection.create({
      data: { userId, googleSub: "sub-rel", email: "r@example.test", scopes: "", status: "released" },
    });
    expect(toGoogleAccountDto(fake.googleConnections[0] as never).status).toBe("released");
  });
});

// --------------------------------------- spec §11: out-of-scope is structurally absent ---

const B8_LIB_FILES = [
  "lib/server/googleOAuth.ts",
  "lib/server/googleConnect.ts",
  "lib/server/secretBox.ts",
];
const B8_ROUTE_FILES = [
  "app/api/v1/integrations/google/route.ts",
  "app/api/v1/integrations/google/start/route.ts",
  "app/api/v1/integrations/google/accounts/route.ts",
  "app/api/v1/integrations/google/accounts/[accountId]/route.ts",
  "app/api/v1/integrations/google/accounts/[accountId]/reconnect/route.ts",
  "app/api/v1/integrations/google/accounts/[accountId]/release/route.ts",
  "app/api/v1/callbacks/googleOAuth/route.ts",
];

/** Read a source file with comments stripped (so docs may mention anything). */
function sourceOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("out-of-scope integrations are structurally absent (spec §11)", () => {
  it("no Gmail message/thread/label/draft/send or Calendar endpoint in any B8 module", () => {
    // The approved SCOPE constant (/auth/gmail.modify) is intentionally NOT matched.
    const forbidden =
      /gmail\/v1|users\.(messages|threads|labels|drafts|settings|history)|messages\/(send|modify|batch)|batchModify|drafts\.(create|send|delete)|calendar\/v3|googleapis\.com\/(gmail|calendar)/i;
    for (const file of [...B8_LIB_FILES, ...B8_ROUTE_FILES]) {
      expect(forbidden.test(sourceOf(file)), `${file} must not contain Gmail/Calendar data APIs`).toBe(false);
    }
  });

  it("the only outbound hosts are Google OAuth/identity endpoints (allow-list)", () => {
    const code = sourceOf("lib/server/googleOAuth.ts");
    const hosts = Array.from(code.matchAll(/https:\/\/([a-z0-9.-]+)\b/gi), (m) => (m[1] as string).toLowerCase());
    const allowed = [
      "accounts.google.com", // authorization endpoint
      "oauth2.googleapis.com", // token endpoint + revocation
      "openidconnect.googleapis.com", // identity (userinfo)
      "www.googleapis.com", // SCOPE strings handed to Google (not data APIs)
    ];
    for (const host of hosts) {
      expect(allowed, `unexpected outbound host: ${host}`).toContain(host);
    }
  });

  it("route handlers never call fetch directly — all network flows through the audited lib", () => {
    for (const file of B8_ROUTE_FILES) {
      expect(/\bfetch\s*\(/.test(sourceOf(file)), `${file} must not call fetch`).toBe(false);
    }
  });
});

// -------------------------------------- B8a: sign-in state + resolver (phase_b8a.md) ---

describe("B8a: unbound signin state", () => {
  it("mints with NULL bindings, stores hash-only, and consumes exactly once", async () => {
    const raw = await createOAuthState(fake.client, {
      userId: null,
      sessionId: null,
      intent: "signin",
    });
    const row = fake.oauthStates[0];
    expect(row.intent).toBe("signin");
    expect(row.userId).toBeNull();
    expect(row.sessionId).toBeNull();
    expect(row.stateHash).toBe(hashOAuthState(raw));
    expect(JSON.stringify(row)).not.toContain(raw);

    const first = await consumeSignInState(fake.client, raw);
    expect(first.ok).toBe(true);
    const replay = await consumeSignInState(fake.client, raw);
    expect(replay).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects expired/missing/unknown states uniformly", async () => {
    const raw = await createOAuthState(
      fake.client,
      { userId: null, sessionId: null, intent: "signin" },
      Date.now() - 11 * 60 * 1000,
    );
    expect(await consumeSignInState(fake.client, raw)).toEqual({ ok: false, reason: "invalid" });
    expect(await consumeSignInState(fake.client, "")).toEqual({ ok: false, reason: "missing" });
    expect(await consumeSignInState(fake.client, generateOAuthState())).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("a LINK state is never consumable via the signin path (and survives untouched)", async () => {
    const userId = await makeUser("bound@example.test");
    const raw = await createOAuthState(fake.client, {
      userId,
      sessionId: "session-A",
      intent: "connect",
    });
    expect(await consumeSignInState(fake.client, raw)).toEqual({ ok: false, reason: "invalid" });
    expect(fake.oauthStates[0].consumedAt).toBeNull();
  });

  it("a signin state is never consumable via the bound link path", async () => {
    const raw = await createOAuthState(fake.client, {
      userId: null,
      sessionId: null,
      intent: "signin",
    });
    const attempt = await consumeOAuthState(fake.client, raw, {
      userId: "whoever",
      sessionId: "whatever",
    });
    expect(attempt).toEqual({ ok: false, reason: "invalid" });
    expect(fake.oauthStates[0].consumedAt).toBeNull();
  });

  it("peekOAuthState returns the row WITHOUT consuming it", async () => {
    const raw = await createOAuthState(fake.client, {
      userId: null,
      sessionId: null,
      intent: "signin",
    });
    const peeked = await peekOAuthState(fake.client, raw);
    expect(peeked?.intent).toBe("signin");
    expect(fake.oauthStates[0].consumedAt).toBeNull();
    expect(await peekOAuthState(fake.client, "nope")).toBeNull();
  });
});

describe("B8a: resolveSignInTarget (phase_b8a.md §3.3)", () => {
  it("connected googleSub WINS over an email coincidence (stable subject)", async () => {
    const owner = await makeUser("subowner@example.test");
    const sameEmail = await makeUser("same.email@example.test"); // NOT the sub owner
    await fake.client.googleConnection.create({
      data: { userId: owner, googleSub: "sub-linked", email: "same.email@example.test", scopes: "" },
    });

    const result = await resolveSignInTarget(fake.client, {
      sub: "sub-linked",
      email: "same.email@example.test",
    });
    expect(result).toEqual({ ok: true, userId: owner, disposition: "linked" });
    expect(fake.users).toHaveLength(2); // nobody created
    expect(sameEmail).toBeTruthy();
  });

  it("email match signs into the EXISTING account (user decision 2026-10-10)", async () => {
    const existing = await makeUser("existing@gmail.com");
    const result = await resolveSignInTarget(fake.client, {
      sub: "sub-fresh",
      email: "existing@gmail.com",
    });
    expect(result).toEqual({ ok: true, userId: existing, disposition: "existing" });
    expect(fake.users).toHaveLength(1);
  });

  it("deletion-pending accounts are REFUSED (auth.login parity)", async () => {
    const doomed = (await fake.client.user.create({
      data: { email: "doomed@gmail.com", passwordHash: "x", deletionRequestedAt: new Date() },
    })) as { id: string };
    const result = await resolveSignInTarget(fake.client, {
      sub: "sub-doomed",
      email: "doomed@gmail.com",
    });
    expect(result).toEqual({ ok: false, reason: "account_disabled" });
  });

  it("deletion-pending account is also refused when the connected googleSub matches", async () => {
    const doomed = (await fake.client.user.create({
      data: { email: "linked.doomed@gmail.com", passwordHash: "x", deletionRequestedAt: new Date() },
    })) as { id: string };
    await fake.client.googleConnection.create({
      data: {
        userId: doomed.id,
        googleSub: "sub-linked-doomed",
        email: "linked.doomed@gmail.com",
        scopes: "openid email",
      },
    });
    const result = await resolveSignInTarget(fake.client, {
      sub: "sub-linked-doomed",
      email: "linked.doomed@gmail.com",
    });
    expect(result).toEqual({ ok: false, reason: "account_disabled" });
  });

  it("creates a verified account with profile defaults and an UNUSABLE password", async () => {
    const result = await resolveSignInTarget(fake.client, {
      sub: "sub-new",
      email: "brand.new@gmail.com",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.disposition).toBe("created");
    const user = fake.users[0];
    expect(user.id).toBe(result.userId);
    expect(user.emailVerifiedAt).not.toBeNull(); // Google asserted it on consent
    expect(user.deletionRequestedAt).toBeNull();
    // valid bcrypt of a DISCARDED secret — no password login is possible, and
    // no account-less ghost: the profile exists with the register defaults.
    expect(String(user.passwordHash)).toMatch(/^\$2/);
    await expect(verifyPassword("whatever-guessed", String(user.passwordHash))).resolves.toBe(false);
    expect(fake.profiles).toHaveLength(1);
    expect(fake.profiles[0].userId).toBe(user.id);
    expect(fake.profiles[0].draftCoin).toBe(0);
  });

  it("released sub + matching email → the email-matched account (transfer happens at link)", async () => {
    const first = await makeUser("holder@gmail.com");
    await fake.client.googleConnection.create({
      data: { userId: first, googleSub: "sub-released", email: "holder@gmail.com", scopes: "", status: "released" },
    });
    const result = await resolveSignInTarget(fake.client, {
      sub: "sub-released",
      email: "holder@gmail.com",
    });
    expect(result).toEqual({ ok: true, userId: first, disposition: "existing" });
  });
});
