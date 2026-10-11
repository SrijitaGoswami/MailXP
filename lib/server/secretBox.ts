/**
 * Authenticated secret sealing — AES-256-GCM (Phase B8, spec §6).
 *
 * User decision 2026-10-10 (B8 question round): tokens are encrypted at rest
 * with AES-256-GCM using a 32-byte key held ONLY in the
 * GOOGLE_TOKEN_ENCRYPTION_KEY environment variable (base64). GCP KMS envelope
 * encryption is the documented production swap (BACKEND_ARCHITECTURE §14
 * "KMS/envelope choice at B8"); the ciphertext layout carries `keyVersion` so
 * a future key rotation/KMS migration can decrypt old rows.
 *
 * Fail-closed rules (spec §6.4–§6.6) — no exceptions:
 * - missing/invalid key throws SERVER_ENV_MISSING / SERVER_ENV_INVALID naming
 *   the VARIABLE only (never the value, never a snippet of it);
 * - there is no plaintext fallback, no hardcoded/dev-default key, no
 *   reversible obfuscation;
 * - decryption is authenticated: wrong key or tampered ciphertext throws
 *   SECRET_OPEN_FAILED instead of returning garbage;
 * - this module is server-only by import discipline (lib/server/**); the key
 *   never reaches the database, logs, audit rows, or the browser.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Key version written into every sealed row (rotation marker for §6.3). */
export const TOKEN_KEY_VERSION = 1;

const KEY_BYTES = 32;
const NONCE_BYTES = 12; // GCM standard IV length
const TAG_BYTES = 16;

export interface SealedSecret {
  /** base64 ciphertext */
  cipher: string;
  /** base64 12-byte nonce (unique per seal) */
  nonce: string;
  /** base64 16-byte authentication tag */
  tag: string;
  keyVersion: number;
}

/**
 * Read and validate the encryption key. Throws with the variable NAME only.
 * Injectable `source` keeps tests off the real process env (B3 env.ts pattern).
 */
export function loadTokenKey(source: Record<string, string | undefined> = process.env): Buffer {
  const raw = source.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "SERVER_ENV_MISSING: required variable GOOGLE_TOKEN_ENCRYPTION_KEY is not set (see .env.example).",
    );
  }
  // Node's base64 decoder is lenient (never throws on garbage), so the
  // decoded-length check below is the real validator.
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      "SERVER_ENV_INVALID: variable GOOGLE_TOKEN_ENCRYPTION_KEY must be base64 that decodes to exactly 32 bytes.",
    );
  }
  return key;
}

/** Encrypt one secret. Fresh random nonce every call (safe to seal twice). */
export function sealSecret(plaintext: string, key: Buffer): SealedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    cipher: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion: TOKEN_KEY_VERSION,
  };
}

/**
 * Decrypt one secret. Authenticated decryption: wrong key, wrong parts, or
 * tampered ciphertext all throw SECRET_OPEN_FAILED (fail closed — callers
 * must treat the throw as "credentials unreadable", never as "empty").
 */
export function openSecret(
  sealed: Pick<SealedSecret, "cipher" | "nonce" | "tag">,
  key: Buffer,
): string {
  if (
    typeof sealed.cipher !== "string" ||
    typeof sealed.nonce !== "string" ||
    typeof sealed.tag !== "string"
  ) {
    throw new Error("SECRET_OPEN_FAILED: sealed secret is malformed.");
  }
  try {
    const nonce = Buffer.from(sealed.nonce, "base64");
    const tag = Buffer.from(sealed.tag, "base64");
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new Error("bad length");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.cipher, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new Error("SECRET_OPEN_FAILED: ciphertext failed authentication (wrong key or tampered data).");
  }
}
