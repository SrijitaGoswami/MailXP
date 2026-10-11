/**
 * Auth email dispatch (Phase B4) — DEV-MODE ONLY, user decision 2026-10-10.
 *
 * Context: the B1 contract left the delivery mechanism OPEN for B4
 * ("dev-mode link logged/surfaced, documented in B4 report") and
 * phase_b4 §7 forbids inventing a production email system. The owner
 * approved: outside production, register/resend/forgot responses may include
 * a `devDelivery` field carrying the raw token so the flows can be exercised
 * end-to-end locally (POST the token to verify-email / password/reset).
 *
 * Guarantees:
 * - Production (NODE_ENV === "production"): buildDevDelivery returns null —
 *   tokens are generated and stored exactly as in dev, but NEVER appear in
 *   any response. No provider is configured in B4, so production
 *   verification/reset delivery is BLOCKED until a later approved phase;
 *   this is reported, not faked.
 * - No token is ever written to logs (phase_b4 §6/§7) — surfacing happens
 *   only in the response body of the request that minted the token.
 * - No email is sent by this module; there is deliberately no "pretend send".
 */

export type AuthEmailPurpose = "email_verification" | "password_reset";

export interface DevDelivery {
  purpose: AuthEmailPurpose;
  token: string;
  expiresAt: string;
}

export function devDeliveryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production";
}

/** Dev-only response attachment; null in production (never surfaced there). */
export function buildDevDelivery(
  purpose: AuthEmailPurpose,
  token: string,
  expiresAt: Date,
  env: Record<string, string | undefined> = process.env,
): DevDelivery | null {
  if (!devDeliveryEnabled(env)) return null;
  return { purpose, token, expiresAt: expiresAt.toISOString() };
}
