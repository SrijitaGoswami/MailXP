import * as Phaser from "phaser";

import { BootScene } from "./scenes/BootScene";
import { PreloadScene } from "./scenes/PreloadScene";

/**
 * Design-baseline stage size (Phase 3–6 fixed 16:9 stage). Phase 7 renders the
 * game with `Scale.RESIZE`, so the canvas fills its container and the camera
 * reveals more of the office on larger screens at a crisp 1:1 pixel scale.
 * These constants remain the baseline the HUD/layout was authored against and
 * the fallback size if the parent has no dimensions at boot.
 */
export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;

/**
 * Base Phaser configuration for the MailXP game shell.
 *
 * - `pixelArt` / `roundPixels`: crisp nearest-neighbor rendering per the asset guide.
 * - `Scale.RESIZE` (Phase 7): the canvas always fills its parent container;
 *   OfficeScene keeps the camera at zoom 1 so art never stretches — bigger
 *   screens simply show more of the office. (`createGame` swaps in `Scale.FIT`
 *   for the /preview route, whose container is a fixed 16:9 box.)
 * - `parent` is supplied at creation time by `createGame`.
 */
export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: "#f7f1e3",
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, PreloadScene], // full list is supplied by createGame
};
