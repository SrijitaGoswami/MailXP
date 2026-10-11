"use client";

/**
 * Server-authoritative sync for a signed-in player (Phase B5 §6/§9).
 *
 * Effect lifecycle (runs when `enabled`, i.e. signed in):
 *  1. ONE-TIME legacy migration — raw local profile backed up BEFORE any
 *     server value touches the live key (gameSync.runLegacyMigration).
 *  2. GET /game/state → mirror into the local profile (server wins; scenes
 *     react through the existing profile-subscriber channel — no new bus).
 *  3. ONE-TIME legacy prefs import: the six local keys PATCH the server only
 *     when they differ (bounded: one stale-version retry, then give up —
 *     the backup preserves the originals either way).
 *  4. Subscribe to local profile changes → debounced PATCH /game/preferences
 *     with expectedVersion (409 STALE_VERSION → refetch; server wins).
 *  5. Open GET /events (EventSource): `profile.updated` / `economy.updated`
 *     → REST refetch;
 *     every (re)connect → refetch; 3 consecutive failures → 30 s polling
 *     fallback until a stream succeeds (contract §5, bounded — no loops).
 *
 * Everything here lives in the React layer: OfficeScene.update() never sees
 * network work, the Phaser canvas never remounts (auth/sync are overlay
 * state), and 401 UNAUTHENTICATED/SESSION_EXPIRED from ANY call performs a
 * single transition to the signed-out gate (reportSessionLost — no retries).
 */

import { useEffect } from "react";

import type { GamePreferences } from "@/game/backend/contract";
import { getProfile, patchProfile, subscribeProfile, type Profile } from "@/game/profile";
import { ApiError, fetchGameState, patchPreferences } from "./apiClient";
import { clearNotice, isSessionLoss, reportApiNotice, reportSessionLost } from "./authStore";
import {
  INITIAL_STREAM_STATE,
  POLL_INTERVAL_MS,
  PREFS_SYNC_DEBOUNCE_MS,
  preferencesEqual,
  runLegacyMigration,
  shouldImportPreferences,
  stateToProfilePatch,
  streamFailed,
  streamOpened,
  type StreamState,
} from "./gameSync";

function reportIfSessionLost(error: unknown): boolean {
  if (isSessionLoss(error)) {
    reportSessionLost((error as ApiError).code);
    return true;
  }
  return false;
}

export function useGameSync(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let stream: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let prefsTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeProfile: (() => void) | null = null;
    let streamState: StreamState = { ...INITIAL_STREAM_STATE };

    /** Latest authoritative mirrors (module of this effect's closure). */
    let version = 0;
    let serverPrefs: GamePreferences | null = null;

    async function refetchState(): Promise<boolean> {
      if (disposed) return false;
      try {
        const state = await fetchGameState();
        if (disposed) return false;
        version = state.version;
        serverPrefs = state.preferences;
        patchProfile(stateToProfilePatch(state)); // server wins on conflict
        clearNotice(); // a successful fetch retires transient network notices
        return true;
      } catch (error) {
        if (reportIfSessionLost(error)) return false;
        if (error instanceof ApiError && error.code === "NETWORK_ERROR") {
          reportApiNotice("Can't reach the server — changes may not save.");
        }
        return false;
      }
    }

    async function importLegacyPreferences(legacyPrefs: GamePreferences): Promise<void> {
      if (!serverPrefs || !shouldImportPreferences(legacyPrefs, serverPrefs)) return;
      try {
        const result = await patchPreferences(legacyPrefs, version);
        if (disposed) return;
        version = result.version;
        serverPrefs = result.preferences;
      } catch (error) {
        if (reportIfSessionLost(error)) return;
        if (error instanceof ApiError && error.code === "STALE_VERSION") {
          // One bounded retry against fresh state, then give up (documented):
          // the backup key still holds the original legacy preferences.
          const refreshed = await refetchState();
          if (!refreshed || !serverPrefs || !shouldImportPreferences(legacyPrefs, serverPrefs)) return;
          try {
            const retry = await patchPreferences(legacyPrefs, version);
            if (disposed) return;
            version = retry.version;
            serverPrefs = retry.preferences;
          } catch (retryError) {
            reportIfSessionLost(retryError);
          }
        }
        // Network/other failures: abandon the import — backup preserves it.
      }
    }

    function pushPreferences(): void {
      prefsTimer = null;
      if (disposed || !serverPrefs) return;
      const desired = getProfile().prefs;
      if (preferencesEqual(desired, serverPrefs)) return; // echo guard
      void (async () => {
        try {
          const result = await patchPreferences(desired, version);
          if (disposed) return;
          version = result.version;
          serverPrefs = result.preferences;
        } catch (error) {
          if (reportIfSessionLost(error)) return;
          if (error instanceof ApiError && error.code === "STALE_VERSION") {
            // Another writer won — the server's state is authoritative.
            await refetchState();
          }
          // Network/5xx: keep the local value; the next change retries.
        }
      })();
    }

    function onProfileChange(profile: Profile): void {
      if (!serverPrefs || disposed) return;
      if (preferencesEqual(profile.prefs, serverPrefs)) return; // no-op writes
      if (prefsTimer) clearTimeout(prefsTimer);
      prefsTimer = setTimeout(pushPreferences, PREFS_SYNC_DEBOUNCE_MS);
    }

    function startPolling(): void {
      if (pollTimer || disposed) return;
      pollTimer = setInterval(() => {
        void refetchState();
      }, POLL_INTERVAL_MS);
    }

    function stopPolling(): void {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
    }

    function openEventStream(): void {
      if (disposed) return;
      stream = new EventSource("/api/v1/events");
      stream.addEventListener("open", () => {
        streamState = streamOpened(streamState);
        stopPolling();
        // Contract §5: (re)connect → refetch authoritative state.
        void refetchState();
      });
      stream.addEventListener("profile.updated", () => {
        void refetchState();
      });
      // B6: purchases/rewards publish `economy.updated` (contract §4/§5) —
      // same pointer semantics: refetch the authoritative state via REST.
      stream.addEventListener("economy.updated", () => {
        void refetchState();
      });
      stream.addEventListener("error", () => {
        streamState = streamFailed(streamState);
        if (streamState.polling) startPolling(); // after 3 failures (bounded)
      });
    }

    void (async () => {
      // 1. Backup BEFORE anything can touch the live local key.
      if (typeof window !== "undefined") {
        try {
          runLegacyMigration(window.localStorage);
        } catch {
          // Storage blocked/unavailable — nothing to preserve.
        }
      }
      // 2. Capture legacy prefs before hydration overwrites the local cache.
      const legacyPrefs = { ...getProfile().prefs };
      // 3. Fetch + mirror server state.
      const ok = await refetchState();
      if (disposed) return;
      // 4. One-time legacy prefs import (local → server), then...
      if (ok) await importLegacyPreferences(legacyPrefs);
      if (disposed) return;
      // 5. ...live sync: local edits → PATCH, stream → refetch.
      unsubscribeProfile = subscribeProfile(onProfileChange);
      openEventStream();
    })();

    return () => {
      disposed = true;
      stream?.close();
      stream = null;
      stopPolling();
      if (prefsTimer) clearTimeout(prefsTimer);
      prefsTimer = null;
      unsubscribeProfile?.();
      unsubscribeProfile = null;
    };
  }, [enabled]);
}
