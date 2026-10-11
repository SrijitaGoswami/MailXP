/**
 * Phase 6 — synthesized sound effect library (Web Audio API only).
 *
 * Every effect is generated in code from oscillators and a shared white-noise
 * buffer: no audio files are downloaded, no sound library is used, and no
 * music/ambience is added (per the phase spec — the project ships no licensed
 * audio). Recipes are short (all under ~0.55 s), gentle, and share one voicing
 * style (triangle/sine blips, soft filtered noise) so they stay cohesive.
 *
 * Playback, throttling, volume buses and persistence live in
 * `audioManager.ts`; this module only knows *how* each named event sounds.
 * If licensed audio files are ever added, `audioManager` can override an
 * event with a file without touching this module.
 */

export type SoundEvent =
  // --- React UI ---
  | "ui-click"
  | "ui-nav"
  | "panel-open"
  | "panel-close"
  | "equip"
  | "purchase"
  | "cancel"
  | "blocked"
  // --- Office gameplay ---
  | "footstep"
  | "interact"
  | "talk"
  | "bump"
  // --- Mail & quests ---
  | "mail-pickup"
  | "quest-start"
  | "agent-dispatch"
  | "agent-arrive"
  | "classified"
  | "draft-ready"
  | "review-open"
  | "send-confirm"
  | "bird-launch"
  | "bird-flap"
  | "bird-pass"
  | "reward"
  | "quest-complete"
  | "level-up";

export type SoundBus = "ui" | "game";

/** Which volume bus each event plays through. */
export const SOUND_BUS: Record<SoundEvent, SoundBus> = {
  "ui-click": "ui",
  "ui-nav": "ui",
  "panel-open": "ui",
  "panel-close": "ui",
  equip: "ui",
  purchase: "ui",
  cancel: "ui",
  blocked: "ui",
  footstep: "game",
  interact: "game",
  talk: "game",
  bump: "game",
  "mail-pickup": "game",
  "quest-start": "game",
  "agent-dispatch": "game",
  "agent-arrive": "game",
  classified: "game",
  "draft-ready": "game",
  "review-open": "ui",
  "send-confirm": "game",
  "bird-launch": "game",
  "bird-flap": "game",
  "bird-pass": "game",
  reward: "game",
  "quest-complete": "game",
  "level-up": "game",
};

/**
 * Minimum milliseconds between two plays of the same repeatable event —
 * footsteps/flaps/talk bumps cannot spam no matter how hard input hammers them.
 */
export const SOUND_MIN_GAP: Partial<Record<SoundEvent, number>> = {
  footstep: 230,
  bump: 450,
  talk: 160,
  interact: 120,
  "bird-flap": 130,
  "ui-click": 50,
  "ui-nav": 70,
  cancel: 90,
  reward: 160,
};

/** What a recipe needs to schedule sound on the shared graph. */
export interface SynthContext {
  ctx: AudioContext;
  /** Bus-scaled destination node (already multiplied by master × bus volume). */
  out: GainNode;
  /** Absolute time to schedule at (context time of the play call). */
  now: number;
  /** Shared white-noise buffer (1 s), created once per AudioContext. */
  noise: AudioBuffer;
}

export type SoundRecipe = (sc: SynthContext) => void;

// ------------------------------------------------------------------- helpers --

interface ToneOptions {
  freq: number;
  /** Optional end frequency (glide) — set above 0; ramps exponentially. */
  to?: number;
  type?: OscillatorType;
  dur: number;
  gain?: number;
  delay?: number;
}

/** One enveloped oscillator blip. */
function tone(sc: SynthContext, opts: ToneOptions): void {
  const { ctx, out, now } = sc;
  const t0 = now + (opts.delay ?? 0);
  const dur = Math.max(0.02, opts.dur);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type ?? "triangle";
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.to && opts.to > 0) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t0 + dur);
  }
  const peak = opts.gain ?? 0.28;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.014, dur * 0.3));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

interface NoiseOptions {
  dur: number;
  gain?: number;
  delay?: number;
  type?: BiquadFilterType;
  freq?: number;
  toFreq?: number;
}

/** One filtered white-noise burst (steps, whooshes, paper). */
function noise(sc: SynthContext, opts: NoiseOptions): void {
  const { ctx, out, now, noise: buffer } = sc;
  const t0 = now + (opts.delay ?? 0);
  const dur = Math.max(0.02, opts.dur);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = opts.type ?? "lowpass";
  const f0 = opts.freq ?? 1400;
  filter.frequency.setValueAtTime(f0, t0);
  if (opts.toFreq && opts.toFreq > 0) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.toFreq), t0 + dur);
  }
  const gain = ctx.createGain();
  const peak = opts.gain ?? 0.16;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, dur * 0.3));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.03);
}

/** Rising/falling note sequence — the shared "positive" motif. */
function arp(sc: SynthContext, freqs: number[], step: number, opts: { type?: OscillatorType; gain?: number } = {}): void {
  freqs.forEach((freq, i) => {
    tone(sc, { freq, dur: step * 1.6, delay: i * step, type: opts.type ?? "triangle", gain: opts.gain ?? 0.24 });
  });
}

// ------------------------------------------------------------------ recipes --

export const SOUND_RECIPES: Record<SoundEvent, SoundRecipe> = {
  // --- React UI: tiny, dry, unobtrusive ---
  "ui-click": (sc) => tone(sc, { freq: 660, dur: 0.055, type: "square", gain: 0.16 }),
  "ui-nav": (sc) => {
    tone(sc, { freq: 560, dur: 0.045, type: "triangle", gain: 0.16 });
    tone(sc, { freq: 700, dur: 0.05, delay: 0.045, type: "triangle", gain: 0.16 });
  },
  "panel-open": (sc) => tone(sc, { freq: 470, to: 690, dur: 0.13, type: "sine", gain: 0.2 }),
  "panel-close": (sc) => tone(sc, { freq: 690, to: 470, dur: 0.13, type: "sine", gain: 0.2 }),
  equip: (sc) => {
    tone(sc, { freq: 523, dur: 0.07, type: "square", gain: 0.14 });
    tone(sc, { freq: 784, dur: 0.1, delay: 0.07, type: "square", gain: 0.14 });
  },
  purchase: (sc) => arp(sc, [523, 659, 784, 1047], 0.065, { type: "triangle", gain: 0.22 }),
  cancel: (sc) => tone(sc, { freq: 392, to: 300, dur: 0.12, type: "triangle", gain: 0.18 }),
  // Blocked/insufficient funds: low soft double tick, deliberately not harsh.
  blocked: (sc) => {
    tone(sc, { freq: 196, dur: 0.06, type: "square", gain: 0.13 });
    tone(sc, { freq: 165, dur: 0.07, delay: 0.08, type: "square", gain: 0.13 });
  },

  // --- Office: quiet and restrained ---
  footstep: (sc) => noise(sc, { dur: 0.045, gain: 0.1, freq: 850, type: "lowpass" }),
  interact: (sc) => {
    tone(sc, { freq: 784, dur: 0.06, type: "sine", gain: 0.2 });
    noise(sc, { dur: 0.03, gain: 0.08, freq: 2400, delay: 0.055 });
  },
  // Conversation pop — soft paired blips, plays at most every 160 ms.
  talk: (sc) => {
    tone(sc, { freq: 587, dur: 0.05, type: "sine", gain: 0.17 });
    tone(sc, { freq: 523, dur: 0.05, delay: 0.07, type: "sine", gain: 0.15 });
  },
  bump: (sc) => tone(sc, { freq: 130, to: 82, dur: 0.08, type: "sine", gain: 0.2 }),

  // --- Mail & quests: the positive motif, then short flourishes ---
  "mail-pickup": (sc) => {
    tone(sc, { freq: 659, to: 880, dur: 0.12, type: "triangle", gain: 0.22 });
    noise(sc, { dur: 0.06, gain: 0.08, freq: 3000, type: "highpass", delay: 0.02 });
  },
  "quest-start": (sc) => arp(sc, [440, 554, 659], 0.07),
  "agent-dispatch": (sc) => tone(sc, { freq: 494, to: 620, dur: 0.16, type: "triangle", gain: 0.2 }),
  "agent-arrive": (sc) => arp(sc, [659, 784], 0.07),
  classified: (sc) => tone(sc, { freq: 880, to: 1175, dur: 0.12, type: "sine", gain: 0.2 }),
  "draft-ready": (sc) => arp(sc, [659, 831, 988], 0.07, { type: "sine", gain: 0.2 }),
  "review-open": (sc) => tone(sc, { freq: 620, to: 880, dur: 0.14, type: "sine", gain: 0.2 }),
  "send-confirm": (sc) => {
    arp(sc, [523, 659, 784, 1047], 0.06, { type: "triangle", gain: 0.22 });
    noise(sc, { dur: 0.24, gain: 0.1, freq: 700, toFreq: 2600, delay: 0.12 });
  },
  "bird-launch": (sc) => noise(sc, { dur: 0.26, gain: 0.14, freq: 500, toFreq: 2200 }),
  // Wing beat — very short, throttled to ≥130 ms in the manager.
  "bird-flap": (sc) => noise(sc, { dur: 0.035, gain: 0.07, freq: 1800, type: "bandpass" }),
  "bird-pass": (sc) => tone(sc, { freq: 1047, to: 1568, dur: 0.16, type: "sine", gain: 0.18 }),
  reward: (sc) => {
    tone(sc, { freq: 988, dur: 0.06, type: "square", gain: 0.14 });
    tone(sc, { freq: 1319, dur: 0.12, delay: 0.06, type: "square", gain: 0.14 });
  },
  "quest-complete": (sc) => arp(sc, [523, 659, 784, 1047], 0.08, { type: "triangle", gain: 0.24 }),
  "level-up": (sc) => {
    arp(sc, [523, 659, 784, 1047], 0.07, { type: "triangle", gain: 0.24 });
    tone(sc, { freq: 1319, dur: 0.22, delay: 0.28, type: "sine", gain: 0.18 });
  },
};

/**
 * Optional file overrides for licensed audio supplied later (empty today —
 * nothing is fetched, no audio file ships with the project). Drop a path in
 * and the manager plays that file instead of the synthesized recipe.
 */
export const SOUND_FILE_OVERRIDES: Partial<Record<SoundEvent, string>> = {};
