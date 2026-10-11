/**
 * Email verification / password reset tokens (Phase B4).
 *
 * B1-confirmed lifecycle: high-entropy random tokens, SHA-256 hash at rest,
 * single-use, 24 h (verification) / 1 h (reset) expiry. Raw tokens exist only
 * in the dispatch path — never in database rows, logs, or production responses.
 * Consumption is ATOMIC (guarded update on consumedAt IS NULL) so replayed or
 * concurrently-submitted tokens can be redeemed exactly once.
 * Issuing a new token of a purpose supersedes (marks consumed) prior
 * outstanding ones — contract: "a new token supersedes prior outstanding ones".
 */

import { createHash, randomBytes } from "node:crypto";
import type { Prisma, TokenPurpose } from "@prisma/client";

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export function generateAuthToken(): string {
  return randomBytes(32).toString("base64url"); // 256-bit opaque
}

export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function ttlFor(purpose: TokenPurpose): number {
  return purpose === "EMAIL_VERIFICATION" ? EMAIL_VERIFICATION_TTL_MS : PASSWORD_RESET_TTL_MS;
}

export async function issueToken(
  client: Prisma.TransactionClient,
  userId: string,
  purpose: TokenPurpose,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: Date }> {
  // Supersede any outstanding tokens of this purpose for this user.
  await client.authToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: new Date(now) },
  });
  const token = generateAuthToken();
  const expiresAt = new Date(now + ttlFor(purpose));
  await client.authToken.create({
    data: { userId, purpose, tokenHash: hashAuthToken(token), expiresAt },
  });
  return { token, expiresAt };
}

export type ConsumeOutcome = { ok: true; userId: string; tokenId: string } | { ok: false };

/**
 * Validate + atomically claim a token. Safe under replay/concurrency: the
 * guarded update guarantees a single consumer wins; everyone else gets the
 * same { ok: false } the route turns into 404 NOT_FOUND (no reason leakage).
 */
export async function consumeToken(
  client: Prisma.TransactionClient,
  rawToken: unknown,
  purpose: TokenPurpose,
  now: number = Date.now(),
): Promise<ConsumeOutcome> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return { ok: false };
  const row = await client.authToken.findUnique({ where: { tokenHash: hashAuthToken(rawToken) } });
  if (!row || row.purpose !== purpose || row.consumedAt !== null || row.expiresAt.getTime() <= now) {
    return { ok: false };
  }
  const claimed = await client.authToken.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date(now) },
  });
  if (claimed.count !== 1) return { ok: false }; // lost a replay race
  return { ok: true, userId: row.userId, tokenId: row.id };
}
