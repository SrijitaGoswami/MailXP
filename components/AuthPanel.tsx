"use client";

/**
 * Google-only auth gate (user decision 2026-10-11) — rendered INSIDE the
 * existing title overlay. The Phaser canvas underneath is untouched: this is
 * pure overlay state, so auth changes never remount or reset OfficeScene.
 *
 * Google-only entrance: password login/registration is RETIRED. The only way
 * to sign in OR create an account is "Continue with Google", which proves a
 * real, Google-verified Gmail on Google's own screen (MailXP never sees the
 * Google password). The backend `auth.login` / `auth.register` routes refuse
 * (403 GOOGLE_SIGNIN_REQUIRED) so no dummy account is possible even via a
 * direct API call. Existing password accounts are grandfathered: a verified
 * Gmail matching an existing account signs into that same account.
 */

import { useEffect, useState } from "react";

import type { ApiError } from "./apiClient";
import { ApiError as ApiErrorClass, startGoogleSignIn } from "./apiClient";
import { clearNotice, useAuth } from "./authStore";
import { describeOAuthOutcome, readOAuthOutcomeToken } from "./oauthOutcome";

/** Pure, testable error presentation (codes — never message sniffing). */
export function describeAuthError(error: unknown): { message: string; fields: string[] } {
  if (error instanceof ApiErrorClass) {
    const api = error as ApiError;
    switch (api.code) {
      case "GOOGLE_SIGNIN_REQUIRED":
        return { message: "Continue with Google to verify a real Gmail address.", fields: [] };
      case "RATE_LIMITED":
        return { message: "Too many attempts — wait a moment and try again.", fields: [] };
      case "CSRF_ORIGIN_REJECTED":
        return { message: "Request blocked — reload the page and try again.", fields: [] };
      case "NETWORK_ERROR":
        return { message: "Could not reach the server — check your connection.", fields: [] };
      default:
        return { message: api.message || "Something went wrong. Try again.", fields: [] };
    }
  }
  return { message: "Something went wrong. Try again.", fields: [] };
}

export default function AuthPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const auth = useAuth();
  const [error, setError] = useState<{ message: string; fields: string[] } | null>(null);
  const [googlePending, setGooglePending] = useState(false);

  // A failed/cancelled Google round-trip lands back HERE (signed out) with a
  // safe `?googleOAuth=` token — surface it once, then scrub the URL.
  // Effect-only (window access never during render — SSR/hydration safe).
  useEffect(() => {
    const outcome = readOAuthOutcomeToken();
    if (outcome !== null) setError({ message: describeOAuthOutcome(outcome), fields: [] });
  }, []);

  /** "Continue with Google": full-page navigation; the callback lands back
   *  here signed in (the boot probe then finds the session and the gate
   *  unmounts). */
  async function onGoogleSignIn(): Promise<void> {
    if (googlePending) return;
    setGooglePending(true);
    setError(null);
    clearNotice();
    try {
      const { authUrl } = await startGoogleSignIn();
      window.location.assign(authUrl);
    } catch (caught) {
      const api = caught instanceof ApiErrorClass ? (caught as ApiError) : null;
      setError(
        api?.code === "SERVICE_UNAVAILABLE"
          ? { message: "Google sign-in is not configured on this server.", fields: [] }
          : describeAuthError(caught),
      );
      setGooglePending(false);
    }
  }

  return (
    <div
      aria-label="Sign in"
      className="w-full max-w-sm rounded-xl border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)]/95 p-4 text-left shadow-xl"
    >
      {/* Session-expiry / boot notices from the shared store. */}
      {auth.notice ? (
        <p role="status" className="mb-3 rounded border border-amber-600/50 bg-amber-100/80 px-2 py-1.5 text-sm text-amber-900">
          {auth.notice}
        </p>
      ) : null}

      <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Sign in to MailXP</h2>
      <p className="mt-1 text-sm opacity-80">
        Continue with a real Gmail account — it signs you in and creates your office if you&apos;re new.
      </p>

      {error ? (
        <div role="alert" className="mt-3 rounded border border-red-700/50 bg-red-50 px-2 py-1.5 text-sm text-red-800">
          <p>{error.message}</p>
          {error.fields.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-xs">
              {error.fields.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* The GitHub/Facebook pattern: Google verifies you on ITS own screen
          (MailXP never sees your Google password), then you land back here
          signed in — and connected for Gmail in the same click. */}
      <button
        type="button"
        disabled={googlePending}
        onClick={() => void onGoogleSignIn()}
        className="mt-4 w-full rounded-lg border-2 border-[var(--mailxp-walnut)] bg-white px-6 py-2.5 font-bold text-[var(--mailxp-walnut)] shadow-md transition hover:opacity-90 active:translate-y-px disabled:opacity-60"
      >
        {googlePending ? "Opening Google…" : "Continue with Google"}
      </button>

      <p className="mt-3 text-xs opacity-70">
        We verify your address through Google — no password to remember, and no account without a real Gmail.
      </p>
    </div>
  );
}
