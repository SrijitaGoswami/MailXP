import * as Phaser from "phaser";

import { gameConfig } from "./config";
import { flow } from "./flow";
import { BootScene } from "./scenes/BootScene";
import { PreloadScene } from "./scenes/PreloadScene";
import { AssetPreviewScene } from "./scenes/AssetPreviewScene";
import { OfficeScene } from "./scenes/OfficeScene";

export interface CreateGameOptions {
  /**
   * When true, the game boots into the Phase 3 AssetPreviewScene instead of the
   * normal flow (used by the /preview route). The preview scene is only
   * registered here, so it can never start inside the normal game flow.
   */
  preview?: boolean;
}

/**
 * Creates the Phaser game instance inside the given parent element.
 *
 * This module statically imports Phaser, so it must only ever be loaded
 * client-side (the host component loads it with a dynamic `import()` after
 * mount — never during server rendering).
 *
 * Phase 7: the normal flow boots Boot → Preload → Office. The React title
 * overlay is rendered on top of the live office scene (paused until Play), so
 * there is no Phaser title scene anymore. The /preview route keeps the fixed
 * 16:9 FIT scale its boxed container was designed for.
 *
 * Callers own the returned instance and must call `game.destroy(true)`
 * on unmount to remove the canvas and free WebGL/input listeners.
 */
export function createGame(parent: HTMLElement, options: CreateGameOptions = {}): Phaser.Game {
  const preview = options.preview === true;

  // Which scene PreloadScene starts when loading finishes (see game/flow.ts).
  flow.afterPreload = preview ? "AssetPreview" : "Office";

  const scene = preview
    ? [BootScene, PreloadScene, AssetPreviewScene]
    : [BootScene, PreloadScene, OfficeScene];

  const scale = preview
    ? { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }
    : gameConfig.scale;

  return new Phaser.Game({ ...gameConfig, scale, parent, scene });
}
