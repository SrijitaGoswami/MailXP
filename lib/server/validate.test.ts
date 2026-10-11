/** Phase B4 — email/password policy tests (B1 contract §2, binding). */

import { describe, expect, it } from "vitest";
import { COMMON_PASSWORD_COUNT, isCommonPassword } from "./commonPasswords";
import { EMAIL_MAX, normalizeEmail, validateEmail, validatePassword } from "./validate";

describe("email policy", () => {
  it("trims and lowercases (contract normalization)", () => {
    expect(normalizeEmail("  Player@Example.COM ")).toBe("player@example.com");
    const result = validateEmail("  Player@Example.COM ");
    expect(result.ok && result.value).toBe("player@example.com");
  });

  it("rejects missing, non-string, and empty values with a field error", () => {
    for (const value of [undefined, null, 42, "", "   "]) {
      const result = validateEmail(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.field).toBe("email");
      }
    }
  });

  it("rejects malformed addresses and over-long inputs", () => {
    for (const value of ["nope", "a@b", "a b@c.de", "@x.com", `a@${"x".repeat(250)}.com`]) {
      const result = validateEmail(value);
      expect(result.ok).toBe(false);
    }
    // Over the 254-char cap even though the shape is fine:
    const overCap = `${"a".repeat(240)}@${"x".repeat(20)}.com`;
    expect(overCap.length).toBeGreaterThan(EMAIL_MAX);
    expect(validateEmail(overCap).ok).toBe(false);
  });

  it("accepts ordinary addresses", () => {
    for (const value of ["a@b.co", "first.last+tag@sub.example.org"]) {
      expect(validateEmail(value).ok).toBe(true);
    }
  });
});

describe("password policy", () => {
  it("requires at least 10 characters", () => {
    const short = validatePassword("short12");
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.errors[0]?.message).toMatch(/at least 10/);
    expect(validatePassword("0123456789").ok).toBe(true);
  });

  it("caps at 128 characters", () => {
    const long = validatePassword("a".repeat(129));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors[0]?.message).toMatch(/at most 128/);
    expect(validatePassword("a".repeat(128)).ok).toBe(true);
  });

  it("rejects common passwords case-insensitively (static blocklist)", () => {
    expect(isCommonPassword("password")).toBe(true);
    expect(isCommonPassword("PassWord")).toBe(true);
    expect(isCommonPassword("123456")).toBe(true);
    expect(isCommonPassword("qwerty123")).toBe(true);
    const result = validatePassword("password123"); // 11 chars — length passes, blocklist must catch it
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/too common/);
  });

  it("applies NO composition rules (contract) and no forced rotation", () => {
    expect(validatePassword("alllowercaseletters").ok).toBe(true); // no upper/digit required
    expect(validatePassword("ANOTHERALLCAPSPASSPHRASE").ok).toBe(true);
    expect(validatePassword("correct horse battery staple").ok).toBe(true); // spaces allowed
  });

  it("rejects missing/non-string passwords", () => {
    for (const value of [undefined, null, 1234567890, ""]) {
      expect(validatePassword(value).ok).toBe(false);
    }
  });

  it("ships a non-trivial blocklist", () => {
    expect(COMMON_PASSWORD_COUNT).toBeGreaterThan(100);
  });
});
