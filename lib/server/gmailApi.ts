/**
 * Gmail REST client — server-only provider round-trips (Phase B9, spec §4/§5).
 *
 * Scope: READ-ONLY Gmail access needed by the inbox. No mutations (send /
 * draft / archive / label / mark-read / delete) — those are B11 and are
 * forbidden here even though `gmail.modify` technically permits them (spec §4).
 *
 * Conventions inherited from lib/server/googleOAuth.ts:
 * - Endpoint constants live here in one place; a host allow-list test asserts
 *   every https:// host this file references.
 * - Every network call takes an injectable `fetchFn` so tests never hit the
 *   real network.
 * - Provider error BODIES are NEVER part of thrown messages (they can carry
 *   token material) — only safe category labels via GmailApiError.
 * - Access tokens are obtained by refreshing the STORED refresh token and are
 *   used only in-memory for the duration of one sync; they are never persisted
 *   or logged (spec §4).
 *
 * Reconnect signalling: a refresh that Google rejects with `invalid_grant`
 * (revoked / expired / no offline access) throws GmailReconnectRequiredError —
 * the sync engine turns that into the `reconnect_required` status and does NOT
 * retry (spec §4: no infinite retry storms on dead credentials).
 */

import type { GoogleProviderError } from "./googleOAuth";

// ------------------------------------------------------------ endpoints ---

/** Same OAuth token host as B8 — refresh reuses it with grant_type=refresh_token. */
export const GMAIL_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** Gmail REST root for the authenticated user ("me" is always the connection owner). */
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Hard ceiling on any single provider call — a hung Gmail must not pin a worker lease. */
export const GMAIL_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- errors ---

/**
 * Safe category label for a Gmail round-trip failure. `category` is a short
 * token (e.g. "history", "quota", "shape"); provider payloads are never stored
 * in the message or the `.category`.
 */
export class GmailApiError extends Error {
  readonly category: string;
  constructor(category: string) {
    super(`GMAIL_${category}`);
    this.name = "GmailApiError";
    this.category = category;
  }
}

/**
 * The stored refresh token can no longer obtain an access token
 * (`invalid_grant`): revoked, expired, or the user removed the app's access.
 * The sync engine marks the mailbox `reconnect_required` and stops retrying.
 */
export class GmailReconnectRequiredError extends Error {
  constructor() {
    super("GMAIL_reconnect_required");
    this.name = "GmailReconnectRequiredError";
  }
}

export type FetchFn = typeof fetch;

/** Minimal config a refresh needs (subset of GoogleOAuthConfig). */
export interface GmailTokenConfig {
  clientId: string;
  clientSecret: string;
}

// ------------------------------------------------------------- access ---

export interface AccessToken {
  accessToken: string;
  /** Google's lifetime hint in seconds (~3600). In-memory only — never stored. */
  expiresInSeconds: number;
}

/**
 * Exchange the STORED refresh token for a short-lived access token
 * (spec §4: "B9 exchanges the refresh token for access tokens when sync
 * begins"). `invalid_grant` → GmailReconnectRequiredError; everything else →
 * a category-only GmailApiError. The access token is returned to the caller
 * and used for the duration of one sync — never persisted.
 */
export async function refreshAccessToken(
  config: GmailTokenConfig,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<AccessToken> {
  let response: Response;
  try {
    response = await fetchFn(GMAIL_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
    });
  } catch {
    throw new GmailApiError("refresh_network");
  }

  if (!response.ok) {
    // Google returns 400 + error=invalid_grant for a dead/revoked token. We
    // classify WITHOUT reading the body into a message (it is safe here, but
    // the discipline is: never surface provider text).
    if (response.status === 400 || response.status === 401) {
      let errorCode = "";
      try {
        const payload = (await response.json()) as { error?: unknown };
        errorCode = typeof payload.error === "string" ? payload.error : "";
      } catch {
        errorCode = "";
      }
      if (errorCode === "invalid_grant" || errorCode === "invalid_client") {
        throw new GmailReconnectRequiredError();
      }
    }
    throw new GmailApiError(response.status === 429 ? "refresh_quota" : "refresh");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GmailApiError("refresh_shape");
  }
  const body = payload as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new GmailApiError("refresh_shape");
  }
  return {
    accessToken: body.access_token,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 3600,
  };
}

// ------------------------------------------------------------- transport ---

/** One authenticated GET against the Gmail API with timeout + category errors. */
async function gmailGet(
  accessToken: string,
  path: string,
  params: Record<string, string | number | undefined>,
  fetchFn: FetchFn,
): Promise<unknown> {
  const url = new URL(`${GMAIL_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
    });
  } catch (error) {
    // AbortSignal.timeout fires as a DOMException named "TimeoutError".
    if (error instanceof Error && error.name === "TimeoutError") throw new GmailApiError("timeout");
    throw new GmailApiError("network");
  }

  if (!response.ok) {
    if (response.status === 401) throw new GmailApiError("unauthorized");
    if (response.status === 403) throw new GmailApiError("forbidden"); // scope gap
    if (response.status === 404) throw new GmailApiError("not_found");
    if (response.status === 429) throw new GmailApiError("quota");
    throw new GmailApiError("server");
  }

  try {
    return await response.json();
  } catch {
    throw new GmailApiError("shape");
  }
}

// ---------------------------------------------------------------- reads ---

export interface GmailMessageRef {
  id: string;
  threadId?: string;
}

export interface GmailListResult {
  messages: GmailMessageRef[];
  nextPageToken?: string;
}

/**
 * Page of message IDs received after a cutoff (initial sync window). Uses the
 * `after:` search qualifier on the provider's internal date; `maxResults` is
 * bounded so a huge mailbox never loads unbounded in one call (spec §5).
 */
export async function listMessages(
  accessToken: string,
  opts: { newerThanUnixSeconds: number; pageToken?: string; maxResults?: number },
  fetchFn: FetchFn = fetch,
): Promise<GmailListResult> {
  const payload = await gmailGet(
    accessToken,
    "/messages",
    {
      q: `after:${opts.newerThanUnixSeconds}`,
      maxResults: opts.maxResults ?? 50,
      pageToken: opts.pageToken,
    },
    fetchFn,
  );
  const body = payload as {
    messages?: Array<{ id?: unknown; threadId?: unknown }>;
    nextPageToken?: unknown;
  };
  const messages: GmailMessageRef[] = Array.isArray(body.messages)
    ? body.messages
        .filter((m): m is { id: string; threadId?: string } => typeof m?.id === "string")
        .map((m) => ({ id: m.id, ...(typeof m.threadId === "string" ? { threadId: m.threadId } : {}) }))
    : [];
  return {
    messages,
    ...(typeof body.nextPageToken === "string" && body.nextPageToken !== ""
      ? { nextPageToken: body.nextPageToken }
      : {}),
  };
}

export interface GmailHistoryResult {
  /** The cursor to persist AFTER the corresponding changes are committed (spec §6). */
  historyId: string;
  addedMessageIds: string[];
  removedMessageIds: string[];
  nextPageToken?: string;
}

/**
 * Incremental delta since `startHistoryId`: message IDs added and removed.
 * The returned `historyId` is the NEW cursor — the sync engine advances to it
 * only after every change in this page is durably committed (spec §6).
 */
export async function listHistory(
  accessToken: string,
  opts: { startHistoryId: string; pageToken?: string; maxResults?: number },
  fetchFn: FetchFn = fetch,
): Promise<GmailHistoryResult> {
  const payload = await gmailGet(
    accessToken,
    "/history",
    {
      startHistoryId: opts.startHistoryId,
      historyTypes: "added,removed",
      maxResults: opts.maxResults ?? 100,
      pageToken: opts.pageToken,
    },
    fetchFn,
  );
  const body = payload as {
    historyId?: unknown;
    history?: Array<{
      messagesAdded?: Array<{ message?: { id?: unknown } }>;
      messagesRemoved?: Array<{ message?: { id?: unknown } }>;
      messagesDeleted?: Array<{ message?: { id?: unknown } }>;
    }>;
    nextPageToken?: unknown;
  };

  const added: string[] = [];
  const removed: string[] = [];
  const collect = (
    entries: Array<{ message?: { id?: unknown } }> | undefined,
    into: string[],
  ): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const id = entry?.message?.id;
      if (typeof id === "string") into.push(id);
    }
  };
  if (Array.isArray(body.history)) {
    for (const record of body.history) {
      collect(record?.messagesAdded, added);
      collect(record?.messagesRemoved, removed);
      collect(record?.messagesDeleted, removed);
    }
  }

  return {
    // Some history responses omit historyId (no change); fall back to the
    // requested cursor so a no-op page never clobbers the stored one.
    historyId: typeof body.historyId === "string" && body.historyId !== "" ? body.historyId : opts.startHistoryId,
    addedMessageIds: added,
    removedMessageIds: removed,
    ...(typeof body.nextPageToken === "string" && body.nextPageToken !== ""
      ? { nextPageToken: body.nextPageToken }
      : {}),
  };
}

// --------------------------------------------------------------- profile ---

export interface GmailProfile {
  /** Current mailbox history cursor — used to seed/advance the sync state. */
  historyId: string;
  emailAddress?: string;
  messagesTotal?: number;
}

/**
 * Mailbox profile. `historyId` is the authoritative current cursor — fetched
 * AFTER an initial message import so incremental sync starts from a consistent
 * point, and never returned to the browser (it is provider state, spec §9).
 */
export async function getProfile(
  accessToken: string,
  fetchFn: FetchFn = fetch,
): Promise<GmailProfile> {
  const payload = await gmailGet(accessToken, "/profile", {}, fetchFn);
  const body = payload as { historyId?: unknown };
  if (typeof body?.historyId !== "string" || body.historyId === "") {
    throw new GmailApiError("profile_shape");
  }
  return { historyId: body.historyId };
}

// ------------------------------------------------------- raw message shape ---

export interface RawGmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: RawGmailPart[];
}

export interface RawGmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string; // epoch milliseconds as a string
  labelIds?: string[];
  snippet?: string;
  payload?: {
    mimeType?: string;
    headers?: Array<{ name?: string; value?: string }>;
    body?: { attachmentId?: string; size?: number; data?: string };
    parts?: RawGmailPart[];
  };
}

/**
 * Full detail for one message (`format=full` — headers + MIME parts). The raw
 * structure is handed to lib/server/gmailMime.ts to extract the plain-text
 * body and attachment metadata; we never render or store HTML (spec §5).
 */
export async function getMessage(
  accessToken: string,
  messageId: string,
  fetchFn: FetchFn = fetch,
): Promise<RawGmailMessage> {
  const payload = await gmailGet(accessToken, `/messages/${encodeURIComponent(messageId)}`, { format: "full" }, fetchFn);
  const body = payload as RawGmailMessage;
  if (typeof body?.id !== "string") throw new GmailApiError("message_shape");
  return body;
}

/** Narrow GoogleProviderError re-export so callers can catch provider failures uniformly. */
export type { GoogleProviderError };
