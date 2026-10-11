import * as Phaser from "phaser";

/**
 * Phase 3 asset preview. Only registered by createGame({ preview: true }) for
 * the /preview route — it never runs in the normal game flow.
 *
 * Every label and frame set comes from processed/manifest.json (loaded by
 * PreloadScene), so the preview doubles as a check that the manifest is
 * machine-readable. Sections: player spritesheets, interact poses, NPCs,
 * AI workers, mail bird, props, effects, and the 32x32 tile sheet.
 *
 * Scrolling: arrow keys / WASD / pointer drag / mouse wheel.
 */

/** Subset of processed/manifest.json used by the preview. */
interface ManifestFrame {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface ManifestAtlas {
  frames: ManifestFrame[];
}
interface ManifestSheet {
  frameWidth: number;
  frameHeight: number;
  rowsOrder?: string[];
  columnsOrder?: string[];
  frames?: string[];
}
interface ManifestData {
  atlasFrames: Record<string, ManifestAtlas>;
  spritesheets: Record<string, ManifestSheet>;
  tiles: { tiles: { name: string }[] };
}

const LABEL: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: "monospace",
  fontSize: "10px",
  color: "#ffcc66",
};
const NOTE_COLOR = "#8fd3ff";

export class AssetPreviewScene extends Phaser.Scene {
  private cursorY = 60;
  private manifest: ManifestData | null = null;
  private moveKeys: Record<string, Phaser.Input.Keyboard.Key> | null = null;

  public constructor() {
    super("AssetPreview");
  }

  public create(): void {
    this.cameras.main.setBackgroundColor("#24242b");

    this.manifest = (this.cache.json.get("manifest") as ManifestData | undefined) ?? null;
    if (!this.manifest) {
      this.add.text(24, 24, "processed/manifest.json missing - run scripts/generate-assets.ps1", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#ff6b6b",
      });
      return;
    }

    this.createAnimations();
    this.buildHud();
    this.buildWorkerSection();
    this.buildInteractSection();
    this.buildAtlasSection(
      "office-npcs",
      "3. NPCs - office-npcs.png (atlas, measured content-packed cells)",
      "cols: officer / agent / monkey / intern  x  rows: down / left / right / up",
      4,
    );
    this.buildAtlasSection(
      "ai-workers",
      "4. AI workers - ai-workers.png (atlas, 4 x 2 cells of ~443px)",
      "cols: front / left / right / back  x  rows: understanding (teal) / response (amber)",
      4,
    );
    this.buildBirdSection();
    this.buildAtlasSection(
      "office-props",
      "6. Office props - office-props.png (atlas, 21 irregular frames)",
      "fit-scaled; names are the manifest/Phaser atlas frame names",
      7,
    );
    this.buildAtlasSection(
      "mail-effects",
      "7. Mail items & effects - mail-effects.png (atlas, 14 irregular frames)",
      "mail items / DraftCoin / reward token / sparkle / ring / bursts",
      7,
    );
    this.buildTilesSection();
    this.buildFooter();

    this.cameras.main.setBounds(0, 0, this.scale.width, this.cursorY + 32);
    this.setupControls();
  }

  public update(_time: number, delta: number): void {
    if (!this.moveKeys) return;
    const step = delta * 0.7;
    const cam = this.cameras.main;
    if (this.moveKeys.UP.isDown || this.moveKeys.W.isDown) cam.scrollY -= step;
    if (this.moveKeys.DOWN.isDown || this.moveKeys.S.isDown) cam.scrollY += step;
    if (this.moveKeys.LEFT.isDown || this.moveKeys.A.isDown) cam.scrollX -= step;
    if (this.moveKeys.RIGHT.isDown || this.moveKeys.D.isDown) cam.scrollX += step;
  }

  // ------------------------------------------------------------------ build --

  private buildHud(): void {
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#ffffff",
      backgroundColor: "#000000cc",
      padding: { x: 8, y: 5 },
    };
    this.add.text(10, 8, "MailXP Asset Preview - Phase 3", style).setScrollFactor(0).setDepth(80);
    this.add
      .text(
        10,
        34,
        "scroll: arrow keys / WASD / drag / wheel   |   frames named from processed/manifest.json",
        { ...style, fontSize: "11px", color: NOTE_COLOR, padding: { x: 8, y: 3 } },
      )
      .setScrollFactor(0)
      .setDepth(80);
  }

  /** Adds a section header; returns the y where section content starts. */
  private sectionHeader(title: string, note?: string): number {
    this.add
      .text(24, this.cursorY, title, {
        fontFamily: "monospace",
        fontSize: "15px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
        padding: { x: 6, y: 4 },
      })
      .setOrigin(0, 0);
    this.cursorY += 27;
    if (note) {
      this.add.text(24, this.cursorY, note, { fontFamily: "monospace", fontSize: "11px", color: NOTE_COLOR }).setOrigin(0, 0);
      this.cursorY += 17;
    }
    this.cursorY += 6;
    return this.cursorY;
  }

  private buildWorkerSection(): void {
    const sheet = this.manifest!.spritesheets.worker;
    const rows = sheet.rowsOrder ?? ["down", "left", "right", "up"];
    const cols = sheet.columnsOrder ?? ["idle-a", "idle-b", "walk-a", "walk-b"];
    this.sectionHeader(
      "1. Player - worker.png (spritesheet, exact 4 x 4 grid of 313 x 313)",
      `rows: ${rows.join(" / ")}  x  cols: ${cols.join(" / ")}  |  feet anchored: origin (0.5, 1)`,
    );

    const cellW = 100;
    const cellH = 96;
    const box = 74;
    const startX = 32;
    rows.forEach((row, r) => {
      cols.forEach((col, c) => {
        const index = r * cols.length + c;
        const cx = startX + c * cellW + cellW / 2;
        const bottom = this.cursorY + r * cellH + box;
        this.add.image(cx, bottom, "worker", index).setOrigin(0.5, 1).setScale(box / 313);
        this.add.text(cx, bottom + 4, `${row}-${col}`, LABEL).setOrigin(0.5, 0);
      });
    });

    const ax = startX + cols.length * cellW + 96;
    const aBottom = this.cursorY + 118;
    const walker = this.add.sprite(ax, aBottom, "worker", 2).setOrigin(0.5, 1).setScale(112 / 313);
    if (this.anims.exists("pv-walk-down")) walker.play("pv-walk-down");
    this.add.text(ax, aBottom + 4, "animated walk-down", LABEL).setOrigin(0.5, 0);

    this.cursorY += rows.length * cellH + 8;
  }

  private buildInteractSection(): void {
    const sheet = this.manifest!.spritesheets["worker-interact"];
    const names = sheet.frames ?? ["down", "left", "right", "up"];
    this.sectionHeader(
      "2. Player interact - interact-directions.png (spritesheet, exact 4 x 543 x 724)",
      `frames: ${names.join(" / ")}  |  envelope-hold poses, feet anchored`,
    );

    const cellW = 112;
    const scale = 118 / 724;
    names.forEach((name, i) => {
      const cx = 32 + i * cellW + cellW / 2;
      const bottom = this.cursorY + 118;
      this.add.image(cx, bottom, "worker-interact", i).setOrigin(0.5, 1).setScale(scale);
      this.add.text(cx, bottom + 4, name, LABEL).setOrigin(0.5, 0);
    });
    this.cursorY += 118 + 24;
  }

  private buildAtlasSection(key: string, title: string, note: string, cols: number): void {
    const contentTop = this.sectionHeader(title, note);
    const frames = this.manifest!.atlasFrames[key]?.frames ?? [];
    if (frames.length === 0) {
      this.add.text(32, this.cursorY, `no frames for '${key}' in manifest`, {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#ff6b6b",
      });
      this.cursorY += 24;
      return;
    }

    const cellW = 128;
    const cellH = 118;
    const boxW = 104;
    const boxH = 92;
    const tex = this.textures.exists(key) ? this.textures.get(key) : null;

    frames.forEach((f, i) => {
      const cx = 32 + (i % cols) * cellW + cellW / 2;
      const bottom = contentTop + Math.floor(i / cols) * cellH + boxH;
      if (tex && tex.has(f.name)) {
        const scale = Math.min(boxW / f.w, boxH / f.h);
        this.add.image(cx, bottom, key, f.name).setOrigin(0.5, 1).setScale(scale);
      } else {
        this.add.text(cx, bottom - 4, "missing frame", { ...LABEL, color: "#ff6b6b" }).setOrigin(0.5, 1);
      }
      this.add.text(cx, bottom + 4, f.name, LABEL).setOrigin(0.5, 0);
    });
    this.cursorY += Math.ceil(frames.length / cols) * cellH + 8;
  }

  private buildBirdSection(): void {
    const contentTop = this.sectionHeader(
      "5. Mail bird - mail-bird.png (atlas, 4 flap frames x 2 directions)",
      "row 1: flying right  /  row 2: flying left  |  animated flap on the right",
    );
    const frames = this.manifest!.atlasFrames["mail-bird"]?.frames ?? [];
    const cellW = 128;
    const cellH = 118;
    const boxW = 104;
    const boxH = 92;
    const tex = this.textures.exists("mail-bird") ? this.textures.get("mail-bird") : null;

    frames.forEach((f, i) => {
      const cx = 32 + (i % 4) * cellW + cellW / 2;
      const bottom = contentTop + Math.floor(i / 4) * cellH + boxH;
      if (tex && tex.has(f.name)) {
        this.add.image(cx, bottom, "mail-bird", f.name).setOrigin(0.5, 1).setScale(Math.min(boxW / f.w, boxH / f.h));
      }
      this.add.text(cx, bottom + 4, f.name, LABEL).setOrigin(0.5, 0);
    });

    const ax = 32 + 4 * cellW + 120;
    if (tex && tex.has("right-0")) {
      const flier = this.add.sprite(ax, contentTop + 46, "mail-bird", "right-0").setScale(104 / 444);
      if (this.anims.exists("pv-bird-flap")) flier.play("pv-bird-flap");
      this.add.text(ax, contentTop + 46 + 60, "animated flap", LABEL).setOrigin(0.5, 0);
    }

    this.cursorY += Math.ceil(frames.length / 4) * cellH + 8;
  }

  private buildTilesSection(): void {
    this.sectionHeader(
      "8. Tile sheet - processed/office-tiles-32.png (26 tiles x 32px, shown at 2x)",
      "nearest-neighbor from selected source cells; source rects recorded in manifest.json.tiles",
    );
    const names = this.manifest!.tiles.tiles.map((t) => t.name);
    const cellW = 68;
    const cellH = 88;
    const hasSheet = this.textures.exists("office-tiles");
    names.forEach((name, i) => {
      const cx = 32 + (i % 13) * cellW + cellW / 2;
      const cy = this.cursorY + Math.floor(i / 13) * cellH + 34;
      if (hasSheet) {
        this.add.image(cx, cy, "office-tiles", i).setScale(2);
      }
      this.add.text(cx, cy + 38, name, { ...LABEL, fontSize: "8px" }).setOrigin(0.5, 0);
    });
    this.cursorY += Math.ceil(names.length / 13) * cellH + 8;
  }

  private buildFooter(): void {
    this.add.text(24, this.cursorY + 12, "All frames load from the original PNGs + processed/*.json atlases.", {
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#c9c9d1",
    });
    this.add.text(24, this.cursorY + 30, "Source of truth: processed/manifest.json (every source rect -> output name).", {
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#c9c9d1",
    });
    this.cursorY += 60;
  }

  // ---------------------------------------------------------------- helpers --

  private createAnimations(): void {
    const anims = this.anims;
    // Guards: an animation resolved to ZERO frames would crash sprite.play() on
    // the first update and take the render loop down with it (blank canvas).
    const walk = (key: string, frames: number[]): void => {
      if (anims.exists(key) || !this.textures.exists("worker")) return;
      const frameData = this.anims.generateFrameNumbers("worker", { frames });
      if (frameData.length === frames.length) {
        anims.create({ key, frames: frameData, frameRate: 6, repeat: -1 });
      }
    };
    // frame index = directionRow * 4 + poseColumn (rows down/left/right/up, cols idle-a/idle-b/walk-a/walk-b)
    walk("pv-walk-down", [2, 3]);
    walk("pv-walk-left", [6, 7]);
    walk("pv-walk-right", [10, 11]);
    walk("pv-walk-up", [14, 15]);

    if (!anims.exists("pv-bird-flap") && this.textures.exists("mail-bird")) {
      const flap = this.anims.generateFrameNames("mail-bird", { prefix: "right-", start: 0, end: 3 });
      if (flap.length > 0) {
        anims.create({ key: "pv-bird-flap", frames: flap, frameRate: 8, repeat: -1 });
      }
    }
  }

  private setupControls(): void {
    const cam = this.cameras.main;
    if (this.input.keyboard) {
      this.moveKeys = this.input.keyboard.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT") as Record<
        string,
        Phaser.Input.Keyboard.Key
      >;
    }

    let last: { x: number; y: number } | null = null;
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      last = { x: pointer.x, y: pointer.y };
    });
    this.input.on("pointerup", () => {
      last = null;
    });
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (last && pointer.isDown) {
        cam.scrollX -= pointer.x - last.x;
        cam.scrollY -= pointer.y - last.y;
        last = { x: pointer.x, y: pointer.y };
      }
    });
    this.input.on(
      "wheel",
      (_pointer: Phaser.Input.Pointer, _over: Phaser.GameObjects.GameObject[], _dx: number, dy: number) => {
        cam.scrollY += dy * 0.6;
      },
    );
  }
}
