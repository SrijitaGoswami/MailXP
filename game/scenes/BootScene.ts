import * as Phaser from "phaser";

/**
 * First scene. Does no loading — asset loading belongs to Phase 3 —
 * and hands straight to Preload.
 */
export class BootScene extends Phaser.Scene {
  public constructor() {
    super("Boot");
  }

  public create(): void {
    this.scene.start("Preload");
  }
}
