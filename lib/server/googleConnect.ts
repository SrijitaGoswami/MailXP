/**
 * "Start Google connection" domain step (Phase B8, spec §4.1–§4.3 + §8).
 *
 * Shared by google.connectStart (fresh connect) and google.accountReconnect
 * (re-consent for an existing row) so both apply the SAME rules:
 *  - configuration is checked FIRST and reported as variable NAMES only —
 *    a missing/invalid setup fails safely before any state is minted (§9);
 *  - an explicit `accountId` must exist AND belong to the caller (owner
 *    re-validated here, defense in depth on top of the route's own check);
 *  - a fresh random state is stored hash-only, bound to user + session,
 *    10-minute expiry; the auth URL uses the SERVER-configured redirect URI.
 *
 * Failures are returned as data (no NextResponse here) so routes map them to
 * the contract envelope themselves.
 */

import type { Prisma } from "@prisma/client";
import { buildAuthUrl, createOAuthState, googleConfigStatus, requireGoogleConfig } from "./googleOAuth";

export interface ConnectStartInput {
  userId: string;
  sessionId: string;
  /** Existing account to re-consent (already owner-checked by the route). */
  accountId?: string;
}

export type ConnectStartOutcome =
  | { ok: true; authUrl: string }
  | { ok: false; reason: "config"; missing: string[] }
  | { ok: false; reason: "account_not_found" };

export type StartIntent = "link" | "signin";

/** B8 back-compat shape for the accountId-only parse (connect/reconnect). */
export type BodyParseResult =
  | { ok: true; accountId: string | undefined }
  | { ok: false; field: string; message: string };

/** beginGoogleSignIn can only fail on configuration (no account involved). */
export type SignInStartOutcome =
  | { ok: true; authUrl: string }
  | { ok: false; reason: "config"; missing: string[] };

export type StartBodyParseResult =
  | { ok: true; intent: StartIntent; accountId: string | undefined }
  | { ok: false; field: string; message: string };

/**
 * Tolerant body parse for the B8a start route: an EMPTY or absent body means
 * "link, fresh connect" (B8 behavior unchanged). The optional `intent` must
 * be exactly "link" or "signin"; `accountId` (reconnect target) is invalid
 * together with intent:"signin". Unknown keys are ignored — and, as B8 §11
 * proved, no browser-supplied identity field can ever establish a link.
 */
export async function parseStartBody(request: Request): Promise<StartBodyParseResult> {
  const text = await request.text();
  if (text.trim() === "") return { ok: true, intent: "link", accountId: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, field: "body", message: "Malformed JSON body." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, field: "body", message: "Body must be a JSON object." };
  }
  const body = parsed as Record<string, unknown>;

  let intent: StartIntent = "link";
  if (body.intent !== undefined) {
    if (body.intent !== "link" && body.intent !== "signin") {
      return { ok: false, field: "intent", message: 'intent must be "link" or "signin".' };
    }
    intent = body.intent;
  }

  let accountId: string | undefined;
  if (body.accountId !== undefined) {
    if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
      return { ok: false, field: "accountId", message: "accountId must be a non-empty string." };
    }
    if (intent === "signin") {
      return { ok: false, field: "accountId", message: "accountId is not valid with intent \"signin\"." };
    }
    accountId = body.accountId;
  }
  return { ok: true, intent, accountId };
}

/**
 * Back-compat wrapper: B8's connect/reconnect routes keep their original
 * tolerant accountId-only parse (parseStartBody is a superset; both are
 * exercised by the B8/B8a test suites).
 */
export async function parseConnectBody(request: Request): Promise<BodyParseResult> {
  const parsed = await parseStartBody(request);
  if (!parsed.ok) return { ok: false, field: parsed.field, message: parsed.message };
  return { ok: true, accountId: parsed.accountId };
}

/**
 * B8a — start the "Continue with Google" sign-in flow for a SIGNED-OUT
 * visitor (phase_b8a.md §3.2). Same rules as beginGoogleConnect minus every
 * session-bound step: config is checked first (names only), the minted state
 * carries NO user/session binding, and the consent URL uses the
 * SERVER-configured redirect URI.
 */
export async function beginGoogleSignIn(
  db: Prisma.TransactionClient,
  now: number = Date.now(),
): Promise<SignInStartOutcome> {
  const status = googleConfigStatus();
  if (!status.configured) return { ok: false, reason: "config", missing: status.missing };

  const config = requireGoogleConfig();
  const rawState = await createOAuthState(db, { userId: null, sessionId: null, intent: "signin" }, now);
  return { ok: true, authUrl: buildAuthUrl(config, rawState) };
}

export async function beginGoogleConnect(
  db: Prisma.TransactionClient,
  input: ConnectStartInput,
  now: number = Date.now(),
): Promise<ConnectStartOutcome> {
  const status = googleConfigStatus();
  if (!status.configured) return { ok: false, reason: "config", missing: status.missing };

  if (input.accountId !== undefined) {
    const account = await db.googleConnection.findUnique({ where: { id: input.accountId } });
    if (!account || account.userId !== input.userId) return { ok: false, reason: "account_not_found" };
  }

  // Throws SERVER_ENV_* only if status lied (race on env) — routes catch via
  // the shared handle() wrapper, which sanitizes to 500. Not reachable with a
  // consistent env.
  const config = requireGoogleConfig();
  const intent = input.accountId !== undefined ? `reconnect:${input.accountId}` : "connect";
  const rawState = await createOAuthState(
    db,
    { userId: input.userId, sessionId: input.sessionId, intent },
    now,
  );
  return { ok: true, authUrl: buildAuthUrl(config, rawState) };
}
