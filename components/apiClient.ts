/**
 * Browser API client (Phase B5).
 *
 * Same-origin fetches; the httpOnly `mailxp.session` cookie rides along
 * automatically — this module never reads, stores or sends a token itself
 * (the cookie is unreachable from JS by design). Every non-2xx envelope is
 * turned into an ApiError carrying the STABLE B1 code, so UIs branch on
 * codes — never on message text. 401 handling is deliberate: `fetchMe`
 * maps both UNAUTHENTICATED and SESSION_EXPIRED to `null` (signed out), and
 * everything else surfaces as a typed error for the caller (no retry loops
 * anywhere in this module).
 */

import type {
  AiAnalysisDto,
  AiSettingsDto,
  DevRewardResultDto,
  GameStateDto,
  GmailMessageDetailDto,
  GmailMessageListDto,
  GmailSyncStartDto,
  GmailSyncStatusDto,
  GoogleStartDto,
  GoogleStatusDto,
  MePlayer,
  PreferencesUpdateResult,
  PurchaseResultDto,
  ShopCatalogDto,
} from "@/game/backend/contract";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly fieldErrors: Array<{
    field: string;
    message: string;
    currentVersion?: number;
    currentBalance?: number;
  }>;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string,
    fieldErrors: ApiError["fieldErrors"] = [],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.fieldErrors = fieldErrors;
  }
}

/** Codes that mean "the session is gone" (UI signs the player out). */
export function isSessionErrorCode(code: string): boolean {
  return code === "UNAUTHENTICATED" || code === "SESSION_EXPIRED";
}

interface EnvelopeShape {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    details?: unknown;
  };
}

function parseDetails(details: unknown): ApiError["fieldErrors"] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { field, message, currentVersion, currentBalance } = entry as Record<string, unknown>;
    if (typeof field !== "string" || typeof message !== "string") return [];
    return [
      {
        field,
        message,
        ...(typeof currentVersion === "number" ? { currentVersion } : {}),
        ...(typeof currentBalance === "number" ? { currentBalance } : {}),
      },
    ];
  });
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const baseHeaders: Record<string, string> =
    init.body !== undefined ? { "Content-Type": "application/json" } : {};
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: { ...baseHeaders, ...(init.headers ?? {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server.", "");
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as EnvelopeShape;
    const error = envelope.error;
    throw new ApiError(
      response.status,
      typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
      typeof error?.message === "string" ? error.message : "Request failed.",
      typeof error?.requestId === "string" ? error.requestId : "",
      parseDetails(error?.details),
    );
  }
  return payload as T;
}

// ------------------------------------------------------------------- auth ---

/** Probe the session once at boot: 401 (either code) → null = signed out. */
export async function fetchMe(): Promise<MePlayer | null> {
  try {
    const body = await request<{ player: MePlayer }>("/api/v1/me");
    return body.player;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** Logout: a dead cookie (401) still means "signed out" — never throws 401. */
export async function logoutRequest(): Promise<void> {
  try {
    await request<unknown>("/api/v1/auth/logout", { method: "POST" });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    throw error;
  }
}

// ------------------------------------------------------------------- game ---

export async function fetchGameState(): Promise<GameStateDto> {
  return request<GameStateDto>("/api/v1/game/state");
}

export async function patchPreferences(
  preferences: Partial<GameStateDto["preferences"]>,
  expectedVersion: number,
): Promise<PreferencesUpdateResult> {
  return request<PreferencesUpdateResult>("/api/v1/game/preferences", {
    method: "PATCH",
    body: { preferences, expectedVersion },
  });
}

// ------------------------------------------------------------------- shop ---

/** GET /api/v1/shop — server-truth catalog (prices, availability). */
export async function fetchShopCatalog(): Promise<ShopCatalogDto> {
  return request<ShopCatalogDto>("/api/v1/shop");
}

/**
 * POST /api/v1/shop/purchases — atomic purchase. `idempotencyKey` is a fresh
 * UUID per user-initiated click (contract §1.6); a replayed click re-sends
 * the same key and gets the stored 201 instead of a second charge.
 */
export async function purchaseShopItem(
  itemId: string,
  expectedVersion: number,
  idempotencyKey: string,
): Promise<PurchaseResultDto> {
  return request<PurchaseResultDto>("/api/v1/shop/purchases", {
    method: "POST",
    body: { itemId, expectedVersion },
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

/**
 * POST /api/v1/dev/rewards — development-only fixture (404 in production).
 * Issues one quest_reward through the real atomic service (daily-capped).
 */
export async function issueDevReward(idempotencyKey: string): Promise<DevRewardResultDto> {
  return request<DevRewardResultDto>("/api/v1/dev/rewards", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

// --------------------------------------------------- google (Phase B8) ---

/** GET /api/v1/integrations/google — connection status (session-scoped). */
export async function fetchGoogleStatus(): Promise<GoogleStatusDto> {
  return request<GoogleStatusDto>("/api/v1/integrations/google");
}

/**
 * POST /api/v1/integrations/google/start — begin the consent round-trip.
 * On 200 the caller does `window.location.assign(authUrl)` (a full navigation
 * to Google; the httpOnly cookie rides along on the eventual callback).
 * Pass `accountId` to re-consent an existing connection instead.
 */
export async function startGoogleConnect(accountId?: string): Promise<GoogleStartDto> {
  return request<GoogleStartDto>("/api/v1/integrations/google/start", {
    method: "POST",
    body: accountId !== undefined ? { accountId } : {},
  });
}

/**
 * B8a — "Continue with Google": SAME start endpoint with `intent:"signin"`.
 * Deliberately callable while SIGNED OUT (the server mints an unbound state);
 * on 200 the caller navigates to authUrl and lands back signed in.
 */
export async function startGoogleSignIn(): Promise<GoogleStartDto> {
  return request<GoogleStartDto>("/api/v1/integrations/google/start", {
    method: "POST",
    body: { intent: "signin" },
  });
}

/** DELETE /api/v1/integrations/google/accounts/{id} — unlink (204, no body). */
export async function disconnectGoogleAccount(accountId: string): Promise<void> {
  await request<unknown>(`/api/v1/integrations/google/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
  });
}

// ------------------------------------------------- Gmail inbox (Phase B9) ---
// All reads hit the LOCAL mirror; "sync" enqueues a durable job (never inline
// provider work). No mutation calls exist here — send/draft/label are B11.

/** GET /api/v1/gmail/sync-status — persistent sync state for one mailbox. */
export async function fetchGmailSyncStatus(): Promise<GmailSyncStatusDto> {
  return request<GmailSyncStatusDto>("/api/v1/gmail/sync-status");
}

/** POST /api/v1/gmail/sync — enqueue a coalesced sync job (202). */
export async function startGmailSync(): Promise<GmailSyncStartDto> {
  return request<GmailSyncStartDto>("/api/v1/gmail/sync", { method: "POST", body: {} });
}

/** GET /api/v1/gmail/messages — cursor-paginated, newest-first inbox page. */
export async function fetchGmailMessages(cursor?: string): Promise<GmailMessageListDto> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request<GmailMessageListDto>(`/api/v1/gmail/messages${query}`);
}

/** GET /api/v1/gmail/messages/{id} — safe plain-text message detail. */
export async function fetchGmailMessage(messageId: string): Promise<GmailMessageDetailDto> {
  return request<GmailMessageDetailDto>(`/api/v1/gmail/messages/${encodeURIComponent(messageId)}`);
}

// --------------------------------------------- AI analysis (Phase B10) ---
// Advisory-only: GET is a pure read (404 for foreign/absent messages, or a
// not_analyzed body for an owned message with no row yet). POST enqueues the
// durable job (202); it never runs the provider inline and never returns
// content-derived data beyond what GET already exposes. The server decides
// pause/cap — this module never fakes those locally.

/** GET /api/v1/ai/analysis/{messageId} — current analysis (or not_analyzed). */
export async function fetchAiAnalysis(messageId: string): Promise<AiAnalysisDto> {
  const envelope = await request<{ analysis: AiAnalysisDto }>(
    `/api/v1/ai/analysis/${encodeURIComponent(messageId)}`,
  );
  return envelope.analysis;
}

/**
 * POST /api/v1/ai/analysis/{messageId} — manual Analyze/Retry (202).
 * Throws ApiError with code AI_PAUSED or AI_LIMIT_REACHED on refusal.
 */
export async function startAiAnalysis(messageId: string): Promise<AiAnalysisDto> {
  const envelope = await request<{ analysis: AiAnalysisDto }>(
    `/api/v1/ai/analysis/${encodeURIComponent(messageId)}`,
    { method: "POST", body: {} },
  );
  return envelope.analysis;
}

/** GET /api/v1/ai/settings — pause flag, today's usage, configured bit. */
export async function fetchAiSettings(): Promise<AiSettingsDto> {
  return request<AiSettingsDto>("/api/v1/ai/settings");
}

/** PATCH /api/v1/ai/settings — flip the global analysis pause. */
export async function setAiPaused(paused: boolean): Promise<{ paused: boolean }> {
  return request<{ paused: boolean }>("/api/v1/ai/settings", {
    method: "PATCH",
    body: { paused },
  });
}

// ------------------------------------------ email verification (B8a UI) ---

/** Dev-mode delivery shape returned by resend-verification outside production. */
export interface DevDeliveryDto {
  purpose: string;
  token: string;
  expiresAt: string;
}

/**
 * POST /api/v1/auth/resend-verification — ALWAYS 202 (no enumeration); a
 * signed-in session supplies the identity. Only outside production does the
 * response carry `devDelivery` with the raw token (B4 user decision), which
 * the Settings card surfaces so development testing needs no console.
 */
export async function resendVerificationEmail(): Promise<{ devDelivery?: DevDeliveryDto }> {
  return request<{ devDelivery?: DevDeliveryDto }>("/api/v1/auth/resend-verification", {
    method: "POST",
    body: {},
  });
}

/** POST /api/v1/auth/verify-email — token-borne claim (404 on bad/expired). */
export async function verifyEmailToken(token: string): Promise<{ player: { emailVerified: boolean } }> {
  return request<{ player: { emailVerified: boolean } }>("/api/v1/auth/verify-email", {
    method: "POST",
    body: { token },
  });
}
