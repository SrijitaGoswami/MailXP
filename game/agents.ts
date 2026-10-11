import * as Phaser from "phaser";

import {
  AGENT_BOB_PX,
  AGENT_BOB_SPEED,
  AGENT_SCALE,
  AGENT_SPEED,
  AGENTS,
  type AgentConfig,
  type AgentId,
  type AgentPoint,
} from "./data/agentsConfig";
import type { Direction } from "./data/officeMap";

/** Feet box used for the agent's collision test (same size as the player's). */
export interface AgentBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Provided by the scene so agents reuse the exact map/prop/NPC collision data. */
export type BlockedCheck = (box: AgentBox) => boolean;

const FEET: AgentBox = { x: -8, y: -8, w: 16, h: 8 };

/**
 * One of the two Phase 5 AI workers.
 *
 * The `ai-workers` atlas ships a single pose per direction (front/left/right/
 * back) — no walk frames — so this agent *glides* along config-defined waypoint
 * routes that respect the existing collision map, always showing the facing
 * frame that matches its travel direction plus a gentle vertical bob (restrained
 * movement treatment based on the actual assets, per the phase brief).
 *
 * Route shape: current position → (target.x, current.y) → target, i.e. an
 * L-shape whose long leg runs along open carpet.
 */
export class AiWorkerAgent {
  public readonly id: AgentId;
  public readonly config: AgentConfig;

  private readonly scene: Phaser.Scene;
  private readonly sprite: Phaser.GameObjects.Sprite;

  /** Logical feet position (the sprite is drawn bobbed slightly above it). */
  private pos: AgentPoint;
  private path: AgentPoint[] = [];
  private onArrive?: () => void;
  private bob = 0;

  public constructor(scene: Phaser.Scene, id: AgentId) {
    this.scene = scene;
    this.id = id;
    this.config = AGENTS[id];
    this.pos = { x: this.config.home.x, y: this.config.home.y };

    this.sprite = scene.add
      .sprite(this.pos.x, this.pos.y, "ai-workers", `${this.config.frameBase}-${this.config.home.facing}`)
      .setOrigin(0.5, 1)
      .setScale(AGENT_SCALE)
      .setDepth(this.pos.y);
  }

  public get x(): number {
    return this.pos.x;
  }

  public get y(): number {
    return this.pos.y;
  }

  /** False while the worker is standing at its post. */
  public get moving(): boolean {
    return this.path.length > 0;
  }

  /** Drops the worker back at its home post (used when a run restarts). */
  public reset(): void {
    this.path = [];
    this.onArrive = undefined;
    this.bob = 0;
    this.pos = { x: this.config.home.x, y: this.config.home.y };
    this.setFacing(this.config.home.facing);
    this.draw();
  }

  /** Glides to a world point. Fires `onArrive` once the route is finished. */
  public sendTo(target: AgentPoint, onArrive?: () => void): void {
    const route: AgentPoint[] = [];
    if (Math.abs(target.x - this.pos.x) > 1) route.push({ x: target.x, y: this.pos.y });
    route.push({ x: target.x, y: target.y });
    this.path = route;
    this.onArrive = onArrive;
  }

  /** Glides back to the configured home post. */
  public goHome(onArrive?: () => void): void {
    this.sendTo({ x: this.config.home.x, y: this.config.home.y }, onArrive);
  }

  /** Advances the glide; call once per scene update. */
  public update(time: number, delta: number, isBlocked: BlockedCheck): void {
    if (this.path.length > 0) {
      const target = this.path[0];
      const dx = target.x - this.pos.x;
      const dy = target.y - this.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = (AGENT_SPEED * Math.min(delta, 50)) / 1000;

      if (dist <= step) {
        this.pos = { x: target.x, y: target.y };
        this.path.shift();
        if (this.path.length === 0) {
          const done = this.onArrive;
          this.onArrive = undefined;
          // Arrival callback runs after the final draw so observers see the
          // worker already standing at the destination.
          this.draw();
          done?.();
          this.updateBob(time, delta, false);
          return;
        }
      } else {
        const nx = this.pos.x + (dx / dist) * step;
        const ny = this.pos.y + (dy / dist) * step;

        // Axis-separated movement — the same slide-along-walls rule the player
        // uses, so the worker can never walk through furniture or partitions.
        if (!isBlocked({ x: nx + FEET.x, y: this.pos.y + FEET.y, w: FEET.w, h: FEET.h })) {
          this.pos.x = nx;
        }
        if (!isBlocked({ x: this.pos.x + FEET.x, y: ny + FEET.y, w: FEET.w, h: FEET.h })) {
          this.pos.y = ny;
        }

        if (Math.abs(dx) > Math.abs(dy)) this.setFacing(dx < 0 ? "left" : "right");
        else this.setFacing(dy < 0 ? "up" : "down");
      }
    }

    this.updateBob(time, delta, this.path.length > 0);
    this.draw();
  }

  private updateBob(time: number, delta: number, moving: boolean): void {
    const target = moving ? Math.sin(time * AGENT_BOB_SPEED) * AGENT_BOB_PX : 0;
    // Smoothly settle to 0 when the worker stops (no pop).
    const ease = 1 - Math.pow(0.001, delta / 1000);
    this.bob += (target - this.bob) * Math.min(1, ease);
  }

  private draw(): void {
    this.sprite.setPosition(this.pos.x, this.pos.y + this.bob).setDepth(this.pos.y);
  }

  private setFacing(direction: Direction): void {
    const frame = `${this.config.frameBase}-${direction}`;
    if (this.sprite.texture.has(frame)) this.sprite.setFrame(frame);
  }

  /** World position of the sprite's top edge (for prompts and speech bubbles). */
  public get topY(): number {
    const source = this.scene.textures.get("ai-workers").get(`${this.config.frameBase}-front`);
    return this.pos.y - source.height * AGENT_SCALE;
  }

  /** Destroys the sprite (scene shutdown). */
  public destroy(): void {
    this.sprite.destroy();
  }
}
