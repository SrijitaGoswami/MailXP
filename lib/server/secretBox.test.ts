/**
 * Phase B8 — AES-256-GCM secret sealing tests (spec §6).
 *
 * Fail-closed contract: missing/invalid key throws with the variable NAME
 * only; wrong key and tampered ciphertext throw instead of returning garbage;
 * sealed bundles never contain the plaintext; nonces are unique per seal.
 * Real crypto, no mocks, no committed key material (test keys are synthesized
 * in code, never read from the environment).
 */

import { describe, expect, it } from "vitest";
import { loadTokenKey, openSecret, sealSecret, TOKEN_KEY_VERSION } from "./secretBox";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const KEY_B64 = KEY.toString("base64");
const PLAINTEXT = "1//0g-refresh-token-material";

describe("loadTokenKey — fail closed, name-only diagnostics", () => {
  it("accepts base64 that decodes to exactly 32 bytes", () => {
    expect(loadTokenKey({ GOOGLE_TOKEN_ENCRYPTION_KEY: KEY_B64 })).toEqual(KEY);
  });

  it("missing variable throws SERVER_ENV_MISSING naming only the variable", () => {
    let thrown: Error | null = null;
    try {
      loadTokenKey({});
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("SERVER_ENV_MISSING");
    expect(thrown?.message).toContain("GOOGLE_TOKEN_ENCRYPTION_KEY");
    expect(thrown?.message).not.toContain(KEY_B64); // no value leakage, ever
  });

  it("empty or whitespace value throws SERVER_ENV_MISSING", () => {
    expect(() => loadTokenKey({ GOOGLE_TOKEN_ENCRYPTION_KEY: "" })).toThrow(/SERVER_ENV_MISSING/);
    expect(() => loadTokenKey({ GOOGLE_TOKEN_ENCRYPTION_KEY: "   " })).toThrow(/SERVER_ENV_MISSING/);
  });

  it("wrong-length key throws SERVER_ENV_INVALID without echoing the value", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    let thrown: Error | null = null;
    try {
      loadTokenKey({ GOOGLE_TOKEN_ENCRYPTION_KEY: short });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("SERVER_ENV_INVALID");
    expect(thrown?.message).toContain("32 bytes");
    expect(thrown?.message).not.toContain(short);
  });

  it("garbage input never decodes into an accepted key", () => {
    // Node's lenient base64 decode yields <32 bytes (or 0) for garbage.
    expect(() => loadTokenKey({ GOOGLE_TOKEN_ENCRYPTION_KEY: "!!!not-base64!!!" })).toThrow(/SERVER_ENV_INVALID/);
  });
});

describe("sealSecret / openSecret — authenticated round trip", () => {
  it("round-trips and stamps the key version", () => {
    const sealed = sealSecret(PLAINTEXT, KEY);
    expect(sealed.keyVersion).toBe(TOKEN_KEY_VERSION);
    expect(openSecret(sealed, KEY)).toBe(PLAINTEXT);
  });

  it("uses a fresh nonce for every seal (same plaintext ≠ same ciphertext)", () => {
    const first = sealSecret(PLAINTEXT, KEY);
    const second = sealSecret(PLAINTEXT, KEY);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.cipher).not.toBe(second.cipher);
  });

  it("sealed bundle never contains the plaintext", () => {
    const sealed = sealSecret(PLAINTEXT, KEY);
    expect(JSON.stringify(sealed)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(sealed)).not.toContain("refresh-token");
  });

  it("wrong key fails closed with SECRET_OPEN_FAILED (no garbage output)", () => {
    const sealed = sealSecret(PLAINTEXT, KEY);
    expect(() => openSecret(sealed, OTHER_KEY)).toThrow(/SECRET_OPEN_FAILED/);
  });

  it("tampered ciphertext fails closed", () => {
    const sealed = sealSecret(PLAINTEXT, KEY);
    const bytes = Buffer.from(sealed.cipher, "base64");
    bytes[0] ^= 0xff;
    expect(() => openSecret({ ...sealed, cipher: bytes.toString("base64") }, KEY)).toThrow(/SECRET_OPEN_FAILED/);
  });

  it("tampered auth tag fails closed", () => {
    const sealed = sealSecret(PLAINTEXT, KEY);
    const tag = Buffer.from(sealed.tag, "base64");
    tag[0] ^= 0xff;
    expect(() => openSecret({ ...sealed, tag: tag.toString("base64") }, KEY)).toThrow(/SECRET_OPEN_FAILED/);
  });

  it("malformed parts (wrong nonce length, missing fields) fail closed", () => {
    const sealed = sealSecret(PLAINTEXT, KEY);
    expect(() => openSecret({ ...sealed, nonce: Buffer.alloc(5).toString("base64") }, KEY)).toThrow(
      /SECRET_OPEN_FAILED/,
    );
    expect(() =>
      openSecret({ cipher: sealed.cipher, nonce: null as unknown as string, tag: sealed.tag }, KEY),
    ).toThrow(/SECRET_OPEN_FAILED/);
  });
});
