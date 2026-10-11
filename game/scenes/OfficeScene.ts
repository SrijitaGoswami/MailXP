import * as Phaser from "phaser";

import { AiWorkerAgent } from "../agents";
import { AGENT_IDLE_LINES, AGENT_ROUTES, type AgentId } from "../data/agentsConfig";
import {
  publishState,
  subscribeCommands,
  takePendingDecor,
  type DecorModeState,
  type ReplyDraft,
  type TouchDir,
} from "../bridge";
import { playSound } from "../audio/audioManager";
import {
  addDraftCoin,
  getProfile,
  ownsItem,
  patchProfile,
  spendDraftCoin,
  subscribeProfile,
  type OutfitId,
} from "../profile";
import { playEffect } from "../effects";
import { getShopItem, isDecorItem, outfitTexture } from "../data/shopConfig";
import {
  MAIL_PICKUP,
  MAP_HEIGHT,
  MAP_WIDTH,
  OFFICE_NPCS,
  OFFICE_PROPS,
  OFFICE_ROWS,
  PLAYER_SPAWN,
  SOLID_TILES,
  TILE,
  TILE_NAMES,
  TILE_SIZE,
  rowToTiles,
  type Direction,
  type NpcPlacement,
} from "../data/officeMap";
import {
  CURRENCY,
  ECONOMY,
  INTERACT_RADIUS,
  NPC_DIALOGUE,
  OBJECTIVES,
  POST_DELIVERY_DIALOGUE,
  QUEST,
  QUESTS,
  STATUSES,
  type QuestStage,
  type QuestStatus,
} from "../data/questConfig";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Target {
  kind: "npc" | "mailbox" | "agent";
  /** Feet position. */
  x: number;
  y: number;
  /** Top of the sprite/art, where the prompt is anchored. */
  topY: number;
  npc?: NpcPlacement;
  agentId?: AgentId;
}

/** Frame row order of worker.png (manifest rowsOrder). */
const DIRECTIONS: Direction[] = ["down", "left", "right", "up"];
const DIR_ROW: Record<Direction, number> = { down: 0, left: 1, right: 2, up: 3 };

const PLAYER_SCALE = 0.2; // 313 px frame -> 62.6 px display, feet-anchored
const INTERACT_SCALE = (313 * PLAYER_SCALE) / 724; // same display height as worker
const NPC_SCALE = 0.16;
const PLAYER_SPEED = 110; // px/s
const CARRY_ICON_SCALE = 0.12;
const BIRD_SCALE = 0.16;
const BIRD_SPEED = 320; // px/s — how fast the mail-bird leaves the screen

const HUD_DEPTH = 1_000_000;
const PROMPT_DEPTH = 100_000;
/** Margin of tiled surround beyond the office walls (covers any viewport). */
const SURROUND_PAD = 2_048;

/**
 * Phase 4 — playable office core loop; Phase 5 — quest list, the two local AI
 * workers, the React reply-review flow, the mail-bird send and the HUD.
 *
 * Quests are driven by the typed list in `game/data/questConfig.ts`: one job is
 * active at a time and finishing it auto-starts the next. The Phase 4 physical
 * loop (pickup → deliver → +reward) is quest 1 and is unchanged; quests 2–4 run
 * the Understanding Worker's classification, the Response Worker's draft, the
 * React review panel and the simulated send.
 *
 * Everything is local sample data: no AI provider, backend, email delivery,
 * wallet or network calls. Status/balance/HUD state is mirrored into
 * React through the single typed bridge (`game/bridge.ts`); all bridge and
 * keyboard listeners are removed on shutdown.
 *
 * Phase 7: the scene is the always-live game — it boots paused underneath the
 * React title overlay and pauses again whenever the in-game menu opens
 * (`set-paused` command). The canvas fills the viewport (Scale.RESIZE) with
 * the camera at zoom 1, so larger screens reveal more of the office while the
 * pixel art stays crisp and un-stretched.
 */
export class OfficeScene extends Phaser.Scene {
  private grid: number[][] = [];
  private solidBoxes: Box[] = [];

  private player!: Phaser.GameObjects.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private eKey!: Phaser.Input.Keyboard.Key;

  // --- quest state -------------------------------------------------------
  private questIndex = 0;
  private questStatuses: QuestStatus[] = [];
  private stage: QuestStage = "pickup";
  private allComplete = false;
  private carrying = false;
  private mailCount = 0;
  private xp = 0;
  private level = 1;
  private classification: string | null = null;
  private draft: ReplyDraft | null = null;
  private reviewOpen = false;
  private sending = false;
  private pendingLevelUp = false;
  private statusLine: string = STATUSES.intro;
  private currentTarget: Target | null = null;

  // --- world objects -----------------------------------------------------
  private understanding!: AiWorkerAgent;
  private response!: AiWorkerAgent;
  private bird: Phaser.GameObjects.Sprite | null = null;

  private promptText!: Phaser.GameObjects.Text;
  private bubbleText!: Phaser.GameObjects.Text;
  /** Single in-canvas overlay left in Phase 7: the transient status line. */
  private statusHud!: Phaser.GameObjects.Text;

  private carryIcon: Phaser.GameObjects.Image | null = null;
  private pickupMarker: Phaser.GameObjects.Image | null = null;
  private deliveryMarker: Phaser.GameObjects.Text | null = null;

  // --- Phase 6: profile-backed appearance, decor and touch input ----------
  /** Equipped outfit; the local profile is the source of truth. */
  private currentOutfit: OutfitId = "worker";
  /** Sprites for placed decor (rebuilt whenever the profile changes). */
  private decorSprites: Phaser.GameObjects.Image[] = [];
  /** Non-null while the player is placing/moving decor on the map. */
  private decorMode: DecorModeState | null = null;
  /** On-screen D-pad state (merged with the keyboard in readMovement). */
  private touchMove: Record<TouchDir, boolean> = { up: false, down: false, left: false, right: false };
  /** Throttle stamps for repeatable sounds (footsteps, wall bumps). */
  private lastFootstep = -Infinity;
  private lastBump = -Infinity;

  private poseUntil = 0;
  private facing: Direction = PLAYER_SPAWN.facing;
  private unsubCommands?: () => void;
  private unsubProfile?: () => void;
  /**
   * Phase 7 — the game boots paused: the React title overlay sits on top of
   * this live scene, and the in-game menu pauses it again whenever it opens.
   * While paused, `update` skips movement/interact/agent updates entirely, so
   * an open panel can never receive stray game input.
   */
  private paused = true;

  /**
   * Local DraftCoin lives in the shared profile (persisted in localStorage),
   * so React shop purchases and in-game rewards update one balance. The scene
   * mirrors it into the HUD/bridge and reacts to external changes through
   * `subscribeProfile`.
   */
  private get draftCoin(): number {
    return getProfile().draftCoin;
  }

  public constructor() {
    super("Office");
  }

  public create(): void {
    this.questIndex = 0;
    this.questStatuses = QUESTS.map((_, index) => (index === 0 ? "active" : "locked"));
    this.stage = "pickup";
    this.allComplete = false;
    this.carrying = false;
    this.mailCount = 0;
    this.xp = 0;
    this.level = 1;
    this.classification = null;
    this.draft = null;
    this.reviewOpen = false;
    this.sending = false;
    this.pendingLevelUp = false;
    this.statusLine = STATUSES.intro;
    this.facing = PLAYER_SPAWN.facing;
    this.poseUntil = 0;
    this.lastFootstep = -Infinity;
    this.lastBump = -Infinity;
    this.decorMode = null;
    this.touchMove = { up: false, down: false, left: false, right: false };
    // Game objects from a previous run are destroyed with the scene — drop the
    // stale references instead of touching them again.
    this.currentTarget = null;
    this.carryIcon = null;
    this.pickupMarker = null;
    this.deliveryMarker = null;
    this.bird = null;
    this.decorSprites = [];
    this.solidBoxes = [];
    this.grid = [];

    this.buildTileLayer();
    this.createSurround();
    this.createProps();
    this.renderDecor();
    this.createNpcs();
    this.createPlayer();
    this.createAgents();
    this.createMarkers();
    this.createHud();
    this.createBirdAnims();
    this.bindInput();
    this.bindDecorInput();

    const cam = this.cameras.main;
    cam.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    cam.roundPixels = true;
    cam.startFollow(this.player, true, 0.12, 0.12);
    // Camera zoom stays at 1 (crisp 1:1 pixels): a bigger viewport simply
    // reveals more of the office (Phase 7 "adaptive viewport" requirement).

    // The canvas now fills the viewport, so on-screen overlays anchored to an
    // edge must follow every resize (window resize, mobile URL bar, panel
    // layout changes). Cleanup runs on both shutdown and destroy.
    const onResize = () => this.layoutScreenOverlays();
    this.scale.on(Phaser.Scale.Events.RESIZE, onResize);
    const offResize = () => this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, offResize);
    this.events.once(Phaser.Scenes.Events.DESTROY, offResize);

    this.unsubCommands = subscribeCommands((command) => {
      switch (command.type) {
        case "interact":
          this.interact();
          break;
        case "confirm-send":
          this.confirmSend(command.draft);
          break;
        case "cancel-review":
          if (this.reviewOpen) {
            this.reviewOpen = false;
            playSound("cancel");
            this.setStatus(STATUSES.reviewKept);
            this.syncBridge();
          }
          break;
        case "open-review":
          if (this.draft && this.stage === "review") {
            this.reviewOpen = true;
            playSound("review-open");
            this.setStatus(STATUSES.reviewOpened);
            this.syncBridge();
          }
          break;
        case "touch-move":
          this.touchMove[command.dir] = command.pressed;
          break;
        case "set-paused":
          this.setPaused(command.paused);
          break;
        case "decorate":
          this.handleDecorateCommand(command);
          break;
        case "start":
          // Phase 7: the office is the always-live scene (the React title
          // overlay sits on top of it), so there is nothing to start — the
          // overlay's Play button only unpauses via "set-paused".
          break;
      }
    });

    // Decor requested while the title screen was up (Shop/Inventory before
    // "Start office") was held by the bridge — apply it now that we listen.
    const pendingDecor = takePendingDecor();
    if (pendingDecor) this.handleDecorateCommand(pendingDecor);

    // The profile owns wallet/appearance/decor; react to purchases, equips and
    // Settings changes made in React while this scene is running.
    this.unsubProfile?.();
    this.unsubProfile = subscribeProfile(() => {
      this.applyOutfit();
      this.renderDecor();
      this.renderHud();
      this.syncBridge();
    });

    const shutdown = () => {
      this.unsubCommands?.();
      this.unsubProfile?.();
      this.unsubCommands = undefined;
      this.unsubProfile = undefined;
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, shutdown);
    this.events.once(Phaser.Scenes.Events.DESTROY, shutdown);

    this.syncBridge();
  }

  public update(time: number, delta: number): void {
    if (this.paused) {
      // Drain the E-key edge state every frame so a keypress made while a
      // menu is open never fires an interact on the first unpaused frame.
      Phaser.Input.Keyboard.JustDown(this.eKey);
      return;
    }
    this.readMovement(time, delta);
    this.player.setDepth(this.player.y);
    this.updatePrompt();
    this.updateFollowers();
    this.updateAgents(time, delta);
  }

  /** Phase 7: freeze/unfreeze gameplay while the title/menu overlays are up. */
  private setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      // Drop directions held at the moment the menu opened so the player
      // never resumes walking from a stale press.
      this.touchMove = { up: false, down: false, left: false, right: false };
    } else {
      // Resuming play: restore arrow/space capture unless a text field still
      // has focus (a focused input that unmounts — e.g. the auth form after
      // submit — may never fire focusout, which would leave capture off).
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (!typing) this.input.keyboard?.enableGlobalCapture();
    }
  }

  // ------------------------------------------------------------------ world --

  /**
   * Phase 7 correction — everything beyond the office walls.
   *
   * The office world is finite (1280 × 960) while the canvas fills the whole
   * viewport, so any window wider/taller than the world would otherwise show
   * bare background color around the map ("not full screen"). One huge
   * TileSprite, tiled from the existing plain wall-top tile and tinted to a
   * shadowed tone, fills every margin at any window size — seamless, crisp
   * (nearest-neighbor texture), and it reuses shipped art (no new assets).
   * The camera stays at zoom 1, so characters are never enlarged.
   */
  private createSurround(): void {
    const surround = this.add.tileSprite(
      MAP_WIDTH / 2,
      MAP_HEIGHT / 2,
      MAP_WIDTH + SURROUND_PAD * 2,
      MAP_HEIGHT + SURROUND_PAD * 2,
      "office-tiles",
      TILE.woodWalnut,
    );
    surround.setDepth(-1);
    // Natively-dark walnut planks (no tint needed): the frame reads clearly
    // against the cream office, and the app's UI palette is walnut already.
  }

  private buildTileLayer(): void {
    this.grid = OFFICE_ROWS.map(rowToTiles);
    const map = this.make.tilemap({ data: this.grid, tileWidth: TILE_SIZE, tileHeight: TILE_SIZE });
    const tileset = map.addTilesetImage("office", "office-tiles", TILE_SIZE, TILE_SIZE, 0, 0);
    if (!tileset) throw new Error("OfficeScene: tileset 'office-tiles' failed to add");
    const layer = map.createLayer(0, tileset, 0, 0);
    if (!layer) throw new Error("OfficeScene: tile layer failed to create");
    layer.setDepth(0);
    this.validateMapAgainstManifest();
  }

  /**
   * Cross-checks the map's slot indices against `processed/manifest.json`
   * (loaded by PreloadScene): every slot the map uses must still hold the
   * name we authored for it and exist as a frame in the `office-tiles`
   * spritesheet. Drift is logged, not fatal — but it means the tiles on
   * screen are not the tiles the map intends.
   */
  private validateMapAgainstManifest(): void {
    const manifest = this.cache.json.get("manifest") as
      | { tiles?: { tileSize?: number; tiles?: Array<{ name: string; slot: number }> } }
      | undefined;
    if (!manifest?.tiles?.tiles) {
      console.error("[MailXP] manifest tiles section missing — map validation skipped");
      return;
    }

    const problems: string[] = [];
    if (manifest.tiles.tileSize !== TILE_SIZE) {
      problems.push(`manifest tileSize=${manifest.tiles.tileSize}, map assumes ${TILE_SIZE}`);
    }

    const sheet = this.textures.get("office-tiles");
    for (const [slotStr, name] of Object.entries(TILE_NAMES)) {
      const slot = Number(slotStr);
      const entry = manifest.tiles.tiles.find((t) => t.slot === slot);
      if (!entry) problems.push(`manifest has no tile at slot ${slot} (map expects '${name}')`);
      else if (entry.name !== name) problems.push(`slot ${slot}: manifest '${entry.name}' != map '${name}'`);
      if (!sheet.has(String(slot))) problems.push(`tileset frame '${slot}' missing for '${name}'`);
    }

    if (problems.length > 0) {
      console.error(`[MailXP] map/manifest drift:\n- ${problems.join("\n- ")}`);
    }
  }

  private frameSize(key: string, name: string): { w: number; h: number } {
    const tex = this.textures.get(key);
    if (!tex || !tex.has(name)) {
      console.error(`[MailXP] missing frame '${name}' in atlas '${key}'`);
      return { w: TILE_SIZE, h: TILE_SIZE };
    }
    const frame = tex.get(name);
    return { w: frame.width, h: frame.height };
  }

  private createProps(): void {
    for (const prop of OFFICE_PROPS) {
      const size = this.frameSize("office-props", prop.frame);
      const dispW = size.w * prop.scale;
      const dispH = size.h * prop.scale;
      this.add
        .image(prop.x, prop.y, "office-props", prop.frame)
        .setOrigin(0.5, 1)
        .setScale(prop.scale)
        .setDepth(prop.depth ?? prop.y);

      if (prop.solid !== false) {
        // Collision covers only the base of the sprite so the player can walk
        // *behind* tall furniture and be drawn under it (depth = foot y).
        const w = dispW * 0.9;
        const h = dispH * 0.45;
        this.solidBoxes.push({ x: prop.x - w / 2, y: prop.y - h, w, h });
      }
    }
  }

  private createNpcs(): void {
    for (const npc of OFFICE_NPCS) {
      const frame = `${npc.frameBase}-${npc.facing}`;
      const size = this.frameSize("office-npcs", frame);
      this.add
        .image(npc.x, npc.y, "office-npcs", frame)
        .setOrigin(0.5, 1)
        .setScale(NPC_SCALE)
        .setDepth(npc.y);

      const dispW = size.w * NPC_SCALE;
      const dispH = size.h * NPC_SCALE;
      const w = dispW * 0.5;
      const h = dispH * 0.3;
      this.solidBoxes.push({ x: npc.x - w / 2, y: npc.y - h, w, h });
    }
  }

  private createPlayer(): void {
    // The profile decides which sheet the worker wears from the first frame;
    // every outfit shares worker.png's 4 x 4 / 313 px layout, so the same
    // frame maths and scale apply to all of them.
    const outfit = getProfile().equippedOutfit;
    this.currentOutfit = outfit;
    this.ensureAnims(outfit);

    this.player = this.add
      .sprite(
        PLAYER_SPAWN.x,
        PLAYER_SPAWN.y,
        outfitTexture(outfit),
        DIR_ROW[PLAYER_SPAWN.facing] * 4,
      )
      .setOrigin(0.5, 1)
      .setScale(PLAYER_SCALE)
      .setDepth(PLAYER_SPAWN.y);

    this.player.play(`idle-${outfit}-${this.facing}`);
  }

  /** Creates the idle/walk animations for one outfit sheet (idempotent). */
  private ensureAnims(outfit: OutfitId): void {
    const texture = outfitTexture(outfit);
    for (const dir of DIRECTIONS) {
      const row = DIR_ROW[dir];
      const idleKey = `idle-${outfit}-${dir}`;
      const walkKey = `walk-${outfit}-${dir}`;
      if (!this.anims.exists(idleKey)) {
        this.anims.create({
          key: idleKey,
          frames: this.anims.generateFrameNumbers(texture, { frames: [row * 4, row * 4 + 1] }),
          frameRate: 1.5,
          repeat: -1,
        });
      }
      if (!this.anims.exists(walkKey)) {
        this.anims.create({
          key: walkKey,
          frames: this.anims.generateFrameNumbers(texture, { frames: [row * 4 + 2, row * 4 + 3] }),
          frameRate: 7,
          repeat: -1,
        });
      }
    }
  }

  /**
   * Re-applies the equipped outfit when the profile changes (Character screen
   * or Shop equip). Switching anims swaps the texture mid-walk safely because
   * animation frames carry their own texture key.
   */
  private applyOutfit(): void {
    if (!this.player) return;
    const outfit = getProfile().equippedOutfit;
    if (outfit === this.currentOutfit) return;
    this.currentOutfit = outfit;
    this.ensureAnims(outfit);
    this.poseUntil = 0;
    this.player.anims.stop();
    this.player.play(`idle-${outfit}-${this.facing}`);
  }

  // ----------------------------------------------------------------- decor --
  //
  // Placed decor comes from `profile.placedDecor` (persisted locally). It is
  // purely visual: items never enter `solidBoxes`, so verified Phase 4/5 walk
  // routes cannot be blocked by decoration.

  /** Rebuilds every placed decor sprite from the profile (depth = foot y). */
  private renderDecor(): void {
    for (const sprite of this.decorSprites) sprite.destroy();
    this.decorSprites = [];

    for (const slot of getProfile().placedDecor) {
      const item = getShopItem(slot.itemId);
      if (!item || !isDecorItem(item)) continue;
      if (!this.textures.exists(item.atlas) || !this.textures.get(item.atlas).has(item.frame)) {
        console.error(`[MailXP] decor '${slot.itemId}' frame '${item.frame}' missing from '${item.atlas}'`);
        continue;
      }
      const frame = this.textures.get(item.atlas).get(item.frame);
      const sprite = this.add
        .image(slot.x, slot.y, item.atlas, item.frame)
        .setScale(item.displayHeight / frame.height)
        .setDepth(slot.y);
      // Floor pieces stand on the click point (foot anchor); wall pieces hang
      // centered on it (center anchor).
      sprite.setOrigin(0.5, item.wall ? 0.5 : 1);
      this.decorSprites.push(sprite);
    }
  }

  /** Canvas clicks place/move decor while decorate mode is active. */
  private bindDecorInput(): void {
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!this.decorMode || this.paused) return;
      const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.tryPlaceDecor(world.x, world.y);
    });
  }

  private handleDecorateCommand(command: {
    action: "place" | "move" | "cancel";
    itemId?: string;
    index?: number;
  }): void {
    if (command.action === "cancel") {
      this.decorMode = null;
      playSound("cancel");
      this.setStatus("Decorating cancelled.");
      this.syncBridge();
      return;
    }

    if (command.action === "place" && command.itemId) {
      const item = getShopItem(command.itemId);
      if (!item || !isDecorItem(item) || !ownsItem(command.itemId)) {
        playSound("blocked");
        this.setStatus("That item is not in your inventory yet — claim it in the Shop first.");
        this.syncBridge();
        return;
      }
      this.decorMode = { mode: "place", itemId: command.itemId };
      playSound("panel-open");
      this.setStatus(`Click or tap a spot in the office to place the ${item.name}.`);
      this.syncBridge();
      return;
    }

    if (command.action === "move" && command.index !== undefined) {
      const slot = getProfile().placedDecor[command.index];
      const item = slot ? getShopItem(slot.itemId) : undefined;
      if (!slot || !item || !isDecorItem(item)) {
        playSound("blocked");
        this.setStatus("That decor slot no longer exists.");
        this.syncBridge();
        return;
      }
      this.decorMode = { mode: "move", itemId: slot.itemId, index: command.index };
      playSound("panel-open");
      this.setStatus(`Click or tap a new spot for the ${item.name}.`);
      this.syncBridge();
    }
  }

  /** Snaps to the tile grid, validates the spot and writes it to the profile. */
  private tryPlaceDecor(worldX: number, worldY: number): void {
    const mode = this.decorMode;
    if (!mode) return;
    const item = getShopItem(mode.itemId);
    if (!item || !isDecorItem(item)) {
      this.decorMode = null;
      this.syncBridge();
      return;
    }

    // Grid snap: center of the nearest 32 px tile.
    const x = Math.floor(worldX / TILE_SIZE) * TILE_SIZE + TILE_SIZE / 2;
    const y = Math.floor(worldY / TILE_SIZE) * TILE_SIZE + TILE_SIZE / 2;

    if (x < TILE_SIZE / 2 || y < TILE_SIZE / 2 || x >= MAP_WIDTH || y >= MAP_HEIGHT) {
      playSound("blocked");
      this.setStatus("Outside the office — pick a spot inside the room.");
      return;
    }

    if (!item.wall) {
      const col = Math.floor(x / TILE_SIZE);
      const row = Math.floor(y / TILE_SIZE);
      const tile = this.grid[row]?.[col];
      if (tile === undefined || SOLID_TILES.has(tile)) {
        playSound("blocked");
        this.setStatus("That tile is a wall — floor items need an open floor spot.");
        return;
      }
    }

    const placed = [...getProfile().placedDecor];
    if (mode.mode === "place") {
      placed.push({ itemId: mode.itemId, x, y });
    } else if (mode.index !== undefined && placed[mode.index]) {
      placed[mode.index] = { ...placed[mode.index], x, y };
    }
    patchProfile({ placedDecor: placed });

    playSound("equip");
    this.decorMode = null;
    this.setStatus(
      mode.mode === "place"
        ? `${item.name} placed — manage it any time from the Inventory tab.`
        : `${item.name} moved.`,
    );
    this.syncBridge();
  }

  // ----------------------------------------------------------------- agents --

  private createAgents(): void {
    this.understanding = new AiWorkerAgent(this, "understanding");
    this.response = new AiWorkerAgent(this, "response");
  }

  private updateAgents(time: number, delta: number): void {
    this.understanding.update(time, delta, (box) => this.isBlocked(box));
    this.response.update(time, delta, (box) => this.isBlocked(box));
  }

  private createMarkers(): void {
    // Bobbing mail icon above the mailbox while the pickup is pending.
    this.pickupMarker = this.add
      .image(MAIL_PICKUP.x, MAIL_PICKUP.y - 86, "mail-effects", "mail-closed")
      .setScale(CARRY_ICON_SCALE)
      .setDepth(MAIL_PICKUP.y + 0.5);
    if (!this.reducedMotion()) {
      this.tweens.add({
        targets: this.pickupMarker,
        y: MAIL_PICKUP.y - 94,
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
  }

  /** Local motion preference (Settings) — used to park decorative tweens. */
  private reducedMotion(): boolean {
    return getProfile().prefs.motion === "reduced";
  }

  private createHud(): void {
    // Phase 7 keeps a single in-canvas overlay — the transient status line —
    // anchored bottom-center between the touch pad (bottom-left) and the
    // interact button (bottom-right). Stats (level/XP/coins) and the job list
    // moved to the React HUD and the Tasks panel; the instruction strip and
    // objective/stats texts are gone with the old page layout.
    this.statusHud = this.add
      .text(this.scale.width / 2, this.scale.height - 12, "", {
        fontFamily: "monospace",
        fontSize: "13px",
        color: "#1f4e4e",
        backgroundColor: "#ffe9c9",
        wordWrap: { width: Math.max(240, this.scale.width - 360), useAdvancedWrap: true },
        align: "center",
      })
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(HUD_DEPTH);

    this.layoutScreenOverlays();

    this.promptText = this.add
      .text(0, 0, "", {
        fontFamily: "monospace",
        fontSize: "13px",
        color: "#ffe9c9",
        backgroundColor: "#2f7f7f",
        align: "center",
      })
      .setOrigin(0.5, 1)
      .setDepth(PROMPT_DEPTH)
      .setVisible(false);

    this.bubbleText = this.add
      .text(0, 0, "", {
        fontFamily: "monospace",
        fontSize: "13px",
        color: "#3a2b20",
        backgroundColor: "#ffe9c9",
        wordWrap: { width: 220, useAdvancedWrap: true },
        align: "center",
      })
      .setOrigin(0.5, 1)
      .setDepth(PROMPT_DEPTH + 1)
      .setVisible(false);
  }

  private createBirdAnims(): void {
    for (const dir of ["right", "left"] as const) {
      if (this.anims.exists(`bird-${dir}`)) continue;
      this.anims.create({
        key: `bird-${dir}`,
        frames: [0, 1, 2, 3].map((i) => ({ key: "mail-bird", frame: `${dir}-${i}` })),
        frameRate: 12,
        repeat: -1,
      });
    }
  }

  private bindInput(): void {
    const kb = this.input.keyboard;
    if (!kb) throw new Error("OfficeScene: keyboard input unavailable");
    this.cursors = kb.createCursorKeys();
    // W/A/S/D/E are gameplay keys but have no default browser action worth
    // preventing — and Phaser's addKeys/addKey DEFAULT to enableCapture=true,
    // which globally preventDefaults them and made those letters impossible
    // to type into text fields (auth email/password, any textarea). Passing
    // false keeps key STATE tracking (movement/interact unchanged) while only
    // skipping the capture for letters. Arrows/space/shift stay captured.
    this.wasd = kb.addKeys("W,A,S,D", false) as OfficeScene["wasd"];
    this.eKey = kb.addKey("E", false);

    // Arrows/space must not scroll the page while playing, yet must behave
    // normally inside text inputs — toggle the global capture with focus.
    const isEditable = (target: EventTarget | null): target is HTMLElement =>
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    const onFocusIn = (event: FocusEvent): void => {
      if (isEditable(event.target)) kb.disableGlobalCapture();
    };
    const onFocusOut = (): void => {
      kb.enableGlobalCapture();
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    const offTypingGuard = (): void => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, offTypingGuard);
    this.events.once(Phaser.Scenes.Events.DESTROY, offTypingGuard);
  }

  // ----------------------------------------------------------------- player --

  private playerBox(x: number, y: number): Box {
    return { x: x - 8, y: y - 8, w: 16, h: 8 };
  }

  private isBlocked(box: Box): boolean {
    if (box.x < 0 || box.y < 0 || box.x + box.w > MAP_WIDTH || box.y + box.h > MAP_HEIGHT) return true;

    const c0 = Math.floor(box.x / TILE_SIZE);
    const c1 = Math.floor((box.x + box.w - 0.001) / TILE_SIZE);
    const r0 = Math.floor(box.y / TILE_SIZE);
    const r1 = Math.floor((box.y + box.h - 0.001) / TILE_SIZE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const tile = this.grid[r]?.[c];
        if (tile === undefined || SOLID_TILES.has(tile)) return true;
      }
    }

    for (const solid of this.solidBoxes) {
      if (
        box.x < solid.x + solid.w &&
        box.x + box.w > solid.x &&
        box.y < solid.y + solid.h &&
        box.y + box.h > solid.y
      ) {
        return true;
      }
    }
    return false;
  }

  private readMovement(time: number, delta: number): void {
    if (Phaser.Input.Keyboard.JustDown(this.eKey)) this.interact();

    let dx = 0;
    let dy = 0;
    if (this.cursors.left.isDown || this.wasd.A.isDown || this.touchMove.left) dx -= 1;
    if (this.cursors.right.isDown || this.wasd.D.isDown || this.touchMove.right) dx += 1;
    if (this.cursors.up.isDown || this.wasd.W.isDown || this.touchMove.up) dy -= 1;
    if (this.cursors.down.isDown || this.wasd.S.isDown || this.touchMove.down) dy += 1;

    const moving = dx !== 0 || dy !== 0;
    if (moving) {
      const len = Math.hypot(dx, dy);
      const step = (PLAYER_SPEED * Math.min(delta, 50)) / 1000;
      const nx = this.player.x + (dx / len) * step;
      const ny = this.player.y + (dy / len) * step;
      const beforeX = this.player.x;
      const beforeY = this.player.y;

      // Axis-separated movement so the player slides along walls and furniture.
      if (!this.isBlocked(this.playerBox(nx, this.player.y))) this.player.x = nx;
      if (!this.isBlocked(this.playerBox(this.player.x, ny))) this.player.y = ny;

      if (dx !== 0) this.facing = dx < 0 ? "left" : "right";
      else this.facing = dy < 0 ? "up" : "down";

      // Restrained, throttled feedback: a soft step while actually travelling…
      if (time - this.lastFootstep > 240) {
        playSound("footstep");
        this.lastFootstep = time;
      }
      // …and a low thud only when pushing into something with nowhere to go
      // (sliding *along* a wall stays silent), throttled so it cannot spam.
      const stuck = this.player.x === beforeX && this.player.y === beforeY;
      if (stuck && time - this.lastBump > 450) {
        playSound("bump");
        this.lastBump = time;
      }
    }

    // Restore the outfit sheet when the interact pose expires OR is cancelled
    // by movement — otherwise walk/idle anims would run on the wrong texture.
    if (this.poseUntil > 0 && (moving || this.poseUntil <= time)) {
      this.poseUntil = 0;
      this.player.anims.stop();
      this.player
        .setTexture(outfitTexture(this.currentOutfit), DIR_ROW[this.facing] * 4)
        .setScale(PLAYER_SCALE);
    } else if (this.poseUntil > time) {
      // Held interact pose — anims stopped while the worker-interact frame shows.
      return;
    }

    this.player.anims.play(
      moving ? `walk-${this.currentOutfit}-${this.facing}` : `idle-${this.currentOutfit}-${this.facing}`,
      true,
    );
  }

  // ------------------------------------------------------------ interaction --

  private buildTargets(): Target[] {
    const targets: Target[] = [
      {
        kind: "mailbox",
        x: MAIL_PICKUP.x,
        y: MAIL_PICKUP.y,
        topY: MAIL_PICKUP.y - this.frameSize("office-props", "mailbox").h * 0.24,
      },
    ];
    for (const npc of OFFICE_NPCS) {
      const size = this.frameSize("office-npcs", `${npc.frameBase}-${npc.facing}`);
      targets.push({ kind: "npc", x: npc.x, y: npc.y, topY: npc.y - size.h * NPC_SCALE, npc });
    }
    for (const agent of [this.understanding, this.response]) {
      if (!agent) continue;
      targets.push({ kind: "agent", agentId: agent.id, x: agent.x, y: agent.y, topY: agent.topY });
    }
    return targets;
  }

  private updatePrompt(): void {
    const targets = this.buildTargets();
    let best: Target | null = null;
    let bestDist = INTERACT_RADIUS;
    for (const target of targets) {
      const dist = Math.hypot(target.x - this.player.x, target.y - this.player.y);
      if (dist <= bestDist) {
        bestDist = dist;
        best = target;
      }
    }
    this.currentTarget = best;

    if (!best) {
      this.promptText.setVisible(false);
      return;
    }
    this.promptText.setText(this.promptLabel(best)).setPosition(best.x, best.topY - 8).setVisible(true);
  }

  private promptLabel(target: Target): string {
    if (target.kind === "mailbox") {
      if (this.stage === "pickup") return `[E] Pick up the ${QUEST.itemName}`;
      return "[E] Check the mailbox";
    }
    if (target.kind === "agent") {
      const name = target.agentId === "understanding" ? "Understanding Worker" : "Response Worker";
      if (target.agentId === "response" && this.stage === "review" && !this.reviewOpen) {
        return "[E] Open the reply review";
      }
      if (target.agentId === "understanding" && this.classification) {
        return "[E] Ask about the classification";
      }
      return `[E] Talk to ${name}`;
    }
    const npc = target.npc!;
    if (this.carrying && npc.id === QUEST.deliveryNpcId) return `[E] Deliver mail to ${npc.name}`;
    return `[E] Talk to ${npc.name}`;
  }

  private interact(): void {
    if (this.paused) return; // menu/title overlay owns input while paused
    const target = this.currentTarget;
    if (!target) {
      this.setStatus(STATUSES.nothing);
      this.syncBridge();
      return;
    }
    this.triggerPose();
    playSound("interact");

    // Interaction affordance: a ring where the player just interacted.
    playEffect(this, "interaction-ring", target.x, target.y - 6, {
      size: 64,
      startFrom: 0.45,
      growTo: 1.5,
      duration: 420,
      depth: PROMPT_DEPTH - 1,
    });

    if (target.kind === "mailbox") {
      this.interactMailbox(target);
      return;
    }
    if (target.kind === "agent") {
      this.interactAgent(target);
      return;
    }
    this.interactNpc(target);
  }

  private interactMailbox(target: Target): void {
    if (this.stage === "pickup") {
      this.stage = "deliver";
      this.carrying = true;
      this.pickupMarker?.setVisible(false);
      this.carryIcon =
        this.carryIcon ??
        this.add
          .image(this.player.x, this.player.y - 64, "mail-effects", "mail-closed")
          .setScale(CARRY_ICON_SCALE);
      this.carryIcon.setVisible(true);
      this.createDeliveryMarker();
      playEffect(this, "pickup-burst", target.x, target.y - 40, { size: 84, duration: 560 });
      playSound("mail-pickup");
      this.setStatus(STATUSES.pickedUp);
      this.showBubble(target.x, target.y - 100, `Take this to the ${this.officerName()}.`);
    } else {
      this.setStatus(STATUSES.mailboxAgain);
    }
    this.syncBridge();
  }

  private interactNpc(target: Target): void {
    const npc = target.npc!;
    if (this.carrying && npc.id === QUEST.deliveryNpcId) {
      this.carrying = false;
      this.carryIcon?.setVisible(false);
      this.deliveryMarker?.setVisible(false);
      this.showBubble(target.x, target.topY - 6, `Thanks! +${QUESTS[this.questIndex].reward} ${CURRENCY}`);
      this.showCompletionBanner();
      playEffect(this, "coin-burst", target.x, target.y - 34, { size: 76 });
      playSound("reward");
      this.completeQuest(
        `${STATUSES.delivered} +${QUESTS[this.questIndex].reward} ${CURRENCY}.`,
        target.x,
        target.y - 20,
      );
      return;
    }
    const lines = this.allComplete ? POST_DELIVERY_DIALOGUE : NPC_DIALOGUE;
    const line = lines[npc.id] ?? NPC_DIALOGUE.agent;
    playSound("talk");
    this.setStatus(`${npc.name}: ${line}`);
    this.showBubble(target.x, target.topY - 6, line);
    this.syncBridge();
  }

  private interactAgent(target: Target): void {
    if (target.agentId === "response") {
      if (this.stage === "review" && this.draft) {
        this.reviewOpen = true;
        playSound("review-open");
        this.setStatus(STATUSES.reviewOpened);
      } else if (this.stage === "draft") {
        this.setStatus(STATUSES.drafting);
      } else {
        this.setStatus(`Response Worker: ${AGENT_IDLE_LINES.response}`);
      }
      this.syncBridge();
      return;
    }
    playSound("talk");
    if (this.classification) {
      this.setStatus(`Classified as: ${this.classification}.`);
    } else {
      this.setStatus(`Understanding Worker: ${AGENT_IDLE_LINES.understanding}`);
    }
    this.syncBridge();
  }

  private officerName(): string {
    return OFFICE_NPCS.find((n) => n.id === QUEST.deliveryNpcId)?.name ?? "Officer";
  }

  private triggerPose(): void {
    const dirIndex = DIR_ROW[this.facing];
    if (this.currentOutfit !== "worker") {
      // Only worker.png has the dedicated interact pose sheet — the other
      // outfits acknowledge the action with a brief envelope pop instead of
      // borrowing frames that do not belong to them (Phase 6 decision).
      const envelope = this.add
        .image(this.player.x, this.player.y - 56, "mail-effects", "mail-closed")
        .setScale(0.1)
        .setDepth(this.player.y + 1);
      this.tweens.add({
        targets: envelope,
        y: envelope.y - 20,
        alpha: 0,
        duration: 620,
        ease: "Quad.easeOut",
        onComplete: () => envelope.destroy(),
      });
      return;
    }
    this.player.anims.stop();
    this.player.setTexture("worker-interact", dirIndex).setScale(INTERACT_SCALE);
    this.poseUntil = this.time.now + 700;
  }

  private createDeliveryMarker(): void {
    if (this.deliveryMarker) {
      this.deliveryMarker.setVisible(true);
      return;
    }
    const officer = OFFICE_NPCS.find((n) => n.id === QUEST.deliveryNpcId);
    if (!officer) return;
    this.deliveryMarker = this.add
      .text(officer.x, officer.y - 76, "!", {
        fontFamily: "monospace",
        fontSize: "20px",
        fontStyle: "bold",
        color: "#ffd166",
        backgroundColor: "#1f4e4e",
      })
      .setOrigin(0.5, 1)
      .setDepth(officer.y + 0.5);
    if (!this.reducedMotion()) {
      this.tweens.add({
        targets: this.deliveryMarker,
        y: officer.y - 84,
        duration: 500,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
  }

  private showBubble(x: number, y: number, message: string): void {
    this.bubbleText.setText(message).setPosition(x, y).setAlpha(1).setVisible(true);
    this.tweens.killTweensOf(this.bubbleText);
    this.tweens.add({
      targets: this.bubbleText,
      alpha: 0,
      delay: 2600,
      duration: 400,
      onComplete: () => this.bubbleText.setVisible(false),
    });
  }

  private showCompletionBanner(): void {
    const banner = this.add
      .text(
        this.scale.width / 2,
        this.scale.height / 2,
        `Delivery complete!\n+${QUESTS[this.questIndex].reward} ${CURRENCY}`,
        {
          fontFamily: "monospace",
          fontSize: "34px",
          fontStyle: "bold",
          color: "#ffe9c9",
          backgroundColor: "#2f7f7f",
          align: "center",
        },
      )
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(HUD_DEPTH + 1)
      .setAlpha(0);
    if (this.reducedMotion()) {
      // Reduced motion: show the banner without fading/pulsing it.
      banner.setAlpha(1);
      this.time.delayedCall(2600, () => banner.destroy());
      return;
    }
    this.tweens.add({
      targets: banner,
      alpha: 1,
      duration: 250,
      hold: 2200,
      yoyo: true,
      onComplete: () => banner.destroy(),
    });
  }

  // ------------------------------------------------------------ quest flow --

  private get activeQuest() {
    return QUESTS[Math.min(this.questIndex, QUESTS.length - 1)];
  }

  /** Awards the finished quest, plays its effects and starts the next job. */
  private completeQuest(statusLine: string, x: number, y: number): void {
    const quest = this.activeQuest;
    addDraftCoin(quest.reward);
    this.mailCount += quest.mailOnComplete;
    this.questStatuses[this.questIndex] = "completed";

    playEffect(this, "quest-burst", x, y - 26, { size: 104, duration: 640 });
    playSound("quest-complete");
    this.addXp(quest.xpComplete, x, y - 12);

    this.startNextQuest(statusLine);
  }

  /** Moves the pointer to the next quest (or ends the list). */
  private startNextQuest(statusLine: string): void {
    const next = this.questIndex + 1;
    this.reviewOpen = false;

    if (next >= QUESTS.length) {
      this.allComplete = true;
      this.stage = "allComplete";
      this.setStatus(`${statusLine} ${STATUSES.allComplete}`);
      this.syncBridge();
      return;
    }

    this.questIndex = next;
    this.questStatuses[next] = "active";
    const quest = QUESTS[next];
    playSound("quest-start");

    if (quest.kind === "delivery") {
      this.stage = "pickup";
      this.pickupMarker?.setVisible(true);
      this.setStatus(statusLine);
      this.syncBridge();
      return;
    }

    this.beginClassification(statusLine);
  }

  /** Phase A of a reply job: the Understanding Worker glides out and classifies. */
  private beginClassification(statusLine: string): void {
    const quest = this.activeQuest;
    const route = AGENT_ROUTES[quest.id];
    if (!route) {
      console.error(`[MailXP] no agent route configured for quest '${quest.id}'`);
      this.stage = "allComplete";
      this.setStatus(statusLine);
      this.syncBridge();
      return;
    }

    this.stage = "classify";
    this.classification = null;
    this.draft = null;
    this.reviewOpen = false;
    playSound("agent-dispatch");
    this.setStatus(`${statusLine} ${STATUSES.classifyStart}`.trim());
    this.showBubble(this.understanding.x, this.understanding.topY - 6, "On it — reading the job…");
    this.understanding.sendTo(route.understanding, () => this.onClassified(quest.id));
    this.syncBridge();
  }

  private onClassified(questId: string): void {
    if (this.allComplete || this.activeQuest.id !== questId) return;
    const quest = this.activeQuest;
    const route = AGENT_ROUTES[quest.id];

    this.classification = quest.category ?? "General request";
    this.addXp(ECONOMY.xpClassify, this.understanding.x, this.understanding.y - 40);
    playEffect(this, "sparkle", this.understanding.x, this.understanding.y - 44, { size: 62, duration: 520 });
    playSound("classified");
    this.showBubble(
      this.understanding.x,
      this.understanding.topY - 6,
      `Classified: ${this.classification}`,
    );
    // Arrival cue: the worker glides back home after delivering its result.
    this.understanding.goHome(() => playSound("agent-arrive"));

    this.stage = "draft";
    this.setStatus(
      `Classified as: ${this.classification} (+${ECONOMY.xpClassify} XP). ${STATUSES.drafting}`,
    );
    this.showBubble(this.response.x, this.response.topY - 6, "Drafting the reply…");
    playSound("agent-dispatch");
    this.response.sendTo(route.response, () => this.onDraftReady(quest.id));
    this.syncBridge();
  }

  /** Phase B: the Response Worker follows the job and prepares the sample reply. */
  private onDraftReady(questId: string): void {
    if (this.allComplete || this.activeQuest.id !== questId) return;
    const quest = this.activeQuest;

    this.draft = {
      recipient: quest.recipient ?? "",
      subject: quest.subject ?? "",
      body: quest.draftBody ?? "",
    };
    this.stage = "review";
    this.reviewOpen = true;
    this.response.goHome(() => playSound("agent-arrive"));
    this.showBubble(this.response.x, this.response.topY - 6, "Draft ready — review it below.");
    playSound("draft-ready");
    this.setStatus(STATUSES.draftReady);
    this.syncBridge();
  }

  /** Confirmed simulated send (React review panel) → mail-bird flight. */
  private confirmSend(draft: ReplyDraft): void {
    if (this.stage !== "review" || this.sending || !this.draft) return;

    if (this.draftCoin < ECONOMY.sendCost) {
      playSound("blocked");
      this.setStatus(STATUSES.notEnough);
      this.syncBridge();
      return;
    }

    this.draft = draft; // keep the player's edits
    spendDraftCoin(ECONOMY.sendCost);
    this.reviewOpen = false;
    this.sending = true;
    this.stage = "send";
    playSound("send-confirm");

    this.addXp(ECONOMY.xpSend, this.player.x, this.player.y - 70);
    this.setStatus(
      `${STATUSES.sending} −${ECONOMY.sendCost} ${CURRENCY} (reward +${ECONOMY.sendReward} ${CURRENCY} on completion).`,
    );
    this.launchMailBird();
    this.syncBridge();
  }

  /** Sends the letter off toward the nearest horizontal screen edge. */
  private launchMailBird(): void {
    const cam = this.cameras.main;
    const viewWidth = this.scale.width; // live canvas width (RESIZE mode)
    const onLeftHalf = this.player.x - cam.scrollX <= viewWidth / 2;
    const dir: "right" | "left" = onLeftHalf ? "right" : "left";

    const startX = this.player.x;
    const startY = this.player.y - 74;
    const targetX = dir === "right" ? cam.scrollX + viewWidth + 140 : cam.scrollX - 140;

    const bird = this.add
      .sprite(startX, startY, "mail-bird", `${dir}-0`)
      .setOrigin(0.5, 0.5)
      .setScale(BIRD_SCALE)
      .setDepth(PROMPT_DEPTH);
    bird.play(`bird-${dir}`);
    this.bird = bird;
    playSound("bird-launch");

    const distance = Math.abs(targetX - startX);
    const duration = Math.max(700, (distance / BIRD_SPEED) * 1000);

    this.tweens.add({
      targets: bird,
      x: targetX,
      y: startY - 46, // slight climb while leaving
      duration,
      ease: "Linear",
      // The manager throttles this to ≥130 ms, so it reads as wing beats
      // rather than a buzz even at 60 fps update rates.
      onUpdate: () => playSound("bird-flap"),
      onComplete: () => {
        playSound("bird-pass");
        bird.destroy();
        this.bird = null;
        this.onBirdArrived();
      },
    });
  }

  private onBirdArrived(): void {
    if (!this.sending) return;
    this.sending = false;
    const quest = this.activeQuest;
    const net = quest.reward - ECONOMY.sendCost;
    this.completeQuest(
      `${STATUSES.sent} +${quest.reward} ${CURRENCY} (−${ECONOMY.sendCost} send cost, net +${net}).`,
      this.player.x,
      this.player.y - 30,
    );
  }

  private addXp(amount: number, x: number, y: number): void {
    this.xp += amount;
    const level = Math.floor(this.xp / ECONOMY.xpPerLevel) + 1;
    if (level > this.level) {
      this.level = level;
      this.pendingLevelUp = true;
      playEffect(this, "levelup-burst", x, y, { size: 116, duration: 720 });
      playSound("level-up");
      this.showBubble(this.player.x, this.player.y - 96, `Level ${level}!`);
    }
  }

  // ------------------------------------------------------------------- HUD --

  private setStatus(line: string): void {
    this.statusLine = this.pendingLevelUp ? `${STATUSES.levelUp} ${line}` : line;
    this.pendingLevelUp = false;
    this.renderHud();
  }

  private syncBridge(): void {
    this.renderHud();
    publishState({
      screen: "office",
      objective: OBJECTIVES[this.stage],
      status: this.statusLine,
      draftCoin: this.draftCoin,
      carrying: this.carrying,
      mailCount: this.mailCount,
      xp: this.xp,
      level: this.level,
      xpPerLevel: ECONOMY.xpPerLevel,
      xpInLevel: this.xp % ECONOMY.xpPerLevel,
      questIndex: this.questIndex + 1,
      questCount: QUESTS.length,
      activeQuestTitle: this.allComplete ? "" : this.activeQuest.title,
      quests: QUESTS.map((quest, index) => ({
        id: quest.id,
        title: quest.title,
        status: this.questStatuses[index],
      })),
      classification: this.classification,
      draft: this.draft,
      reviewOpen: this.reviewOpen,
      canOpenReview: this.draft !== null && !this.reviewOpen && !this.sending && !this.allComplete,
      sendCost: ECONOMY.sendCost,
      sendReward: ECONOMY.sendReward,
      canSend: this.draftCoin >= ECONOMY.sendCost,
      sending: this.sending,
      allComplete: this.allComplete,
      stage: this.stage,
      decorMode: this.decorMode,
    });
  }

  private renderHud(): void {
    // Level/XP/coins and job totals live in the React HUD and Tasks panel
    // now; the canvas only shows the transient status line.
    this.statusHud.setText(this.statusLine);
  }

  /** Repositions viewport-anchored overlays after any canvas resize (Phase 7). */
  private layoutScreenOverlays(): void {
    this.statusHud
      .setPosition(this.scale.width / 2, this.scale.height - 12)
      .setWordWrapWidth(Math.max(240, this.scale.width - 360), true);
  }

  private updateFollowers(): void {
    if (this.carryIcon?.visible) {
      this.carryIcon.setPosition(this.player.x, this.player.y - 66);
      this.carryIcon.setDepth(this.player.y + 0.5);
    }
  }
}
