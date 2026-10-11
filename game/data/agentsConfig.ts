/**
 * Configuration for the two local AI workers (Phase 5): where they stand, how
 * they glide to a quest and how the restrained movement is tuned.
 *
 * The workers have NO walk frames (their atlases only ship front/left/right/
 * back poses), so movement is a smooth glide along config-defined waypoint
 * routes that respect the existing collision map, drawn with the facing frame
 * that matches travel direction plus a gentle vertical bob.
 *
 * All coordinates are world px (feet position), on open, walkable tiles.
 */

import type { Direction } from "./officeMap";

export type AgentId = "understanding" | "response";

export interface AgentHome {
  x: number;
  y: number;
  facing: Direction;
}

export interface AgentConfig {
  /** Atlas frame prefix in `ai-workers` (`understanding-*` / `response-*`). */
  frameBase: "understanding" | "response";
  name: string;
  home: AgentHome;
}

/** Standing spots on the open carpet (row y = 400 is walkable across the map). */
export const AGENTS: Record<AgentId, AgentConfig> = {
  understanding: {
    frameBase: "understanding",
    name: "Understanding Worker",
    home: { x: 150, y: 400, facing: "right" },
  },
  response: {
    frameBase: "response",
    name: "Response Worker",
    home: { x: 1130, y: 400, facing: "left" },
  },
};

/** 444 px source frames scaled to ~57 px (the player renders at 62.6 px). */
export const AGENT_SCALE = 0.13;

/** Glide speed in px/s (the player walks at 110 px/s). */
export const AGENT_SPEED = 96;

/** Restrained motion: vertical bob amplitude in px while gliding. */
export const AGENT_BOB_PX = 2.5;

/** Bob speed while gliding (radians per ms). */
export const AGENT_BOB_SPEED = 0.009;

export interface AgentPoint {
  x: number;
  y: number;
}

/**
 * Where each worker goes for each reply quest.
 *
 * Routes are built as an L-shape: home → (target.x, home.y) → target, so the
 * long leg always runs along the open carpet row (home.y = 400) and the short
 * leg drops onto a spot that is clear of desks, NPCs and walls.
 */
export const AGENT_ROUTES: Record<string, { understanding: AgentPoint; response: AgentPoint }> = {
  "reply-invoice": {
    understanding: { x: 380, y: 500 },
    response: { x: 760, y: 400 },
  },
  "reply-demo": {
    understanding: { x: 660, y: 500 },
    response: { x: 880, y: 400 },
  },
  "reply-export": {
    understanding: { x: 450, y: 500 },
    response: { x: 980, y: 400 },
  },
};

/** Deterministic idle line per worker while no job is being processed. */
export const AGENT_IDLE_LINES: Record<AgentId, string> = {
  understanding: "I read the active job and classify it locally — no cloud, no magic.",
  response: "When a job is classified I draft the reply for you to review.",
};
