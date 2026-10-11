/**
 * Phase 6 — central typed audio manager.
 *
 * One AudioContext (created lazily, resumed only after the player's first
 * explicit gesture — never autoplayed), two volume buses (ui, game) behind a
 * master gain, instant mute, per-event throttles so repeatable sounds can't
 * spam, and preferences persisted through the local profile.
 *
 * React screens and Phaser scenes both call `playSound("event")`; this module
 * is framework-free (no Phaser import) so it never drags the game runtime into
 * the React bundle. Tab hide suspends the context (spec: pause audio when the
 * tab is hidden); there is no ambience or music to pause.
 *
 * All sounds are synthesized by `soundLibrary.ts` — no audio files, no
 * downloads, no sound library.
 */

import { getProfile, subscribeProfile } from "../profile";
import {
  SOUND_BUS,
  SOUND_MIN_GAP,
  SOUND_RECIPES,
  SOUND_FILE_OVERRIDES,
  type SoundBus,
  type SoundEvent,
  type SynthContext,
} from "./soundLibrary";

export type { SoundEvent, SoundBus };

// ------------------------------------------------------------------- state --

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
const busGains: Record<SoundBus, GainNode | null> = { ui: null, game: null };
let noiseBuffer: AudioBuffer | null = null;
let unlocked = false;
let initializing = false;

/** Monotonic throttle tracker (event -> ms timestamp of the last play). */
const lastPlayed: Record<string, number> = {};

/** Optional file-backed overrides, decoded after unlock (empty by default). */
const overrideBuffers = new Map<SoundEvent, AudioBuffer>();

// ------------------------------------------------------------- graph setup --

function applyVolumes(): void {
  if (!masterGain || !busGains.ui || !busGains.game) return;
  const prefs = getProfile().prefs;
  // Mute collapses the master gain immediately — already-sounding effects
  // drop out on the same frame (the spec's "muting takes effect immediately").
  masterGain.gain.value = prefs.muted ? 0 : prefs.masterVolume;
  busGains.ui.gain.value = prefs.uiVolume;
  busGains.game.gain.value = prefs.gameVolume;
}

function ensureGraph(): boolean {
  if (ctx) return true;
  if (typeof window === "undefined") return false;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return false;

  ctx = new Ctor();
  masterGain = ctx.createGain();
  masterGain.connect(ctx.destination);
  for (const bus of ["ui", "game"] as const) {
    const node = ctx.createGain();
    node.connect(masterGain);
    busGains[bus] = node;
  }

  // Shared white-noise source for every noise-based recipe.
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  applyVolumes();
  return true;
}

async function loadFileOverrides(): Promise<void> {
  if (!ctx) return;
  const entries = Object.entries(SOUND_FILE_OVERRIDES) as [SoundEvent, string][];
  if (entries.length === 0) return;
  await Promise.all(
    entries.map(async ([event, path]) => {
      if (overrideBuffers.has(event)) return;
      try {
        const response = await fetch(path);
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        overrideBuffers.set(event, await ctx!.decodeAudioData(bytes));
      } catch {
        // Missing/undecodable file — keep the synthesized recipe.
      }
    }),
  );
}

/** Resume the (already created) context from a user gesture. */
function unlockFromGesture(): void {
  if (unlocked) return;
  if (!ensureGraph() || !ctx) return;
  void ctx.resume().then(() => {
    unlocked = ctx?.state === "running";
    if (unlocked) void loadFileOverrides();
  });
}

// ---------------------------------------------------------------- public API --

/**
 * Install gesture unlock, tab-visibility suspend, and profile-driven volume
 * binding. Call once from a client component; returns an idempotent cleanup.
 */
export function initAudioManager(): () => void {
  if (initializing || typeof window === "undefined") return () => undefined;
  initializing = true;

  const gestureEvents = ["pointerdown", "keydown"] as const;
  const onGesture = () => unlockFromGesture();
  for (const event of gestureEvents) window.addEventListener(event, onGesture, { passive: true });

  const onVisibility = () => {
    if (!ctx || !unlocked) return;
    if (document.visibilityState === "hidden") void ctx.suspend();
    else void ctx.resume();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const unbindProfile = subscribeProfile(applyVolumes);
  applyVolumes();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    initializing = false;
    for (const event of gestureEvents) window.removeEventListener(event, onGesture);
    document.removeEventListener("visibilitychange", onVisibility);
    unbindProfile();
  };
}

/** True once the AudioContext has been resumed by a real user gesture. */
export function isAudioUnlocked(): boolean {
  return unlocked;
}

export interface PlayOptions {
  /** Extra gain multiplier (0 … 1) on top of the bus volume. */
  gain?: number;
  /** Override the bus recorded for this event (rarely needed). */
  bus?: SoundBus;
}

/**
 * Play a named event. Safe to call from anywhere and at any time:
 * - before the first gesture  → silently ignored (no autoplay),
 * - while muted              → ignored (unmute is instant for later plays),
 * - before the min-gap       → ignored (spam protection).
 */
export function playSound(event: SoundEvent, options: PlayOptions = {}): void {
  if (!ctx || !unlocked || !masterGain) return;
  const prefs = getProfile().prefs;
  if (prefs.muted || prefs.masterVolume <= 0) return;

  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const minGap = SOUND_MIN_GAP[event] ?? 0;
  if (minGap > 0 && now - (lastPlayed[event] ?? -Infinity) < minGap) return;
  lastPlayed[event] = now;

  const bus = options.bus ?? SOUND_BUS[event];
  const out = busGains[bus];
  if (!out || !noiseBuffer) return;

  const override = overrideBuffers.get(event);
  if (override) {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = options.gain ?? 1;
    source.buffer = override;
    source.connect(gain);
    gain.connect(out);
    source.start();
    return;
  }

  const recipe = SOUND_RECIPES[event];
  if (!recipe) {
    console.warn(`[MailXP] no sound recipe for '${event}'`);
    return;
  }

  const sc: SynthContext = { ctx, out, now: ctx.currentTime, noise: noiseBuffer };
  if (options.gain !== undefined && options.gain !== 1) {
    // Per-call gain: a temporary child bus so recipes stay unaware of it.
    const temp = ctx.createGain();
    temp.gain.value = options.gain;
    temp.connect(out);
    recipe({ ...sc, out: temp });
    // The temp node disconnects naturally once its sources have ended; to be
    // tidy, schedule the disconnect shortly after the longest recipe (~0.6 s).
    const node = temp;
    setTimeout(() => node.disconnect(), 900);
  } else {
    recipe(sc);
  }
}
