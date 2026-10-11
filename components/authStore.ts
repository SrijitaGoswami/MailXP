"use client";

/**
 * Shared auth state (Phase B5) — a tiny module store consumed with
 * useSyncExternalStore, exactly like game/profile.ts does for the profile:
 * one source of truth, any component (AppShell, AuthPanel, Settings) reads
 * the same snapshot without prop drilling or a context provider.
 *
 * SSR/hydration safety: the server snapshot is the initial `checking` state,
 * identical on both sides; the session probe runs only in the browser after
 * mount (no localStorage inference, no cookie reading — identity comes from
 * GET /me, contract §5 "check GET /api/v1/me; never infer authentication
 * from localStorage").
 */

import { useSyncExternalStore } from "react";

import type { MePlayer } from "@/game/backend/contract";
import {
  ApiError,
  fetchMe,
  isSessionErrorCode,
  logoutRequest,
} from "./apiClient";

export type AuthStatus = "checking" | "signedOut" | "signedIn";

export interface AuthSnapshot {
  status: AuthStatus;
  player: MePlayer | null;
  /** One-shot UI notice (e.g. session expiry) — cleared on sign-in. */
  notice: string | null;
}

const INITIAL: AuthSnapshot = { status: "checking", player: null, notice: null };

let snapshot: AuthSnapshot = INITIAL;
const listeners = new Set<() => void>();

function set(next: Partial<AuthSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAuthSnapshot(): AuthSnapshot {
  return snapshot;
}

export function getServerAuthSnapshot(): AuthSnapshot {
  return INITIAL;
}

export function useAuth(): AuthSnapshot {
  return useSyncExternalStore(subscribe, getAuthSnapshot, getServerAuthSnapshot);
}

/** Test-only: restore the initial state (and the one-shot probe guard). */
export function resetAuthStore(): void {
  snapshot = INITIAL;
  probe = null;
  for (const listener of listeners) listener();
}

let probe: Promise<void> | null = null;

/**
 * Boot probe (runs once — StrictMode-safe): GET /me decides the gate.
 * Network failure lands signed OUT with a notice (deliberate, never a
 * retry loop); the form stays usable so the next action retries naturally.
 */
export function probeAuth(): Promise<void> {
  if (probe) return probe;
  probe = (async () => {
    try {
      const player = await fetchMe();
      set(player ? { status: "signedIn", player, notice: null } : { status: "signedOut", player: null });
    } catch {
      set({
        status: "signedOut",
        player: null,
        notice: "Could not reach the server. Check your connection and try again.",
      });
    }
  })();
  return probe;
}

/** After a successful login/register call (the panel awaits these). */
export function adoptPlayer(player: MePlayer): void {
  set({ status: "signedIn", player, notice: null });
}

/** Sign out: server revocation first (204), then local state; 401 tolerated. */
export async function signOut(): Promise<void> {
  try {
    await logoutRequest();
  } finally {
    set({ status: "signedOut", player: null, notice: null });
  }
}

/**
 * Called by any module that receives 401 UNAUTHENTICATED / SESSION_EXPIRED
 * mid-session: one transition to the gate with an explanatory notice —
 * no re-probe, no retries (phase §5).
 */
export function reportSessionLost(code: string): void {
  if (!isSessionErrorCode(code)) return;
  const notice =
    code === "SESSION_EXPIRED"
      ? "Your session has expired — please sign in again."
      : "Please sign in to continue.";
  // Idempotent: an identical repeat (or the already-signed-out state with the
  // same notice) never churns listeners; a first notice still lands.
  if (snapshot.status === "signedOut" && snapshot.notice === notice) return;
  set({ status: "signedOut", player: null, notice });
}

/** Report a non-auth API failure as a transient notice (no state change). */
export function reportApiNotice(message: string): void {
  if (snapshot.notice === message) return;
  set({ notice: message });
}

export function clearNotice(): void {
  if (snapshot.notice === null) return;
  set({ notice: null });
}

/** True when the error is a session-loss signal (used by the sync layer). */
export function isSessionLoss(error: unknown): boolean {
  return error instanceof ApiError && isSessionErrorCode(error.code);
}
