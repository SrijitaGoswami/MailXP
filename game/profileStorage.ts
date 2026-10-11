/**
 * Persistence adapter seam (Phase B2).
 *
 * Isolates WHERE the local profile is stored behind a tiny synchronous
 * interface so a later phase (B5, server-authoritative sync) can introduce a
 * different backend without rewriting profile.ts or any React/Phaser consumer.
 *
 * Invariants kept by this phase:
 * - The active adapter is the same synchronous localStorage one as before
 *   (key `mailxp.profile.v1`); behaviour is bit-for-bit unchanged.
 * - No network calls exist here, and B2 never activates any other adapter.
 * - The seam stays SYNCHRONOUS on purpose: `getProfile()` runs during React
 *   render and Phaser scene reads. A future server-backed flow must populate a
 *   cache before reads — it must not make reads await.
 * - This module knows nothing about sanitisation; `profile.ts` owns the schema
 *   and coerces whatever `read()` returns.
 */

import type { Profile } from "./profile";

export interface ProfileStorage {
  /** Which backend is active ("local" in B2; a future phase may add others). */
  readonly kind: "local";
  /** Parsed stored value, or null when nothing is stored or it is unreadable. */
  read(): unknown | null;
  /** Persist a profile. Must never throw. */
  write(profile: Profile): void;
}

const STORAGE_KEY = "mailxp.profile.v1";

/** The pre-B2 behaviour: synchronous localStorage, silent-failure fallbacks. */
export const localStorageProfileStorage: ProfileStorage = {
  kind: "local",
  read(): unknown | null {
    if (typeof window === "undefined") return null; // SSR / no DOM
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      return null; // corrupt JSON or blocked storage -> caller falls back to defaults
    }
  },
  write(profile: Profile): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch {
      // Storage full/blocked — the session simply stays in-memory.
    }
  },
};

let active: ProfileStorage = localStorageProfileStorage;

export function getProfileStorage(): ProfileStorage {
  return active;
}

/**
 * Swap the persistence backend. Reserved for the future server-sync
 * integration (B5) and for tests; B2 application code never calls this.
 * Returns an idempotent restore function for the previous adapter.
 */
export function setProfileStorage(storage: ProfileStorage): () => void {
  const previous = active;
  active = storage;
  return () => {
    active = previous;
  };
}
