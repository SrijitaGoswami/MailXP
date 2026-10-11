/** Phase B4 — rate limiter tests for all four B1 §1.8 classes. */

import { describe, expect, it } from "vitest";
import { RATE_CLASSES, checkRate, clientIp, rateLimitStore } from "./rateLimit";

// Unique key suffixes per run keep this file independent of other suites
// sharing the same process-local store.
const RUN = `t${Date.now().toString(36)}`;

describe("rate classes (B1 §1.8 values)", () => {
  it("declares the confirmed limits", () => {
    expect(RATE_CLASSES.register).toEqual({ limit: 5, windowMs: 3_600_000 });
    expect(RATE_CLASSES.login).toEqual({ limit: 10, windowMs: 900_000 });
    expect(RATE_CLASSES.credentialEmail).toEqual({ limit: 5, windowMs: 3_600_000 });
    expect(RATE_CLASSES.general).toEqual({ limit: 60, windowMs: 60_000 });
  });

  it("register: allows 5/hour per IP, blocks the 6th with Retry-After", () => {
    const now = 1_000_000;
    const key = `${RUN}-register`;
    for (let i = 1; i <= 5; i += 1) {
      expect(checkRate("register", key, now).allowed).toBe(true);
    }
    const blocked = checkRate("register", key, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("login: separate keys per email+IP composite", () => {
    const now = 2_000_000;
    const a = `${RUN}-login-a`;
    const b = `${RUN}-login-b`;
    for (let i = 0; i < 10; i += 1) expect(checkRate("login", a, now).allowed).toBe(true);
    expect(checkRate("login", a, now).allowed).toBe(false);
    expect(checkRate("login", b, now).allowed).toBe(true); // other key unaffected
  });

  it("credentialEmail: 5/hour window", () => {
    const now = 3_000_000;
    const key = `${RUN}-cred`;
    for (let i = 0; i < 5; i += 1) expect(checkRate("credentialEmail", key, now).allowed).toBe(true);
    expect(checkRate("credentialEmail", key, now).allowed).toBe(false);
  });

  it("general: 60/minute window", () => {
    const now = 4_000_000;
    const key = `${RUN}-gen`;
    for (let i = 0; i < 60; i += 1) expect(checkRate("general", key, now).allowed).toBe(true);
    expect(checkRate("general", key, now).allowed).toBe(false);
  });

  it("window resets after expiry", () => {
    const start = 5_000_000;
    const key = `${RUN}-window`;
    for (let i = 0; i < 5; i += 1) checkRate("register", key, start);
    expect(checkRate("register", key, start).allowed).toBe(false);
    // A moment after the window resets, traffic flows again.
    expect(checkRate("register", key, start + 3_600_001).allowed).toBe(true);
  });

  it("store honors an injected clock (deterministic, no real waiting)", () => {
    const decision = rateLimitStore.consume(`${RUN}-clock`, 1, 1000, 10_000);
    expect(decision.allowed).toBe(true);
    expect(rateLimitStore.consume(`${RUN}-clock`, 1, 1000, 10_500).allowed).toBe(false);
    expect(rateLimitStore.consume(`${RUN}-clock`, 1, 1000, 11_001).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("uses the first X-Forwarded-For entry", () => {
    const request = new Request("http://localhost/api", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("falls back to a shared bucket when no header exists", () => {
    expect(clientIp(new Request("http://localhost/api"))).toBe("unknown");
  });
});
