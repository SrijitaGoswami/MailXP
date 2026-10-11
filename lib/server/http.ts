/**
 * Shared HTTP helpers for /api/v1 route handlers (Phase B4).
 *
 * - Reuses the B3 request-ID policy (safe inbound X-Request-Id or fresh UUID).
 * - Emits the binding B1 error envelope (docs/BACKEND_API_CONTRACT.md §1.4):
 *     { "error": { "code", "message", "requestId", "details"? } }
 *   `details` carries validation field errors ONLY ({ field, message }).
 * - Origin check (B1 CSRF contract): the Origin header must be PRESENT and its
 *   host must equal the request host. Host equality (instead of full-origin
 *   string equality) is deliberate: it survives proxy protocol termination
 *   (http between LB and app) while still rejecting every cross-site attacker
 *   origin — an attacker origin can never share our host. Browsers always
 *   send Origin on non-GET same-origin requests, so absent Origin is treated
 *   as a mismatch (403 CSRF_ORIGIN_REJECTED).
 * - A single route wrapper guarantees: request-ID resolution, one log line
 *   per unhandled failure (category only — never raw messages), and the
 *   500 INTERNAL_ERROR envelope. X-Request-Id is attached to EVERY response.
 */

import { NextResponse } from "next/server";
import { logger, redactFields, resolveRequestId } from "@/lib/server/logger";

/** Stable machine codes used by the first-release (B3–B6) routes. */
export const CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  CSRF_ORIGIN_REJECTED: "CSRF_ORIGIN_REJECTED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  STALE_VERSION: "STALE_VERSION",
  EMAIL_EXISTS: "EMAIL_EXISTS",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // B6 (contract §1.6 + §4): idempotency outcomes and the purchase rejection
  // that needs authoritative state rolled back by the client.
  IDEMPOTENCY_MISMATCH: "IDEMPOTENCY_MISMATCH",
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  // B8 (contract §1.4 table): verified-email gate on Google connection, and
  // the safe "provider config absent" answer for google.connectStart (§9).
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  // Google-only entrance (user decision 2026-10-11): password login/register
  // are retired — every entrance must be a real, Google-verified Gmail via
  // "Continue with Google". Returned by the login and register routes so a
  // direct API call can never create a dummy account or password-enter.
  GOOGLE_SIGNIN_REQUIRED: "GOOGLE_SIGNIN_REQUIRED",
  // B9 (contract §7.2): the mailbox's stored refresh token is revoked/invalid
  // or the read scope was never granted — Gmail sync refuses until a human
  // reconnects. Distinct from a transient provider error (which retries).
  RECONNECT_REQUIRED: "RECONNECT_REQUIRED",
  // B10 (phase_b10.md §7): advisory analysis scheduling refusals — the global
  // pause switch is on (409 AI_PAUSED) or today's UTC budget is spent (409
  // AI_LIMIT_REACHED). Both are honest "not scheduled now" states; the manual
  // Analyze route never bills on refusal.
  AI_PAUSED: "AI_PAUSED",
  AI_LIMIT_REACHED: "AI_LIMIT_REACHED",
} as const;

export interface FieldError {
  field: string;
  message: string;
  /**
   * Optimistic-concurrency detail (B5): STALE_VERSION responses carry the
   * current resource version so the client can resync (contract §1.7 "409
   * STALE_VERSION with current resource version"; §1.4 keeps details in the
   * validation-field-error shape — this rides alongside `field`/`message`).
   */
  currentVersion?: number;
  /**
   * Authoritative economy state on purchase rejections (B6, contract §4:
   * "Rejection MUST include current authoritative state (balance/version) so
   * the optimistic client UI can roll back"). Same rider pattern as
   * `currentVersion` — a numeric value inside the envelope-shaped details.
   */
  currentBalance?: number;
}

/** All handled responses (success or failure) carry the correlation header. */
function withRequestId(response: NextResponse, requestId: string): NextResponse {
  response.headers.set("X-Request-Id", requestId);
  return response;
}

export function jsonEnvelope(
  status: number,
  body: Record<string, unknown>,
  requestId: string,
  extraHeaders?: Record<string, string>,
): NextResponse {
  const response = NextResponse.json(body, { status });
  for (const [name, value] of Object.entries(extraHeaders ?? {})) response.headers.set(name, value);
  return withRequestId(response, requestId);
}

/** Non-2xx responses use exactly the B1 envelope. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: FieldError[],
): NextResponse {
  const error: Record<string, unknown> = { code, message, requestId };
  // details = validation field errors only ({ field, message }); redact each
  // item with the shared policy while PRESERVING array shape.
  if (details && details.length > 0) {
    error.details = details.map((item) =>
      redactFields({
        field: item.field,
        message: item.message,
        ...(item.currentVersion !== undefined ? { currentVersion: item.currentVersion } : {}),
        ...(item.currentBalance !== undefined ? { currentBalance: item.currentBalance } : {}),
      }),
    );
  }
  return jsonEnvelope(status, { error }, requestId);
}

export function validationError(requestId: string, details: FieldError[]): NextResponse {
  return errorResponse(400, CODES.VALIDATION_ERROR, "Request validation failed.", requestId, details);
}

/** 429 + Retry-After header (B1 §1.8). */
export function rateLimitedResponse(requestId: string, retryAfterSeconds: number): NextResponse {
  const response = errorResponse(429, CODES.RATE_LIMITED, "Too many requests. Please try again later.", requestId);
  response.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  return response;
}

/** CSRF: Origin present AND its host equal to the request host. */
export function originMismatch(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true; // "Origin: null", garbage, or unparsable — reject
  }
}

/**
 * Relaxed Origin gate for READ-ONLY same-origin streams (B5 `events.stream`).
 *
 * Browsers omit the Origin header on same-origin EventSource GETs (verified
 * live in Chrome during B5: a strict originMismatch 403'd the app's own
 * stream), so ABSENCE is allowed here. A cross-origin opener performs a CORS
 * request and always sends Origin → mismatching, null or garbage still
 * rejects exactly like originMismatch; the session cookie (SameSite) remains
 * the primary gate. Mutations keep the strict `originMismatch`.
 */
export function originConflicts(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false; // absent: same-origin EventSource GET — allow
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

export function csrfRejected(requestId: string): NextResponse {
  return errorResponse(
    403,
    CODES.CSRF_ORIGIN_REJECTED,
    "Request origin is not allowed.",
    requestId,
  );
}

export type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

/** Parse a JSON object body; malformed/absent/non-object → 400 (B1 §1.4). */
export async function readJsonObject(request: Request, requestId: string): Promise<BodyResult> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, response: validationError(requestId, [{ field: "body", message: "Malformed JSON body." }]) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: validationError(requestId, [{ field: "body", message: "Body must be a JSON object." }]) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** Coarse, safe failure categories for logs — never the raw error message. */
export function errorCategory(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.startsWith("SERVER_ENV_")) return "config";
    if (error.name === "ProbeTimeoutError") return "timeout";
  }
  // Duck-typed so both real Prisma errors (Error + .code) and plain
  // code-carrying objects (tests) classify as "db".
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return "db";
  }
  return "unexpected";
}

/**
 * Prisma unique-constraint violation (P2002) — duck-typed so it works across
 * Prisma versions and with plain thrown objects in tests. Deliberately lives
 * in http.ts (NOT the mocked prisma module) so route tests can exercise the
 * 409 EMAIL_EXISTS path through a mocked getDb.
 */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Uniform route wrapper: resolves the request ID, runs the handler, attaches
 * X-Request-Id to every response, and converts any unhandled throw into the
 * sanitized 500 envelope with one category-only log line.
 */
export async function handle(
  request: Request,
  routeId: string,
  fn: (requestId: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  try {
    return withRequestId(await fn(requestId), requestId);
  } catch (error) {
    logger.error("route.unhandled", { requestId, routeId, category: errorCategory(error) });
    return errorResponse(500, CODES.INTERNAL_ERROR, "An unexpected error occurred.", requestId);
  }
}
