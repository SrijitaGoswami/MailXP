"use client";

import { useEffect, useState } from "react";

import { sendCommand, type TouchDir } from "../game/bridge";
import { useProfile } from "./useGameState";

/**
 * On-screen movement controls so the game works without a keyboard
 * (Phase 6 feature; Phase 7 moved it onto the game as a corner overlay).
 *
 * - A 4-way D-pad and an Interact (E) button send the typed `touch-move` and
 *   `interact` bridge commands; OfficeScene merges D-pad directions with the
 *   arrow/WASD keys, so both input methods can be mixed freely.
 * - Visibility follows Settings → touch controls: `auto` (shown only on
 *   coarse-pointer/touch devices), `on`, `off`. AppShell also hides the pad
 *   while a menu panel is open or before Play.
 * - Each pad button presses on pointer-down and releases on pointer-up/leave/
 *   cancel (so sliding off a key never leaves the player walking), and works
 *   from the keyboard too (hold Space/Enter on the focused button) — no dead
 *   controls for any input method.
 *
 * The pad overlays the bottom-left corner of the fullscreen game and the
 * interact button the bottom-right (Phase 7); the wrapper itself ignores
 * pointer events so taps between the controls still reach the canvas (decor
 * placement). Each button re-enables pointer events for itself. The whole pad
 * is hidden while a menu panel is open or before Play.
 */
export default function TouchControls({ hidden = false }: { hidden?: boolean }) {
  const profile = useProfile();
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const pref = profile.prefs.touchControls;
  const visible = !hidden && (pref === "on" || (pref === "auto" && coarse));
  if (!visible) return null;

  const setDir = (dir: TouchDir, pressed: boolean) =>
    sendCommand({ type: "touch-move", dir, pressed });

  const padButton = (dir: TouchDir, glyph: string, label: string) => (
    <button
      type="button"
      aria-label={label}
      className="pointer-events-auto flex h-14 w-14 select-none items-center justify-center rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)]/95 text-xl font-bold text-[var(--mailxp-teal)] shadow active:bg-[var(--mailxp-teal)] active:text-white"
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        e.preventDefault();
        setDir(dir, true);
      }}
      onPointerUp={() => setDir(dir, false)}
      onPointerLeave={() => setDir(dir, false)}
      onPointerCancel={() => setDir(dir, false)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          setDir(dir, true);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") setDir(dir, false);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {glyph}
    </button>
  );

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-4 p-3"
      role="group"
      aria-label="Touch movement controls"
    >
      <div className="grid grid-cols-3 grid-rows-2 gap-1.5">
        <span aria-hidden="true" />
        {padButton("up", "▲", "Move up")}
        <span aria-hidden="true" />
        {padButton("left", "◀", "Move left")}
        {padButton("down", "▼", "Move down")}
        {padButton("right", "▶", "Move right")}
      </div>

      <button
        type="button"
        onClick={() => sendCommand({ type: "interact" })}
        className="pointer-events-auto h-16 w-16 select-none rounded-full border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-teal)] text-lg font-bold text-white shadow active:opacity-80"
        style={{ touchAction: "none" }}
      >
        E
        <span className="block text-[10px] font-normal">interact</span>
      </button>
    </div>
  );
}
