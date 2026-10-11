/**
 * Google OAuth authorization-code flow — domain logic (Phase B8, spec §4/§6).
 *
 * Scope of this module (phase_b8.md §3): connect/link only. No Gmail, no
 * Calendar, no Gemini, no send/draft/archive — those are B9–B12.
 *
 * Flow contracts this file implements:
 * - State: cryptographically random, stored ONLY as a SHA-256 hash, bound to
 *   the initiating user + session, 10-minute expiry, consumed exactly once via
 *   a guarded update (same atomic pattern as AuthToken).
 * - Identity: comes exclusively from Google's userinfo endpoint using an
 *   access token obtained server-side from the code exchange — NEVER from
 *   browser-supplied fields — and the provider must report email_verified.
 * - Linking: an identity (googleSub) already linked to ANOTHER player is a
 *   conflict unless that player explicitly `released` it (contract §7.1 +
 *   MASTER §3.2 transfer rule). Links only ever attach to the session user.
 * - Tokens: only the refresh token is persisted, sealed with secretBox
 *   (AES-256-GCM); granted scopes are stored as returned by Google.
 * - All Google endpoints are injected-fetch friendly so tests never hit the
 *   network, and provider error BODIES are never included in thrown messages
 *   (they could contain token material — spec §4.10).
 */

import { createHash, randomBytes } from "node:crypto";
import type { GoogleConnection, OAuthState, Prisma } from "@prisma/client";
import { hashPassword } from "./password";
import { DEFAULT_PROFILE_PREFS } from "./preferences";
import { loadTokenKey, openSecret, sealSecret, type SealedSecret } from "./secretBox";

// ---------------------------------------------------------------- config ---

/** 10 minutes (spec §4.2 "short expiry — 10 minutes unless docs say else"). */
export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Least-privilege scopes (user decision 2026-10-10, B8 question round):
 * - `openid email`: establish Google identity + require verified email.
 * - `gmail.modify`: read (B9/B10) and draft/send/label/archive (B11) under a
 *   single consent — the product workflow approved in MASTER §4/§8. NOT broad:
 *   no full mailbox access, no permanent-delete scope. NO Calendar scopes
 *   (spec §5 forbids them in B8).
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: Buffer;
}

export interface GoogleConfigStatus {
  configured: boolean;
  /** Variable NAMES only — never values (spec §9). */
  missing: string[];
}

/** Presence/format check without throwing — for `google.status` responses. */
export function googleConfigStatus(source: Record<string, string | undefined> = process.env): GoogleConfigStatus {
  const missing: string[] = [];
  if (!source.GOOGLE_CLIENT_ID || source.GOOGLE_CLIENT_ID.trim() === "") missing.push("GOOGLE_CLIENT_ID");
  if (!source.GOOGLE_CLIENT_SECRET || source.GOOGLE_CLIENT_SECRET.trim() === "") missing.push("GOOGLE_CLIENT_SECRET");
  if (!source.GOOGLE_REDIRECT_URI || source.GOOGLE_REDIRECT_URI.trim() === "") missing.push("GOOGLE_REDIRECT_URI");
  try {
    loadTokenKey(source);
  } catch {
    missing.push("GOOGLE_TOKEN_ENCRYPTION_KEY");
  }
  return { configured: missing.length === 0, missing };
}

/**
 * Full config for flow steps. Throws SERVER_ENV_* (name only) when anything
 * is missing/invalid — the route maps that to a safe 503 diagnostic (§9:
 * "fail safely with a clear non-secret diagnostic", never a plaintext
 * fallback of any kind).
 */
export function requireGoogleConfig(source: Record<string, string | undefined> = process.env): GoogleOAuthConfig {
  const status = googleConfigStatus(source);
  if (!status.configured) {
    throw new Error(
      `SERVER_ENV_MISSING: Google OAuth is not configured (missing or invalid: ${status.missing.join(", ")}). See .env.example.`,
    );
  }
  return {
    clientId: (source.GOOGLE_CLIENT_ID as string).trim(),
    clientSecret: (source.GOOGLE_CLIENT_SECRET as string).trim(),
    redirectUri: (source.GOOGLE_REDIRECT_URI as string).trim(),
    encryptionKey: loadTokenKey(source),
  };
}

// ----------------------------------------------------------------- state ---

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url"); // 256-bit opaque
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex"); // high-entropy → fast digest
}

/** PrismaClient is structurally assignable to TransactionClient (session.ts). */
type Db = Prisma.TransactionClient;

export interface StateIssueInput {
  /** Null for B8a `signin` states — a signed-out visitor has no user yet. */
  userId: string | null;
  /** Null for `signin` states (same reason). */
  sessionId: string | null;
  /** "connect" | "reconnect:<accountId>" | "signin" */
  intent: string;
}

/** Create one state row (hash only) and return the RAW value for the URL. */
export async function createOAuthState(
  client: Prisma.TransactionClient,
  input: StateIssueInput,
  now: number = Date.now(),
): Promise<string> {
  const raw = generateOAuthState();
  await client.oAuthState.create({
    data: {
      stateHash: hashOAuthState(raw),
      userId: input.userId,
      sessionId: input.sessionId,
      intent: input.intent,
      expiresAt: new Date(now + GOOGLE_OAUTH_STATE_TTL_MS),
      createdAt: new Date(now),
    },
  });
  return raw;
}

export type StateFailure = "missing" | "invalid";
export type ConsumeOutcome =
  | { ok: true; row: OAuthState }
  | { ok: false; reason: StateFailure };

/**
 * Validate + atomically claim a state (spec §4.4 "validate and consume state
 * exactly once before exchanging the code").
 * - binding mismatch (wrong user OR wrong session) → NOT consumed (the
 *   caller has no right to burn someone else's state) and reported `invalid`;
 * - expired/replayed/lost-claim-race → `expired` folded into `invalid` so the
 *   redirect carries one generic code (no oracle for valid state values).
 */
export async function consumeOAuthState(
  client: Db,
  rawState: string,
  bound: { userId: string; sessionId: string },
  now: number = Date.now(),
): Promise<ConsumeOutcome> {
  if (typeof rawState !== "string" || rawState.length === 0) return { ok: false, reason: "missing" };
  const row = await client.oAuthState.findUnique({ where: { stateHash: hashOAuthState(rawState) } });
  if (!row) return { ok: false, reason: "invalid" };
  if (row.userId !== bound.userId || row.sessionId !== bound.sessionId) return { ok: false, reason: "invalid" };
  if (row.consumedAt !== null || row.expiresAt.getTime() <= now) return { ok: false, reason: "invalid" };

  const claimed = await client.oAuthState.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date(now) } },
    data: { consumedAt: new Date(now) },
  });
  if (claimed.count !== 1) return { ok: false, reason: "invalid" }; // lost a replay race
  return { ok: true, row: { ...row, consumedAt: new Date(now) } };
}

/** Read-only hash lookup — lets the callback pick the branch before consuming. */
export async function peekOAuthState(client: Db, rawState: string): Promise<OAuthState | null> {
  if (typeof rawState !== "string" || rawState.length === 0) return null;
  return client.oAuthState.findUnique({ where: { stateHash: hashOAuthState(rawState) } });
}

/**
 * B8a — consume an UNBOUND `signin` state exactly once. The 256-bit random
 * value IS the CSRF defense here (no session exists to bind to): only the
 * browser that started the flow receives it via the Google redirect. A state
 * that is bound to a user/session (link/reconnect) is refused untouched —
 * the two intent families can never be consumed across branches.
 */
export async function consumeSignInState(
  client: Db,
  rawState: string,
  now: number = Date.now(),
): Promise<ConsumeOutcome> {
  if (typeof rawState !== "string" || rawState.length === 0) return { ok: false, reason: "missing" };
  const row = await client.oAuthState.findUnique({ where: { stateHash: hashOAuthState(rawState) } });
  if (!row) return { ok: false, reason: "invalid" };
  if (row.intent !== "signin") return { ok: false, reason: "invalid" };
  // A signin state is only valid when NEVER bound (defense in depth).
  if (row.userId !== null || row.sessionId !== null) return { ok: false, reason: "invalid" };
  if (row.consumedAt !== null || row.expiresAt.getTime() <= now) return { ok: false, reason: "invalid" };

  const claimed = await client.oAuthState.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date(now) } },
    data: { consumedAt: new Date(now) },
  });
  if (claimed.count !== 1) return { ok: false, reason: "invalid" };
  return { ok: true, row: { ...row, consumedAt: new Date(now) } };
}

// ------------------------------------------------------------ auth URL ---

/**
 * Google authorization URL (authorization-code flow). `access_type=offline` +
 * `prompt=consent` guarantee a refresh token on every (re)connect so B9 can
 * always exchange it. The redirect URI is the SERVER-configured one — never
 * browser-supplied (spec §4.3).
 */
export function buildAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

// --------------------------------------------------- provider round-trips ---

/** Safe category label — provider response bodies are NEVER part of messages. */
export class GoogleProviderError extends Error {
  readonly category: string;
  constructor(category: string) {
    super(`PROVIDER_${category}`);
    this.name = "GoogleProviderError";
    this.category = category;
  }
}

export class GoogleUnverifiedEmailError extends Error {
  constructor() {
    super("PROVIDER_unverified_email");
    this.name = "GoogleUnverifiedEmailError";
  }
}

type FetchFn = typeof fetch;

export interface CodeExchangeResult {
  /**
   * Short-lived access token — used IMMEDIATELY for the userinfo lookup and
   * never persisted (spec §6: access tokens stored only if required; B8
   * requires only the refresh token for B9's later exchange).
   */
  accessToken: string;
  /** Null when consent returned no offline token (representable, spec §6). */
  refreshToken: string | null;
  /** Space-separated scopes ACTUALLY granted (spec §6.5). */
  grantedScopes: string;
}

/** Server-side code exchange (spec §4.4). Throws GoogleProviderError only. */
export async function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
  fetchFn: FetchFn = fetch,
): Promise<CodeExchangeResult> {
  let response: Response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
  } catch {
    throw new GoogleProviderError("token_exchange_network");
  }
  if (!response.ok) throw new GoogleProviderError("token_exchange");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleProviderError("token_exchange_shape");
  }
  const body = payload as { access_token?: unknown; refresh_token?: unknown; scope?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new GoogleProviderError("token_exchange_shape");
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : null,
    grantedScopes: typeof body.scope === "string" ? body.scope : "",
  };
}

export interface GoogleIdentity {
  /** Stable Google subject — the linkage key (unique in the database). */
  sub: string;
  /** Verified provider email (lowercased/trimmed before storage). */
  email: string;
}

/**
 * Trusted identity lookup: the userinfo response is obtained with the access
 * token minted from OUR code exchange, so it is provider-attested — browser
 * input plays no part (spec §4.5). Rejects unverified emails (§4.6).
 */
export async function fetchGoogleIdentity(
  accessToken: string,
  fetchFn: FetchFn = fetch,
): Promise<GoogleIdentity> {
  let response: Response;
  try {
    response = await fetchFn(GOOGLE_USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new GoogleProviderError("userinfo_network");
  }
  if (!response.ok) throw new GoogleProviderError("userinfo");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleProviderError("userinfo_shape");
  }
  const profile = payload as { sub?: unknown; email?: unknown; email_verified?: unknown };
  if (typeof profile.sub !== "string" || profile.sub === "" || typeof profile.email !== "string" || profile.email === "") {
    throw new GoogleProviderError("userinfo_shape");
  }
  if (profile.email_verified !== true) throw new GoogleUnverifiedEmailError();
  return { sub: profile.sub, email: profile.email.trim().toLowerCase() };
}

/**
 * Best-effort remote revocation (spec §6: "revoke them remotely where
 * supported, but never claim remote revocation succeeded unless confirmed").
 * Returns true ONLY on a confirmed 2xx from Google; failures are swallowed
 * (local deletion always proceeds) and logged by the caller as a category.
 */
export async function revokeGoogleToken(token: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  try {
    const response = await fetchFn(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- linking ---

export type LinkOutcome = "linked" | "reconnected" | "transferred";
export type LinkFailure = "conflict";

export interface LinkInput {
  userId: string;
  identity: GoogleIdentity;
  /** Raw refresh token from the exchange (null = consent gave none). */
  refreshToken: string | null;
  grantedScopes: string;
  encryptionKey: Buffer;
}

export type LinkResult =
  | { ok: true; account: GoogleConnection; outcome: LinkOutcome }
  | { ok: false; reason: LinkFailure };

function sealedTokenData(
  refreshToken: string | null,
  encryptionKey: Buffer,
): Partial<Pick<GoogleConnection, "refreshTokenCipher" | "refreshTokenNonce" | "refreshTokenTag" | "refreshTokenKeyVersion">> {
  if (refreshToken === null) return {}; // no new material → keep existing / stay null
  const sealed: SealedSecret = sealSecret(refreshToken, encryptionKey);
  return {
    refreshTokenCipher: sealed.cipher,
    refreshTokenNonce: sealed.nonce,
    refreshTokenTag: sealed.tag,
    refreshTokenKeyVersion: sealed.keyVersion,
  };
}

/**
 * Link (or re-link) a Google identity to the SESSION user — inside the
 * caller's transaction so the link + audit commit together.
 *
 * Policy (spec §4.7–§4.8, MASTER §3.2):
 * - identity unknown → create (outcome `linked`);
 * - identity already THIS user's → refresh credentials (outcome `reconnected`);
 * - identity held by ANOTHER user with status=connected → `conflict`, no
 *   transfer, no silent sign-in (§4.8);
 * - identity held by another user with status=released → explicit transfer
 *   (outcome `transferred`) — allowed only because release is the documented
 *   owner-authorization step of the mailbox-transfer rule.
 */
export async function linkGoogleIdentity(
  client: Prisma.TransactionClient,
  input: LinkInput,
  now: number = Date.now(),
): Promise<LinkResult> {
  const existing = await client.googleConnection.findUnique({ where: { googleSub: input.identity.sub } });
  const tokenData = sealedTokenData(input.refreshToken, input.encryptionKey);

  // B8b (phase_b8b.md §3): one connected mailbox per MailXP user. If THIS
  // user already holds a DIFFERENT connected googleSub, refuse to add a
  // second one — the player must explicitly release/disconnect first
  // ("Switch Gmail"). Runs before any create so we never race the DB index
  // on the happy path. (Released historical rows do NOT block: they carry no
  // credentials and are the sanctioned transfer precondition.)
  if (existing === null || existing.userId !== input.userId) {
    const current = await client.googleConnection.findFirst({
      where: { userId: input.userId, status: "connected" },
      select: { id: true, googleSub: true },
    });
    if (current !== null && current.googleSub !== input.identity.sub) {
      return { ok: false, reason: "conflict" };
    }
  }

  if (!existing) {
    try {
      const account = await client.googleConnection.create({
        data: {
          userId: input.userId,
          googleSub: input.identity.sub,
          email: input.identity.email,
          scopes: input.grantedScopes,
          ...tokenData,
          connectedAt: new Date(now),
          updatedAt: new Date(now),
        },
      });
      return { ok: true, account, outcome: "linked" };
    } catch (error) {
      // B8b race guard: two concurrent callbacks both passed the pre-check
      // above and tried to create the user's first/second connected row —
      // the partial unique index (or unique googleSub) rejected the loser.
      // Map to a safe conflict; never surface SQL/Prisma details (§5).
      if ((error as { code?: string }).code === "P2002") {
        return { ok: false, reason: "conflict" };
      }
      throw error;
    }
  }

  if (existing.userId === input.userId) {
    const account = await client.googleConnection.update({
      where: { id: existing.id },
      data: {
        status: "connected",
        email: input.identity.email, // freshest verified provider email
        scopes: input.grantedScopes,
        ...tokenData,
      },
    });
    return { ok: true, account, outcome: "reconnected" };
  }

  if (existing.status === "released") {
    const account = await client.googleConnection.update({
      where: { id: existing.id },
      data: {
        userId: input.userId, // transfer to the new owner (release authorized it)
        status: "connected",
        email: input.identity.email,
        scopes: input.grantedScopes,
        ...tokenData,
      },
    });
    return { ok: true, account, outcome: "transferred" };
  }

  return { ok: false, reason: "conflict" };
}

// --------------------------------------------------- B8a: sign-in resolve ---

/** Thrown inside the callback transaction to roll EVERYTHING back on conflict. */
export class SignInLinkConflictError extends Error {
  constructor() {
    super("GOOGLE_SIGNIN_LINK_CONFLICT");
    this.name = "SignInLinkConflictError";
  }
}

export type SignInDisposition =
  /** Google sub was already connected → that player signs in. */
  | "linked"
  /** Email matched an existing MailXP account → it signs in. */
  | "existing"
  /** No account at all → one is created (email verified by Google). */
  | "created";

export type SignInResolution =
  | { ok: true; userId: string; disposition: SignInDisposition }
  | { ok: false; reason: "account_disabled" };

/**
 * B8a — locate-or-create the MailXP account for a provider-attested Google
 * identity (phase_b8a.md §3.3). Authority order:
 *  1. googleSub connected → THAT player (stable subject beats email coinci-
 *     dence; covers a changed Google email without ever switching players);
 *  2. verified email matches an existing account → it is used as-is (the
 *     player chose "Continue with Google" with their own address; deletion-
 *     pending accounts are refused, mirroring auth.login);
 *  3. otherwise a new account is created exactly like auth.register except
 *     the password is a bcrypt hash of a DISCARDED random secret (password
 *     login is impossible by construction; B4 forgot-password remains the
 *     documented path to set one) and the email is born verified — Google
 *     already asserted it on the consent screen.
 * Runs INSIDE the caller's transaction: a create that later fails (link
 * conflict) rolls back with everything else.
 */
export async function resolveSignInTarget(
  client: Prisma.TransactionClient,
  identity: GoogleIdentity,
  now: number = Date.now(),
): Promise<SignInResolution> {
  const connection = await client.googleConnection.findUnique({ where: { googleSub: identity.sub } });
  if (connection !== null && connection.status === "connected") {
    const linkedUser = await client.user.findUnique({ where: { id: connection.userId } });
    // Deletion disables every entrance, including the stable-subject fast
    // path. Never issue a fresh session to a player already being erased.
    if (linkedUser === null || linkedUser.deletionRequestedAt !== null) {
      return { ok: false, reason: "account_disabled" };
    }
    return { ok: true, userId: connection.userId, disposition: "linked" };
  }

  const existing = await client.user.findUnique({ where: { email: identity.email } });
  if (existing !== null) {
    if (existing.deletionRequestedAt !== null) return { ok: false, reason: "account_disabled" };
    return { ok: true, userId: existing.id, disposition: "existing" };
  }

  try {
    const secret = randomBytes(32).toString("hex"); // discarded after hashing
    const passwordHash = await hashPassword(secret);
    const user = await client.user.create({
      data: { email: identity.email, passwordHash, emailVerifiedAt: new Date(now) },
    });
    await client.playerProfile.create({ data: { userId: user.id, prefs: DEFAULT_PROFILE_PREFS } });
    return { ok: true, userId: user.id, disposition: "created" };
  } catch (error) {
    // Concurrent sign-ins for the same fresh email: the loser re-resolves.
    if ((error as { code?: string }).code === "P2002") {
      const raced = await client.user.findUnique({ where: { email: identity.email } });
      if (raced !== null && raced.deletionRequestedAt !== null) return { ok: false, reason: "account_disabled" };
      if (raced !== null) return { ok: true, userId: raced.id, disposition: "existing" };
    }
    throw error;
  }
}

// ------------------------------------------------------------------ DTOs ---

export interface GoogleAccountDto {
  id: string;
  email: string;
  status: "connected" | "released";
  scopes: string[];
  connectedAt: string;
}

/**
 * Public projection. Built field-by-field (never a spread of the row) so token
 * material cannot leak into responses even if the schema grows (§4.10).
 */
export function toGoogleAccountDto(row: GoogleConnection): GoogleAccountDto {
  return {
    id: row.id,
    email: row.email,
    status: row.status === "released" ? "released" : "connected",
    scopes: row.scopes === "" ? [] : row.scopes.split(" ").filter((scope) => scope !== ""),
    connectedAt: row.connectedAt.toISOString(),
  };
}

/** Open a stored refresh token (throws SECRET_OPEN_FAILED if unreadable). */
export function openStoredRefreshToken(row: GoogleConnection, encryptionKey: Buffer): string | null {
  if (row.refreshTokenCipher === null || row.refreshTokenNonce === null || row.refreshTokenTag === null) {
    return null;
  }
  return openSecret(
    { cipher: row.refreshTokenCipher, nonce: row.refreshTokenNonce, tag: row.refreshTokenTag },
    encryptionKey,
  );
}
