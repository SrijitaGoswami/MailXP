/** Phase B4 — session token / cookie attribute / cookie parsing tests. */

import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  generateSessionToken,
  hashSessionToken,
  readSessionCookie,
  sessionCookieOptions,
} from "./session";

describe("session token", () => {
  it("is opaque, high entropy, and URL-safe (32 random bytes, base64url)", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits → 43 base64url chars
    expect(token).not.toContain("="); // no structure, nothing to decode
  });

  it("never repeats across generations", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
  });

  it("hashes to stable 64-hex digests that differ per token (only the hash is stored)", () => {
    const token = generateSessionToken();
    const digest = hashSessionToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(digest);
    expect(digest).not.toContain(token);
    expect(hashSessionToken(generateSessionToken())).not.toBe(digest);
  });
});

describe("cookie attributes (B1 §1.2)", () => {
  it("dev (not secure): httpOnly, SameSite=Lax, path=/, 30-day Max-Age", () => {
    const options = sessionCookieOptions(false);
    expect(options).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: false,
      maxAge: 30 * 24 * 60 * 60,
    });
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("production adds Secure", () => {
    expect(sessionCookieOptions(true).secure).toBe(true);
    expect(sessionCookieOptions(true).httpOnly).toBe(true);
  });
});

describe("readSessionCookie", () => {
  const token = "raw-session-token_value-123";

  it("extracts the session cookie among others", () => {
    const request = new Request("http://localhost/api", {
      headers: { cookie: `other=x; ${SESSION_COOKIE}=${token}; last=y` },
    });
    expect(readSessionCookie(request)).toBe(token);
  });

  it("returns null when absent or empty", () => {
    expect(readSessionCookie(new Request("http://localhost/api"))).toBeNull();
    const empty = new Request("http://localhost/api", {
      headers: { cookie: `${SESSION_COOKIE}=` },
    });
    expect(readSessionCookie(empty)).toBeNull();
  });
});
