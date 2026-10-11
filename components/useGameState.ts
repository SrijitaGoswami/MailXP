"use client";

import { useSyncExternalStore } from "react";

import { getSnapshot, subscribeState, type GameSnapshot } from "../game/bridge";
import { getDefaultProfile, getProfile, subscribeProfile, type Profile } from "../game/profile";

/**
 * Phase 6 React hooks over the two existing state channels:
 *
 * - `useGameSnapshot` — live game state from the typed bridge (objectives,
 *   quests, review, wallet mirror, decor mode…).
 * - `useProfile` — the persisted local profile (owned cosmetics, equipped
 *   outfit, placed decor, sound/motion/touch preferences).
 *
 * Both are plain stores with subscribe + cached snapshot getters, so React's
 * `useSyncExternalStore` drives them: every subscriber change re-reads the
 * current reference and re-renders only when it actually changed.
 *
 * The profile hook passes `getDefaultProfile` as the server snapshot: the
 * server can't read localStorage, so hydration must render the same defaults
 * the server did — reading persisted values during hydration would mismatch
 * (React #418) on every visit after the first. The persisted values are
 * adopted right after hydration by React's built-in store check, no error.
 */

export function useGameSnapshot(): GameSnapshot {
  return useSyncExternalStore(subscribeState, getSnapshot, getSnapshot);
}

export function useProfile(): Profile {
  return useSyncExternalStore(subscribeProfile, getProfile, getDefaultProfile);
}
