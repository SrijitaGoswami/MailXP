/**
 * Shared API contract types (Phase B5).
 *
 * Single source for the shapes exchanged between the Next.js routes and the
 * React client (BACKEND_API_CONTRACT.md: "shared contract types — frontend
 * imports types read-only"). TYPES ONLY, zero imports: safe for both
 * lib/server/** (implementation) and components/** (UI) to import — this file
 * never pulls server code into a client bundle.
 */

/** The six-key preference allowlist (contract game.preferencesUpdate). */
export type GamePreferences = {
  masterVolume: number;
  uiVolume: number;
  gameVolume: number;
  muted: boolean;
  motion: "full" | "reduced";
  touchControls: "auto" | "on" | "off";
};

/** `me.get` / `auth.login` / `auth.register` player projection (§2). */
export interface MePlayer {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

/** GET /api/v1/game/state body (contract §3 `game.state`). */
export interface GameStateDto {
  playerId: string;
  draftCoin: number;
  xp: number;
  level: number;
  stats: { mailCount: number };
  ownedItems: { itemId: string; ownedSince: string }[];
  equippedOutfit: string | null;
  placedDecor: { itemId: string; x: number; y: number }[];
  preferences: GamePreferences;
  version: number;
}

/** PATCH /api/v1/game/preferences success body. */
export interface PreferencesUpdateResult {
  preferences: GamePreferences;
  version: number;
}

/** One ledger row (contract §3 `game.ledger` item). */
export interface LedgerItem {
  id: string;
  type: "quest_reward" | "purchase" | "adjustment";
  amount: number;
  reason: string;
  sourceRef: string | null;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerItem[];
  nextCursor: string | null;
}

/** Stable error codes the UI branches on (contract §1.4). */
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "INVALID_CREDENTIALS"
  | "CSRF_ORIGIN_REJECTED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE_VERSION"
  | "EMAIL_EXISTS"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  // B6: idempotency outcomes (§1.6) + purchase rejection (§4).
  | "IDEMPOTENCY_MISMATCH"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "INSUFFICIENT_FUNDS"
  // B8 (contract §1.4): verified-email gate + provider-config-absent.
  | "EMAIL_NOT_VERIFIED"
  | "SERVICE_UNAVAILABLE"
  // B8b (user decision 2026-10-11): password login/register retired — Google only.
  | "GOOGLE_SIGNIN_REQUIRED"
  // B9 (contract §7.2): the mailbox must re-consent before Gmail sync can run.
  | "RECONNECT_REQUIRED"
  // B10 (phase_b10.md §7): advisory analysis scheduling refusals.
  | "AI_PAUSED"
  | "AI_LIMIT_REACHED";

// ------------------------------------------------------- B6 economy (contract §4) --

/** One item of GET /api/v1/shop (`shop.catalog`). Prices are server truth. */
export interface ShopCatalogItem {
  itemId: string;
  name: string;
  price: number;
  kind: "outfit" | "decor";
  /** False when already owned (re-purchase → 409 CONFLICT). */
  available: boolean;
}

export interface ShopCatalogDto {
  items: ShopCatalogItem[];
  /** Stable content hash of the catalog (ids + prices + kinds). */
  catalogVersion: string;
}

/** POST /api/v1/shop/purchases success body (201). */
export interface PurchaseResultDto {
  transactionId: string;
  itemId: string;
  balance: number;
  version: number;
}

/** GET /api/v1/rewards/rules (`rewards.rules`, contract §7.5). */
export interface RewardsRulesDto {
  questRewardDraftCoin: number;
  dailyCapDraftCoin: number;
  resetUtcHour: number;
}

/** GET /api/v1/rewards/status (`rewards.status`, contract §7.5). */
export interface RewardsStatusDto {
  earnedToday: number;
  dailyCapDraftCoin: number;
  remainingToday: number;
  resetsAtUtc: string;
}

/** POST /api/v1/dev/rewards (development-only fixture; 404 in production). */
export interface DevRewardResultDto {
  awarded: number;
  capped: boolean;
  balance: number;
  version: number;
}

// ------------------------------------------------- Phase B8: Google OAuth ---
// Schemas finalized for the contract §7.1 family (amendment recorded in
// docs/BACKEND_API_CONTRACT.md). Token material is server-only and can never
// appear in these shapes.

/** One linked Google identity (owner-scoped projection). */
export interface GoogleAccountDto {
  id: string;
  email: string;
  status: "connected" | "released";
  scopes: string[];
  connectedAt: string;
}

/** GET /api/v1/integrations/google (`google.status`) success body. */
export interface GoogleStatusDto {
  /** Server has Google OAuth credentials configured. */
  configured: boolean;
  /** Variable NAMES only when configured=false — never values. */
  missing: string[];
  /** Connect gate: verified email required (contract §7.1). */
  emailVerified: boolean;
  accounts: GoogleAccountDto[];
}

/** POST /api/v1/integrations/google/start (`google.connectStart`) body. */
export interface GoogleStartDto {
  /** Absolute Google consent URL — navigate the browser here. */
  authUrl: string;
}

// ------------------------------------------------------- Phase B9: Gmail inbox ---
// Token material, history cursors, and raw provider payloads are server-only
// and can never appear in these shapes. Bodies are PLAIN TEXT ONLY (HTML is
// never rendered or stored, spec §5). Attachments are METADATA ONLY (never
// bytes). Sync status is a persistent, player-visible state (spec §6).

/** Persistent inbox sync status for one connected mailbox (spec §6). */
export type GmailSyncStatus =
  | "pending"
  | "syncing"
  | "synced"
  | "delayed"
  | "reconnect_required"
  | "error";

/** GET /api/v1/gmail/sync-status (`gmail.syncStatus`) success body. */
export interface GmailSyncStatusDto {
  /** False when no Google mailbox is connected — the UI shows "no mailbox". */
  connected: boolean;
  status: GmailSyncStatus;
  /** Provider email of the connected mailbox (never a token). */
  email: string | null;
  /** Message count currently in the local inbox mirror. */
  messageCount: number;
  unreadCount: number;
  /** Whether a sync job is currently queued/running (for progress UI). */
  syncInFlight: boolean;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  /** Safe error category (never a raw provider payload or stack). */
  lastErrorClass: string | null;
  /** The history window this mailbox imports (days; 30 by default). */
  historyWindowDays: number;
  /** True when the mailbox needs a fresh consent (revoked/invalid token). */
  reconnectRequired: boolean;
}

/** One message summary in the inbox list (contract §7.2). */
export interface GmailMessageSummaryDto {
  id: string;
  threadId: string | null;
  sender: string;
  subject: string | null;
  snippet: string | null;
  isUnread: boolean;
  receivedAt: string;
  hasAttachments: boolean;
  attachmentCount: number;
}

/** GET /api/v1/gmail/messages (`gmail.messagesList`) success body. */
export interface GmailMessageListDto {
  messages: GmailMessageSummaryDto[];
  /** Opaque cursor for the next page (newest-first); null = end of list. */
  nextCursor: string | null;
}

/** GET /api/v1/gmail/messages/{id} (`gmail.messageGet`) success body. */
export interface GmailMessageDetailDto {
  id: string;
  threadId: string | null;
  sender: string;
  subject: string | null;
  /** PLAIN TEXT body only — never HTML (spec §5). */
  bodyText: string | null;
  isUnread: boolean;
  receivedAt: string;
  /** Metadata only — filename, MIME type, size. Never bytes (spec §5). */
  attachments: { filename: string; mimeType: string; size: number }[];
}

/** POST /api/v1/gmail/sync (`gmail.syncStart`) success body (202). */
export interface GmailSyncStartDto {
  /** True when a sync job was newly enqueued; false when coalesced. */
  enqueued: boolean;
  status: GmailSyncStatus;
}

// ------------------------------------------------- Phase B10: AI analysis ---
// Advisory-only (phase_b10.md): the server never mutates Gmail and never
// returns provider payloads, prompts, or the API key. Categories/priorities
// mirror the server enums (9 categories, 4 priorities).

export type AiAnalysisStatus =
  | "not_analyzed"
  | "queued"
  | "analyzing"
  | "ready"
  | "stale"
  | "limited"
  | "failed";

export type AiCategory =
  | "work"
  | "personal"
  | "finance"
  | "shopping"
  | "travel"
  | "notification"
  | "promotion"
  | "social"
  | "other";

export type AiPriority = "low" | "normal" | "high" | "urgent";

/** One suggested action item (advisory; ids are regenerated locally). */
export interface AiActionItemDto {
  id: string;
  text: string;
  dueDateSourceText: string | null;
  dueDateIso: string | null;
}

export interface AiDeadlineDto {
  sourceText: string;
  iso: string | null;
}

/** GET /api/v1/ai/analysis/{messageId} (`ai.analysisGet`) success body. */
export interface AiAnalysisDto {
  messageId: string;
  status: AiAnalysisStatus;
  category: AiCategory | null;
  priority: AiPriority | null;
  summary: string | null;
  actionItems: AiActionItemDto[];
  deadlines: AiDeadlineDto[];
  /** True when only snippet/subject were available (no body text). */
  limited: boolean;
  /** Safe error category (config|auth|quota|timeout|provider|malformed_output|permanent). */
  errorClass: string | null;
  schemaVersion: number;
  modelId: string | null;
  analyzedAt: string | null;
  updatedAt: string | null;
}

/** POST /api/v1/ai/analysis/{messageId} (`ai.analysisStart`) success body (202). */
export interface AiAnalysisStartDto {
  analysis: AiAnalysisDto;
}

/** GET /api/v1/ai/settings (`ai.settingsGet`) success body. */
export interface AiSettingsDto {
  paused: boolean;
  usage: {
    used: number;
    cap: number;
    resetsAtUtc: string;
  };
  /** Whether the server currently has a provider key configured. */
  configured: boolean;
}

/** PATCH /api/v1/ai/settings (`ai.settingsUpdate`) success body. */
export interface AiSettingsUpdateDto {
  paused: boolean;
}
