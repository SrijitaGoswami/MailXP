"use client";

import { useEffect, useState } from "react";

import type { AiSettingsDto, GoogleStatusDto } from "../../game/backend/contract";
import { playSound } from "../../game/audio/audioManager";
import { patchProfile, resetProfile, type MotionSetting, type TouchSetting } from "../../game/profile";
import {
  ApiError,
  disconnectGoogleAccount,
  fetchAiSettings,
  fetchGoogleStatus,
  resendVerificationEmail,
  setAiPaused,
  startGoogleConnect,
  verifyEmailToken,
} from "../apiClient";
import { isSessionLoss, reportSessionLost, signOut, useAuth } from "../authStore";
import { describeOAuthOutcome, readOAuthOutcomeToken } from "../oauthOutcome";
import { useProfile } from "../useGameState";

/**
 * Settings tab — sound, motion and controls.
 *
 * All preferences persist in the local profile; the audio manager subscribes
 * to them, so volume/mute changes take effect immediately (no restart), and
 * OfficeScene re-reads the motion flag on its next decorative tween.
 *
 * B8/B8a: owns the Google connection card. `?googleOAuth=` outcome tokens are
 * read once on mount via the shared oauthOutcome module (the same one the
 * signed-out AuthPanel uses), then the parameter is scrubbed.
 */
function VolumeSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const percent = Math.round(value * 100);
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-32">
        {label} <span className="tabular-nums opacity-70">({percent}%)</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="flex-1 accent-[var(--mailxp-teal)]"
        aria-label={`${label} (percent)`}
      />
    </label>
  );
}

export default function SettingsScreen() {
  const profile = useProfile();
  const auth = useAuth();
  const prefs = profile.prefs;
  const [message, setMessage] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  // B8 — Google connection card state.
  const [googleStatus, setGoogleStatus] = useState<GoogleStatusDto | null>(null);
  const [googleMessage, setGoogleMessage] = useState("");
  const [googleBusy, setGoogleBusy] = useState(false);

  // B8a — resend-verification helpers (unverified accounts only).
  const [devToken, setDevToken] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  // B10 — AI assistance card (pause + server-truth usage; never fake budget).
  const [aiSettings, setAiSettings] = useState<AiSettingsDto | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState("");

  const setPrefs = (patch: Partial<typeof prefs>) => patchProfile({ prefs: patch });

  // B8: read the OAuth callback's outcome ONCE on mount (shared module scrubs
  // the parameter), then fetch this player's connection status. Effect-only
  // (window access never happens during render — SSR/hydration safe).
  useEffect(() => {
    const outcome = readOAuthOutcomeToken();
    if (outcome !== null) setGoogleMessage(describeOAuthOutcome(outcome));
    let cancelled = false;
    void fetchGoogleStatus()
      .then((status) => {
        if (!cancelled) setGoogleStatus(status);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Signed out / expired session: the gate owns that state — say nothing.
        if (error instanceof ApiError && (isSessionLoss(error) || error.status === 401)) return;
        setGoogleMessage(error instanceof ApiError ? error.message : "Could not reach the server.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // B10: fetch AI pause + usage once on mount (server truth; the card hides
  // entirely when the server has no provider key configured).
  useEffect(() => {
    let cancelled = false;
    void fetchAiSettings()
      .then((settings) => {
        if (!cancelled) setAiSettings(settings);
      })
      .catch(() => {
        /* advisory-only card — a failed fetch just leaves it absent */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleAiPause(paused: boolean): Promise<void> {
    playSound("ui-click");
    setAiBusy(true);
    setAiMessage("");
    try {
      const next = await setAiPaused(paused);
      setAiSettings((prev) => (prev ? { ...prev, paused: next.paused } : prev));
      setAiMessage(next.paused ? "AI analysis paused." : "AI analysis resumed.");
    } catch (error) {
      if (error instanceof ApiError && isSessionLoss(error)) {
        reportSessionLost(error.code);
        return;
      }
      playSound("blocked");
      setAiMessage(error instanceof ApiError ? error.message : "Could not reach the server.");
    } finally {
      setAiBusy(false);
    }
  }

  async function connectGoogle(): Promise<void> {
    playSound("ui-click");
    setGoogleBusy(true);
    try {
      const { authUrl } = await startGoogleConnect();
      // Full-page navigation to Google — the game unmounts with the page, which
      // is exactly what an OAuth redirect is; the callback returns here.
      window.location.assign(authUrl);
    } catch (error) {
      setGoogleBusy(false);
      if (error instanceof ApiError && isSessionLoss(error)) {
        reportSessionLost(error.code);
        return;
      }
      playSound("blocked");
      setGoogleMessage(error instanceof ApiError ? error.message : "Could not reach the server.");
    }
  }

  async function disconnectGoogle(accountId: string): Promise<void> {
    playSound("ui-click");
    setGoogleBusy(true);
    try {
      await disconnectGoogleAccount(accountId);
      setGoogleStatus(await fetchGoogleStatus());
      setGoogleMessage("Google account disconnected.");
    } catch (error) {
      if (error instanceof ApiError && isSessionLoss(error)) {
        reportSessionLost(error.code);
        return;
      }
      playSound("blocked");
      setGoogleMessage(error instanceof ApiError ? error.message : "Could not reach the server.");
    } finally {
      setGoogleBusy(false);
    }
  }

  /** B8a — resend the verification email (session supplies the identity).
   *  Outside production the response carries the raw token (B4 dev-mode
   *  decision), so the card can offer one-click verification below. */
  async function resendVerification(): Promise<void> {
    playSound("ui-click");
    setVerifyBusy(true);
    setDevToken(null);
    try {
      const { devDelivery } = await resendVerificationEmail();
      if (devDelivery) {
        setDevToken(devDelivery.token);
        setGoogleMessage(
          "Development mode: verification token received — press “Verify now” to complete it.",
        );
      } else {
        setGoogleMessage("If this address has an account, a verification email is on its way.");
      }
    } catch (error) {
      playSound("blocked");
      setGoogleMessage(error instanceof ApiError ? error.message : "Could not reach the server.");
    } finally {
      setVerifyBusy(false);
    }
  }

  /** B8a — redeem the dev-mode token immediately (same endpoint the emailed
   *  link uses), then refetch status so the Connect button appears. */
  async function verifyNow(): Promise<void> {
    if (devToken === null) return;
    playSound("ui-click");
    setVerifyBusy(true);
    try {
      await verifyEmailToken(devToken);
      setDevToken(null);
      setGoogleMessage("Email verified — you can connect Google now.");
      setGoogleStatus(await fetchGoogleStatus());
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Already verified (e.g. via the emailed link meanwhile) — same result.
        setDevToken(null);
        setGoogleMessage("Email already verified — you can connect Google now.");
        setGoogleStatus(await fetchGoogleStatus());
        return;
      }
      playSound("blocked");
      setGoogleMessage(
        error instanceof ApiError && error.status === 404
          ? "That token is invalid or expired — resend the email and try again."
          : error instanceof ApiError
            ? error.message
            : "Could not reach the server.",
      );
    } finally {
      setVerifyBusy(false);
    }
  }

  function toggleMute(checked: boolean): void {
    setPrefs({ muted: checked });
    if (!checked) playSound("ui-click"); // audible confirmation that sound is back
    setMessage(checked ? "Sound muted." : "Sound on.");
  }

  function resetDemo(): void {
    if (!confirmReset) {
      setConfirmReset(true);
      setMessage("Press “Reset everything” again to confirm — this clears balance, items, decor and preferences.");
      return;
    }
    resetProfile();
    setConfirmReset(false);
    playSound("cancel");
    setMessage("Demo data reset: balance, items, decor and preferences are back to defaults.");
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {/* ----------------------------------------------------------- account */}
      <section
        aria-label="Account"
        className="rounded-lg border-2 border-[var(--mailxp-teal)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Account</h2>
        <p className="mt-1 break-all text-sm text-[var(--mailxp-walnut)]">
          Signed in as <span className="font-semibold">{auth.player?.email}</span>
        </p>
        <button
          type="button"
          onClick={() => {
            playSound("ui-nav");
            void signOut();
          }}
          className="mt-3 rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/60"
        >
          Sign out
        </button>
      </section>

      {/* --------------------------------------------------- google (B8) */}
      <section
        aria-label="Google connection"
        className="rounded-lg border-2 border-[var(--mailxp-teal)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Google connection</h2>
        <p className="mt-1 text-xs opacity-70">
          Optional — link a Google account so future quest phases can read your Gmail for tasks. MailXP
          never sends, deletes, or changes mail without your explicit approval, and the game plays fine
          without it.
        </p>

        {googleStatus !== null && (
          <div className="mt-3 flex flex-col gap-2 text-sm">
            {/* B8b: exactly ONE current Gmail per MailXP account (phase_b8b.md
                §6). Any additional rows are released history — never offered
                as "another account to connect". */}
            {googleStatus.accounts
              .filter((account) => account.status === "connected")
              .map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between gap-3 rounded border border-[var(--mailxp-walnut)]/40 bg-white/50 px-2 py-1.5"
                >
                  <span className="break-all">
                    {account.email} <span className="text-xs opacity-60">(connected)</span>
                  </span>
                  <button
                    type="button"
                    disabled={googleBusy}
                    onClick={() => void disconnectGoogle(account.id)}
                    className="shrink-0 rounded border-2 border-red-700 px-2 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                </div>
              ))}

            {/* B8b: "Switch Gmail" — one mailbox at a time. Disconnect the
                current one FIRST, then connect the new one. No silent replace,
                no "connect a second mailbox". */}
            {googleStatus.configured &&
              googleStatus.emailVerified &&
              googleStatus.accounts.some((account) => account.status === "connected") && (
                <p className="text-xs opacity-70">
                  Each MailXP account keeps one Gmail. To switch, disconnect the current address above
                  first — then connect the new one. Disconnecting removes MailXP&apos;s saved connection
                  (and asks Google to revoke access); it never deletes your Gmail or its messages.
                </p>
              )}

            {googleStatus.configured && googleStatus.emailVerified ? (
              !googleStatus.accounts.some((account) => account.status === "connected") ? (
                <button
                  type="button"
                  disabled={googleBusy}
                  onClick={() => void connectGoogle()}
                  className="mt-1 self-start rounded border-2 border-[var(--mailxp-teal)] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/60 disabled:opacity-50"
                >
                  {googleBusy ? "Opening Google…" : "Connect Google"}
                </button>
              ) : null
            ) : (
              <div className="flex flex-col items-start gap-2">
                <p className="text-xs opacity-70">
                  {!googleStatus.configured
                    ? `Not configured on this server (missing: ${googleStatus.missing.join(", ")}).`
                    : "Verify your email address first — then you can connect Google."}
                </p>
                {/* B8a: unlock Connect Google without the console — resend the
                    verification email, then (dev-only) redeem the surfaced
                    token with one click. Production shows only the resend. */}
                {googleStatus.configured && !googleStatus.emailVerified ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={verifyBusy}
                      onClick={() => void resendVerification()}
                      className="rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/60 disabled:opacity-50"
                    >
                      {verifyBusy ? "Working…" : "Resend verification email"}
                    </button>
                    {devToken !== null ? (
                      <button
                        type="button"
                        disabled={verifyBusy}
                        onClick={() => void verifyNow()}
                        className="rounded border-2 border-[var(--mailxp-teal)] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/60 disabled:opacity-50"
                      >
                        Verify now (development)
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}

        <p className="mt-3 text-sm" role="status">
          {googleMessage}
        </p>
      </section>

      {/* --------------------------------------------------- AI assistance (B10) */}
      {aiSettings?.configured ? (
        <section
          aria-label="AI assistance"
          className="rounded-lg border-2 border-[var(--mailxp-teal)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
        >
          <h2 className="text-base font-bold text-[var(--mailxp-teal)]">AI assistance</h2>
          <p className="mt-1 text-xs opacity-70">
            Optional — let MailXP read a message&apos;s subject and body to suggest a category,
            priority, summary, deadlines and action items. Advisory only: nothing is sent, sent,
            deleted, or changed in your Gmail, and suggestions never act on your account. Each
            analyzed message uses one unit of the daily budget below.
          </p>

          <div className="mt-3 flex flex-col gap-2 text-sm">
            <label className="flex items-center gap-3 font-semibold">
              <input
                type="checkbox"
                checked={aiSettings.paused}
                disabled={aiBusy}
                onChange={(event) => void toggleAiPause(event.target.checked)}
                className="h-4 w-4 accent-[var(--mailxp-teal)]"
              />
              Pause AI analysis (blocks background and manual analysis)
            </label>
            <p className="text-xs opacity-70">
              Today&apos;s usage:{" "}
              <span className="font-semibold tabular-nums">
                {aiSettings.usage.used} / {aiSettings.usage.cap}
              </span>{" "}
              — resets {new Date(aiSettings.usage.resetsAtUtc).toLocaleTimeString()} UTC day.
            </p>
          </div>

          <p className="mt-3 text-sm" role="status">
            {aiMessage}
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------------- sound */}
      <section
        aria-label="Sound settings"
        className="rounded-lg border-2 border-[var(--mailxp-teal)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Sound</h2>
        <p className="mt-1 text-xs opacity-70">
          All effects are synthesized in code with the Web Audio API — no audio files are
          downloaded and there is no background music. Audio starts only after your first
          click or key press (no autoplay).
        </p>

        <div className="mt-3 flex flex-col gap-3">
          <label className="flex items-center gap-3 text-sm font-semibold">
            <input
              type="checkbox"
              checked={prefs.muted}
              onChange={(event) => toggleMute(event.target.checked)}
              className="h-4 w-4 accent-[var(--mailxp-teal)]"
            />
            Mute all sound (takes effect immediately)
          </label>

          <VolumeSlider
            label="Master volume"
            value={prefs.masterVolume}
            onChange={(masterVolume) => setPrefs({ masterVolume })}
          />
          <VolumeSlider
            label="UI volume"
            value={prefs.uiVolume}
            onChange={(uiVolume) => setPrefs({ uiVolume })}
          />
          <VolumeSlider
            label="Game volume"
            value={prefs.gameVolume}
            onChange={(gameVolume) => setPrefs({ gameVolume })}
          />

          <div>
            <button
              type="button"
              onClick={() => {
                playSound("ui-nav");
                setMessage("Test chime played on the UI bus.");
              }}
              className="rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/60"
            >
              Play test sound
            </button>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ motion */}
      <section
        aria-label="Motion settings"
        className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Motion</h2>
        <p className="mt-1 text-xs opacity-70">
          Your system&apos;s reduced-motion preference is always respected for interface
          animation; this setting additionally parks the in-game bobbing markers and
          banner fades.
        </p>
        <fieldset className="mt-3 flex flex-col gap-2 text-sm">
          <legend className="sr-only">Motion level</legend>
          {(
            [
              { value: "full" as MotionSetting, label: "Full motion — animations and effects" },
              { value: "reduced" as MotionSetting, label: "Reduced motion — calmer markers and panels" },
            ]
          ).map((option) => (
            <label key={option.value} className="flex items-center gap-2">
              <input
                type="radio"
                name="motion"
                value={option.value}
                checked={prefs.motion === option.value}
                onChange={() => {
                  setPrefs({ motion: option.value });
                  playSound("ui-click");
                  setMessage(`Motion set to ${option.label.split(" —")[0].toLowerCase()}.`);
                }}
                className="h-4 w-4 accent-[var(--mailxp-teal)]"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </section>

      {/* ----------------------------------------------------------- controls */}
      <section
        aria-label="Control settings"
        className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Controls</h2>
        <p className="mt-1 text-xs opacity-70">
          Keyboard: arrow keys / WASD to walk, E to interact. The on-screen D-pad below the
          game works with touch and with the keyboard (hold Space/Enter on a focused pad
          button).
        </p>
        <fieldset className="mt-3 flex flex-col gap-2 text-sm">
          <legend className="sr-only">On-screen touch controls</legend>
          {(
            [
              { value: "auto" as TouchSetting, label: "Auto — show on touch devices" },
              { value: "on" as TouchSetting, label: "Always show the on-screen controls" },
              { value: "off" as TouchSetting, label: "Hide the on-screen controls" },
            ]
          ).map((option) => (
            <label key={option.value} className="flex items-center gap-2">
              <input
                type="radio"
                name="touchControls"
                value={option.value}
                checked={prefs.touchControls === option.value}
                onChange={() => {
                  setPrefs({ touchControls: option.value });
                  playSound("ui-click");
                  setMessage("Touch control preference saved.");
                }}
                className="h-4 w-4 accent-[var(--mailxp-teal)]"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </section>

      {/* ------------------------------------------------------- reset + info */}
      <section
        aria-label="Demo data"
        className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Demo data</h2>
        <p className="mt-1 text-xs opacity-70">
          Your signed-in progress is saved to your account on the server. This browser keeps a
          local copy (and a one-time backup of your pre-sign-in data) for instant loading.
          Resetting clears the local copy: preferences go back to defaults (synced to your
          account), while coins, items, outfit and decor resync from your saved account state.
        </p>
        <button
          type="button"
          onClick={resetDemo}
          className="mt-3 rounded border-2 border-red-700 px-3 py-1.5 text-sm font-semibold text-red-700 transition hover:bg-red-50"
        >
          {confirmReset ? "Reset everything (press again to confirm)" : "Reset demo data"}
        </button>

        <p className="mt-3 text-sm" role="status">
          {message}
        </p>
      </section>
    </div>
  );
}
