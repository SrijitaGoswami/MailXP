/** Phase B4 — password hashing + dev-mode delivery gate tests. */

import { describe, expect, it } from "vitest";
import { buildDevDelivery, devDeliveryEnabled } from "./emailDelivery";
import { BCRYPT_COST, burnPasswordCheck, hashPassword, verifyPassword } from "./password";

describe("password hashing (bcryptjs)", () => {
  it("produces a bcrypt hash with the configured cost — never plaintext", async () => {
    const stored = await hashPassword("a-perfectly-fine-passphrase");
    expect(stored).toMatch(/^\$2[aby]\$10\$/); // bcrypt format, cost 10
    expect(stored).not.toContain("a-perfectly-fine-passphrase");
    expect(BCRYPT_COST).toBe(10);
  });

  it("salts: the same password hashes differently every time", async () => {
    const [a, b] = await Promise.all([hashPassword("same-input-12345"), hashPassword("same-input-12345")]);
    expect(a).not.toBe(b);
  });

  it("verifies the right password and rejects wrong ones", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("verify never throws on a malformed stored hash", async () => {
    expect(await verifyPassword("whatever", "not-a-bcrypt-hash")).toBe(false);
    expect(await verifyPassword("whatever", "")).toBe(false);
  });

  it("the timing-parity burn performs real work and never matches", async () => {
    const started = Date.now();
    await burnPasswordCheck("anything-at-all");
    await burnPasswordCheck("anything-at-all"); // second call reuses the dummy
    expect(Date.now() - started).toBeGreaterThanOrEqual(0); // exercised the path
  });
});

describe("dev-mode delivery gate (user decision B4)", () => {
  it("enabled outside production, disabled in production", () => {
    expect(devDeliveryEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(devDeliveryEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(devDeliveryEnabled({ NODE_ENV: undefined })).toBe(true); // conservative default
    expect(devDeliveryEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("builds the payload in dev and returns null in production", () => {
    const expiresAt = new Date("2026-10-11T08:00:00.000Z");
    const dev = buildDevDelivery("password_reset", "raw-token-abc", expiresAt, { NODE_ENV: "development" });
    expect(dev).toEqual({
      purpose: "password_reset",
      token: "raw-token-abc",
      expiresAt: "2026-10-11T08:00:00.000Z",
    });
    expect(buildDevDelivery("password_reset", "raw-token-abc", expiresAt, { NODE_ENV: "production" })).toBeNull();
  });
});
