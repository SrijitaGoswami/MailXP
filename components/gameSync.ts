/**
 * Pure client sync logic (Phase B5) — no React, no side effects, fully
 * testable. Used by useGameSync.
 *
 * Field authority (phase_b5.md §6, contract §3.3), decided by the user at B5
 * ("contract-clean: reset, keep backup"):
 *
 * | field                 | authority after B5                          | legacy import |
 * |-----------------------|---------------------------------------------|---------------|
 * | draftCoin, inventory, | SERVER (game/state; mutations start at B6)  | never pushed  |
 * | outfit, decor, xp,    |                                             | (no route     |
 * | level, stats, version |                                             | exists)       |
 * | preferences (6 keys)  | SERVER (PATCH expectedVersion)              | ONE-TIME:     |
 * |                       |                                             | local → server|
 * |                       |                                             | on first sync |
 * | local profile key     | responsiveness cache + immutable legacy     | n/a           |
 * |                       | backup (never deleted)                      |               |
 *
 * Legacy handling: BEFORE any server state is applied to the local profile,
 * the raw `mailxp.profile.v1` payload is copied to a backup key exactly once
 * (guarded by a migration marker — "do not delete the key first", "prevent
 * repeated migration"). Server state then overwrites the live local profile
 * (server wins on conflict), while the backup preserves the pre-B5 progress
 * forever.
 */

import type { GameStateDto, GamePreferences } from "@/game/backend/contract";
import type { ProfilePatch } from "@/game/profile";

/** The pre-existing local profile key (game/profileStorage.ts). */
export const LOCAL_PROFILE_KEY = "mailxp.profile.v1";
/** One-time backup of the pre-B5 local profile — written once, never deleted. */
export const LEGACY_BACKUP_KEY = "mailxp.profile.v1.legacy-backup";
/** Migration marker — set on first sign-in sync; prevents repeat runs. */
export const MIGRATION_MARKER_KEY = "mailxp.profile.v1.migrated";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MigrationResult {
  /** True when this call performed the migration (backup written or not). */
  ran: boolean;
  /** True when a local profile payload existed and was preserved. */
  backedUp: boolean;
}

/**
 * One-time legacy migration. Order matters: backup first, then marker.
 * - marker present → no-op (repeated syncs can never re-run it)
 * - no local payload → marker only (nothing to back up)
 * Never touches (or deletes) the live profile key itself.
 */
export function runLegacyMigration(storage: StorageLike): MigrationResult {
  if (storage.getItem(MIGRATION_MARKER_KEY) !== null) return { ran: false, backedUp: false };

  const raw = storage.getItem(LOCAL_PROFILE_KEY);
  let backedUp = false;
  if (raw !== null && storage.getItem(LEGACY_BACKUP_KEY) === null) {
    storage.setItem(LEGACY_BACKUP_KEY, raw);
    backedUp = true;
  }
  storage.setItem(MIGRATION_MARKER_KEY, new Date().toISOString());
  return { ran: true, backedUp };
}

/** Valid outfit ids (game/profile.ts OutfitId) — anything else falls back. */
function coerceOutfit(value: string | null): "worker" | "courier" | "tech" | "forest" {
  return value === "courier" || value === "tech" || value === "forest" ? value : "worker";
}

/**
 * Map an authoritative server state onto the local profile patch shape.
 * Deliberately touches ONLY Profile fields — never balance-creating logic:
 * the values come from the server (server wins), this just mirrors them into
 * the synchronous local cache the scenes read (profileStorage seam unchanged).
 */
export function stateToProfilePatch(state: GameStateDto): ProfilePatch {
  return {
    draftCoin: state.draftCoin,
    ownedItems: state.ownedItems.map((item) => item.itemId),
    equippedOutfit: coerceOutfit(state.equippedOutfit),
    placedDecor: state.placedDecor.map((item) => ({ itemId: item.itemId, x: item.x, y: item.y })),
    prefs: { ...state.preferences },
  };
}

export function preferencesEqual(a: GamePreferences, b: GamePreferences): boolean {
  return (
    a.masterVolume === b.masterVolume &&
    a.uiVolume === b.uiVolume &&
    a.gameVolume === b.gameVolume &&
    a.muted === b.muted &&
    a.motion === b.motion &&
    a.touchControls === b.touchControls
  );
}

/**
 * Legacy prefs import decision: push the LOCAL six-key set to the server only
 * when it actually differs (one-time in practice — after hydration the local
 * cache mirrors the server, so the comparison collapses to equal).
 */
export function shouldImportPreferences(local: GamePreferences, server: GamePreferences): boolean {
  return !preferencesEqual(local, server);
}

// ------------------------------------------------------- SSE fallback state --

/** Contract §5 fallback: after 3 consecutive stream failures, poll every 30 s. */
export const STREAM_FAILURE_THRESHOLD = 3;
export const POLL_INTERVAL_MS = 30_000;
/** Debounce for coalescing rapid local preference edits into one PATCH. */
export const PREFS_SYNC_DEBOUNCE_MS = 300;

export interface StreamState {
  consecutiveFailures: number;
  /** Polling mode: active until a stream succeeds again. */
  polling: boolean;
}

export const INITIAL_STREAM_STATE: StreamState = { consecutiveFailures: 0, polling: false };

/** Stream opened/reconnected: counters reset, polling stops (then refetch). */
export function streamOpened(state: StreamState): StreamState {
  return { consecutiveFailures: 0, polling: false };
}

/** Stream errored: counts toward the fallback threshold (bounded, no loop). */
export function streamFailed(state: StreamState): StreamState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    polling: state.polling || consecutiveFailures >= STREAM_FAILURE_THRESHOLD,
  };
}
