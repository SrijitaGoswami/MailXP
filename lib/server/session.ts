/**
 * Sessions and the session cookie (Phase B4).
 *
 * Cookie `mailxp.session`: httpOnly, SameSite=Lax, path=/, Secure in
 * production, 30-day sliding expiry (B1 §1.2 — CONFIRMED).
 * - Opaque 256-bit token (base64url of crypto.randomBytes(32)); only its
 *   SHA-256 hash is persisted (Session.tokenHash, unique).
 * - Sliding renewal is BOUNDED: lastSeenAt/expiresAt are written at most once
 *   per session per SESSION_TOUCH_INTERVAL_MS, so routine traffic does not
 *   generate a database write per request.
 * - Identity always comes from the server-side session row, never from a
 *   caller-supplied id.
 * - Cookie reading is done from the raw header (not next/headers) so route
 *   logic is unit-testable outside a Next request scope; Set-Cookie goes
 *   through the NextResponse cookie API (typed, correct attribute encoding).
 */

import { createHash, randomBytes } from "node:crypto";
import type { Prisma, Session, User } from "@prisma/client";
import { CODES, errorResponse } from "./http";
import type { NextResponse } from "next/server";

export const SESSION_COOKIE = "mailxp.session";
/** 30-day sliding expiry target. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** At most one sliding-renewal write per session per hour. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export function isProduction(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "production";
}

/** 256-bit opaque session token — high entropy, no structure to guess. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sessions are high-entropy random values: a fast digest is the right hash. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
}

/** Pure builder so tests can assert prod/dev attributes without touching env. */
export function sessionCookieOptions(secure: boolean): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Extract the raw session token from the request's Cookie header. */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** PrismaClient is structurally assignable to TransactionClient. */
type Db = Prisma.TransactionClient;

export async function createSession(
  client: Db,
  userId: string,
  now: number = Date.now(),
): Promise<{ token: string; session: Session }> {
  const token = generateSessionToken();
  const session = await client.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId,
      lastSeenAt: new Date(now),
      expiresAt: new Date(now + SESSION_TTL_MS),
    },
  });
  return { token, session };
}

export type SessionFailure = "UNAUTHENTICATED" | "SESSION_EXPIRED";

export type SessionOutcome =
  | { ok: true; session: Session; user: User }
  | { ok: false; reason: SessionFailure };

/**
 * Resolve the session for a request. Failure codes follow B1 §1.2:
 * no cookie → UNAUTHENTICATED; cookie present but unknown/revoked/expired →
 * SESSION_EXPIRED (the UI uses the latter to prompt silent re-login).
 */
export async function loadSession(
  client: Db,
  request: Request,
  now: number = Date.now(),
): Promise<SessionOutcome> {
  const raw = readSessionCookie(request);
  if (raw === null) return { ok: false, reason: "UNAUTHENTICATED" };

  const found = await client.session.findUnique({
    where: { tokenHash: hashSessionToken(raw) },
    include: { user: true },
  });
  if (!found || found.revokedAt !== null || found.expiresAt.getTime() <= now) {
    return { ok: false, reason: "SESSION_EXPIRED" };
  }

  let current: Session & { user: User } = found;
  if (now - found.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    current = await client.session.update({
      where: { id: found.id },
      data: { lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) },
      include: { user: true },
    });
  }
  return { ok: true, session: current, user: current.user };
}

/** Revoke one session atomically; returns false when already dead. */
export async function revokeSession(client: Db, sessionId: string, now: number = Date.now()): Promise<boolean> {
  const result = await client.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(now) },
  });
  return result.count > 0;
}

/** Revoke ALL active sessions for a user (password reset / deletion). */
export async function revokeAllSessions(client: Db, userId: string, now: number = Date.now()): Promise<number> {
  const result = await client.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(now) },
  });
  return result.count;
}

/** Minimal public player projection (B1 §1.9 — nothing internal leaks). */
export interface PlayerDto {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

export function toPlayer(user: User): PlayerDto {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

/** 401 with the correct B1 code for a failed session resolution. */
export function sessionErrorResponse(reason: SessionFailure, requestId: string): NextResponse {
  return reason === "UNAUTHENTICATED"
    ? errorResponse(401, CODES.UNAUTHENTICATED, "Authentication required.", requestId)
    : errorResponse(401, CODES.SESSION_EXPIRED, "Your session has expired. Please sign in again.", requestId);
}

/** Attach the session cookie with production-aware attributes (B1 §1.2). */
export function applySessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(isProduction()));
}

/** Clear the session cookie using matching attributes (logout / deletion). */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(isProduction()), maxAge: 0 });
}
