import * as Phaser from "phaser";

/**
 * One-shot effect frames available in the `mail-effects` atlas (Phase 5 wiring
 * of the planned sparkle/ring and quest/pickup/coin/level-up effects).
 */
export type EffectFrame =
  | "sparkle"
  | "interaction-ring"
  | "pickup-burst"
  | "coin-burst"
  | "quest-burst"
  | "levelup-burst"
  | "draftcoin"
  | "reward-token";

export interface EffectOptions {
  /** Display height in world px (effects ship as ~308 px source art). */
  size?: number;
  /** Depth for the effect (defaults to the world y so it depth-sorts correctly). */
  depth?: number;
  /** Total tween duration, ms. */
  duration?: number;
  /** Final scale multiplier (defaults to a gentle 1.35× grow). */
  growTo?: number;
  /** Ring-style pop: start small and expand instead of growing from 1×. */
  startFrom?: number;
}

/**
 * Plays a brief effect at a world position and destroys it when the tween ends.
 * Safe to call on a scene that is shutting down (killTweensOf is a no-op).
 */
export function playEffect(
  scene: Phaser.Scene,
  frame: EffectFrame,
  x: number,
  y: number,
  options: EffectOptions = {},
): Phaser.GameObjects.Image | null {
  if (!scene.textures.exists("mail-effects") || !scene.textures.get("mail-effects").has(frame)) {
    console.error(`[MailXP] effect frame '${frame}' missing from mail-effects atlas`);
    return null;
  }

  const size = options.size ?? 70;
  const duration = options.duration ?? 520;
  const growTo = options.growTo ?? 1.35;
  const startFrom = options.startFrom ?? 1;

  const image = scene.add
    .image(x, y, "mail-effects", frame)
    .setOrigin(0.5, 0.5)
    .setScale(startFrom)
    .setDepth(options.depth ?? y);

  // Fit the (roughly square) source art to the requested display size.
  const frameSize = scene.textures.get("mail-effects").get(frame);
  const base = size / Math.max(frameSize.width, frameSize.height);
  image.setScale(base * startFrom);

  scene.tweens.add({
    targets: image,
    scale: base * growTo,
    alpha: { from: 1, to: 0 },
    ease: "Quad.easeOut",
    duration,
    onComplete: () => image.destroy(),
  });

  return image;
}
