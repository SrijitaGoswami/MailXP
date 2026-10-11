/**
 * Password hashing (Phase B4).
 *
 * Library: bcryptjs 3.0.3 (user decision 2026-10-10) — the real bcrypt
 * algorithm in pure JavaScript: ships its own TypeScript types, has NO install
 * script (immune to this machine's npm allow-scripts gate), no native toolchain
 * or prebuild compatibility risk on Node 24 / Windows, actively maintained
 * (v3.0.3, Apr 2026). The plan's "(bcrypt)" note named the algorithm class;
 * bcryptjs implements exactly that without the native-module risk.
 *
 * Work factor: cost 10 (bcrypt's own default) — a deliberate balance for a
 * single-process local/Cloud Run service; raising it later is a one-line
 * change (old hashes keep verifying at their embedded cost).
 *
 * Known limitation, documented honestly: the bcrypt algorithm reads at most
 * 72 bytes of input, so passwords beyond that contribute no extra entropy
 * (the 128-char policy limit still applies for UX/compatibility).
 */

import { randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";

export const BCRYPT_COST = 10;

export function hashPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_COST);
}

/** Never throws: a malformed stored hash verifies as false. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    return await compare(password, storedHash);
  } catch {
    return false;
  }
}

// Uniform-timing burn for login attempts on UNKNOWN emails: performs the same
// bcrypt.compare work as a real (failed) password check so response timing
// does not reveal account existence.
let dummyHash: string | null = null;

export async function burnPasswordCheck(password: string): Promise<void> {
  if (dummyHash === null) {
    // Random target: no password can ever match it (cost-10, computed once).
    dummyHash = await hash(`burn-${randomUUID()}`, BCRYPT_COST);
  }
  await compare(password, dummyHash);
}
