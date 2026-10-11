"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { initAudioManager, playSound } from "../game/audio/audioManager";
import { sendCommand, type GameSnapshot } from "../game/bridge";
import AuthPanel from "./AuthPanel";
import { probeAuth, signOut, useAuth, type AuthStatus } from "./authStore";
import GameAnnouncer from "./GameAnnouncer";
import GameHud from "./GameHud";
import GameMenu, { type MenuSection } from "./GameMenu";
import PhaserCanvas from "./PhaserCanvas";
import TouchControls from "./TouchControls";
import { useGameSnapshot, useProfile } from "./useGameState";
import { useGameSync } from "./useGameSync";

/**
 * Phase 7 — the full-screen game shell.
 *
 * The page frame, header, tab strip, instruction panel and footer from Phase 6
 * are gone: MailXP is now a full-viewport game with a minimal title overlay,
 * a compact HUD, and one in-game Menu button whose side panel holds every
 * screen (Tasks, Character, Inventory, Shop, Rewards, Settings).
 *
 * Layout contract (unchanged from Phase 6 where it still applies):
 * **the Phaser canvas is rendered once and never unmounts** — the title
 * overlay and the menu panel sit on top of it, so navigating menus or
 * returning to play can never reset the game.
 *
 * Flow:
 * - Boot: OfficeScene starts paused underneath the title overlay (branding +
 *   tagline + Play). Play unpauses via the bridge's `set-paused` command.
 * - Menu open → game pauses; close (button, Escape, backdrop) resumes.
 * - The reply review auto-opens the menu on Tasks (the send flow is always
 *   reachable); a confirmed send closes the menu so the mail-bird is visible.
 *
 * Also owns: audio manager lifecycle (gesture unlock, volume binding,
 * tab-hide suspend), the <html data-motion> mirror, the sr-only aria-live
 * announcer, and focus return to the Menu button when the panel closes.
 */
export default function AppShell() {
  const snapshot: GameSnapshot = useGameSnapshot();
  const profile = useProfile();
  const auth = useAuth();

  /** Title overlay vs. play: the office is live (paused) from boot either way. */
  const [started, setStarted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [section, setSection] = useState<MenuSection>("tasks");

  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const playButtonRef = useRef<HTMLButtonElement>(null);
  const prevAuthStatusRef = useRef<AuthStatus>("checking");
  const wasReviewOpen = useRef(false);
  const wasSending = useRef(false);

  // Fullscreen: user-invoked only (a button — never automatic), detected
  // after mount so server HTML and hydration stay identical.
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Audio: gesture unlock + immediate volume/mute binding + tab-hide suspend.
  useEffect(() => initAudioManager(), []);

  // B5: one session probe at boot — identity comes from GET /me only
  // (never inferred from localStorage, phase §5).
  useEffect(() => {
    void probeAuth();
  }, []);

  // B5: authoritative state mirror + prefs sync + SSE while signed in;
  // the effect tears everything down on sign-out/session loss.
  useGameSync(auth.status === "signedIn");

  // Strict gate: sign-out or session expiry drops back to the overlay.
  // Overlay state only — the Phaser canvas stays mounted (mount-once). The
  // game menu belongs to the play session, so it closes with it: a dialog
  // must never float over the sign-in gate (live-verified B5 scenario: the
  // Settings → Sign out button sits INSIDE the open menu).
  useEffect(() => {
    if (auth.status === "signedIn") return;
    if (started) setStarted(false);
    if (menuOpen) setMenuOpen(false);
  }, [started, menuOpen, auth.status]);

  // Focus discipline across gate transitions: a fresh sign-in hands focus
  // to the Play button (the form unmounts, so its field would be lost).
  useEffect(() => {
    const previous = prevAuthStatusRef.current;
    prevAuthStatusRef.current = auth.status;
    if (auth.status === "signedIn" && previous === "signedOut" && !started) {
      requestAnimationFrame(() => playButtonRef.current?.focus());
    }
  }, [auth.status, started]);

  // Fullscreen support + live label state (Esc exits via the browser too).
  useEffect(() => {
    setFullscreenSupported(typeof document.documentElement.requestFullscreen === "function");
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Mirror the local motion preference onto <html> for stylesheet rules.
  useEffect(() => {
    document.documentElement.dataset.motion = profile.prefs.motion;
  }, [profile.prefs.motion]);

  // The game owns the viewport: prevent page-level scrolling while mounted.
  useEffect(() => {
    document.body.classList.add("mailxp-game-active");
    return () => document.body.classList.remove("mailxp-game-active");
  }, []);

  // One pause switch for both overlays (title before Play, menu while open).
  useEffect(() => {
    sendCommand({ type: "set-paused", paused: !started || menuOpen });
  }, [started, menuOpen]);

  // The reply review must stay reachable: whenever the Response Worker opens
  // it, bring up the menu on Tasks (the old shell switched to the Game tab).
  useEffect(() => {
    if (snapshot.reviewOpen && !wasReviewOpen.current) {
      setSection("tasks");
      setMenuOpen(true);
    }
    wasReviewOpen.current = snapshot.reviewOpen;
  }, [snapshot.reviewOpen]);

  // A confirmed send closes the menu so the player watches the mail-bird fly.
  useEffect(() => {
    if (snapshot.sending && !wasSending.current) setMenuOpen(false);
    wasSending.current = snapshot.sending;
  }, [snapshot.sending]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  const openMenu = useCallback((next: MenuSection) => {
    playSound("panel-open");
    setSection(next);
    setMenuOpen(true);
  }, []);

  function startGame(): void {
    if (auth.status !== "signedIn") return; // strict gate — Play exists only when signed in
    playSound("ui-nav");
    setStarted(true);
    // The Play button unmounts with the overlay — hand focus to the Menu
    // button so keyboard focus never falls back to <body>.
    requestAnimationFrame(() => menuButtonRef.current?.focus());
  }

  /** Sign out via B4 logout: the store flips → the effect above closes play. */
  function handleSignOut(): void {
    playSound("ui-nav");
    void signOut();
  }

  /** F11 equivalent: fill the monitor with the game (page stays 100dvh). */
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => {
        /* Browser policy/permission declined — stay windowed, no dead state. */
      });
    }
  }, []);

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-[var(--mailxp-cream)]">
      {/* ------------- game window: mounted ONCE, fills the viewport -------- */}
      <div id="mailxp-stage" className="absolute inset-0">
        <PhaserCanvas />
      </div>

      {/* ------------------------------------------- minimal title overlay -- */}
      {/* Signed-out: auth gate (login/register) · signed-in: Play · checking:
          a neutral status line. All overlay state — the canvas never remounts. */}
      {!started ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-5 bg-gradient-to-b from-[var(--mailxp-cream)]/85 via-[var(--mailxp-cream)]/45 to-[var(--mailxp-cream)]/85 px-6 text-center">
          <h1 className="text-6xl font-black tracking-tight text-[var(--mailxp-teal)] drop-shadow-[0_2px_0_rgba(91,66,50,0.35)] sm:text-7xl">
            MailXP
          </h1>
          <p className="text-base font-semibold tracking-wide text-[var(--mailxp-walnut)] sm:text-lg">
            Deliver. Grow. Level Up.
          </p>

          {auth.status === "checking" ? (
            <p role="status" className="text-sm font-semibold text-[var(--mailxp-walnut)]">
              Checking your session…
            </p>
          ) : auth.status === "signedOut" ? (
            <AuthPanel onSignedIn={() => playSound("ui-nav")} />
          ) : (
            <>
              <button
                ref={playButtonRef}
                type="button"
                onClick={startGame}
                className="mt-2 rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-teal)] px-10 py-3.5 text-xl font-bold text-white shadow-lg transition hover:opacity-90 active:translate-y-px"
              >
                Play
              </button>
              <div className="flex items-center gap-3 text-sm text-[var(--mailxp-walnut)]">
                <span className="max-w-[50vw] truncate opacity-75" title={auth.player?.email ?? undefined}>
                  {auth.player?.email}
                </span>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="rounded border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)]/90 px-3 py-1 text-xs font-bold shadow transition hover:opacity-90"
                >
                  Sign out
                </button>
              </div>
              <p className="absolute bottom-14 text-xs opacity-70">
                Progress saves to your account.
              </p>
            </>
          )}
        </div>
      ) : null}

      {/* ------------------------------------------------------- in-game -- */}
      {started ? (
        <>
          <GameHud snapshot={snapshot} onOpenTasks={() => openMenu("tasks")} />

          <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
            {fullscreenSupported ? (
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-pressed={isFullscreen}
                className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)]/95 px-3 py-1.5 text-sm font-bold text-[var(--mailxp-walnut)] shadow-md transition hover:opacity-90"
              >
                {isFullscreen ? "Exit full screen" : "Full screen"}
              </button>
            ) : null}

            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)]/95 px-3 py-1.5 text-sm font-bold text-[var(--mailxp-walnut)] shadow-md transition hover:opacity-90"
            >
              Sign out
            </button>

            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => (menuOpen ? closeMenu() : openMenu(section))}
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              aria-label={menuOpen ? "Close game menu" : "Open game menu"}
              className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)]/95 px-3 py-1.5 text-sm font-bold text-[var(--mailxp-walnut)] shadow-md transition hover:opacity-90"
            >
              ☰ Menu
            </button>
          </div>

          <TouchControls hidden={menuOpen} />
        </>
      ) : null}

      {/* -------- side panel overlay: pauses the game while open ----------- */}
      <GameMenu
        open={menuOpen}
        section={section}
        onSectionChange={setSection}
        onClose={closeMenu}
      />

      {/* sr-only aria-live announcements (accessibility half of the old
          instruction panel — see GameAnnouncer). */}
      <GameAnnouncer active={started} />
    </div>
  );
}
