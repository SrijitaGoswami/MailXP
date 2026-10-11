/**
 * Phase 4 — typed office map / placement data.
 *
 * Pure data, no Phaser imports: the OfficeScene renders it, the collision
 * checks read it. Tile slots match `public/assets/mailxp/processed/manifest.json`
 * (`tiles.tiles[].slot`), which follows the $TilePicks order in
 * scripts/generate-assets.ps1.
 *
 * World: 40 x 30 tiles at 32 px = 1280 x 960 px — larger than the 960 x 540
 * logical screen, so the camera follows the player.
 */

export const TILE_SIZE = 32;
export const MAP_COLS = 40;
export const MAP_ROWS = 30;
export const MAP_WIDTH = MAP_COLS * TILE_SIZE; // 1280
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE; // 960

/** Tile slot ids (manifest order). */
export const TILE = {
  carpetForest: 0,
  carpetSage: 1,
  carpetCream: 2,
  woodWalnut: 4,
  woodOak: 5,
  tileGrid: 7,
  rugRed: 8,
  rugCheck: 9,
  wallTopTeal: 11,
  wallTopPlain: 14,
  wallBaseTeal: 15,
  windowSill: 17,
  doorGlass: 19,
  doorWood: 21,
  trimTeal: 24,
} as const;

/**
 * Character → tile slot legend for OFFICE_ROWS.
 * Only tiles actually used by the map are listed (the manifest still defines
 * all 26 slots).
 */
export const TILE_LEGEND: Record<string, number> = {
  ".": TILE.carpetCream,
  ",": TILE.carpetSage,
  f: TILE.carpetForest,
  w: TILE.woodWalnut,
  W: TILE.woodOak,
  g: TILE.tileGrid,
  r: TILE.rugCheck,
  R: TILE.rugRed,
  "#": TILE.wallTopTeal,
  "=": TILE.wallBaseTeal,
  "|": TILE.wallTopPlain,
  n: TILE.windowSill,
  E: TILE.doorGlass,
  D: TILE.doorWood,
  "~": TILE.trimTeal,
};

/**
 * Manifest names for every slot this map uses
 * (`manifest.tiles.tiles[].name`), used by OfficeScene to verify at runtime
 * that the map's slot indices still line up with the generated tile sheet.
 */
export const TILE_NAMES: Readonly<Record<number, string>> = {
  [TILE.carpetForest]: "carpet-forest",
  [TILE.carpetSage]: "carpet-sage",
  [TILE.carpetCream]: "carpet-cream",
  [TILE.woodWalnut]: "wood-walnut",
  [TILE.woodOak]: "wood-oak",
  [TILE.tileGrid]: "tile-grid",
  [TILE.rugRed]: "rug-red",
  [TILE.rugCheck]: "rug-check",
  [TILE.wallTopTeal]: "wall-top-teal",
  [TILE.wallTopPlain]: "wall-top-plain",
  [TILE.wallBaseTeal]: "wall-base-teal",
  [TILE.windowSill]: "window-sill",
  [TILE.doorGlass]: "door-glass",
  [TILE.doorWood]: "door-wood",
  [TILE.trimTeal]: "trim-teal",
};

/**
 * Tiles the player cannot walk on (walls, baseboards, windows).
 * Doors are walkable — the map edge clamp keeps the player inside the office.
 */
export const SOLID_TILES: ReadonlySet<number> = new Set<number>([
  TILE.wallTopTeal,
  TILE.wallTopPlain,
  TILE.wallBaseTeal,
  TILE.windowSill,
]);

/**
 * The office, 40 chars wide x 30 rows.
 *
 *  rows 0-1      top wall (window band + baseboard)
 *  rows 2-9      mail room (tile grid, left) | corridor | meeting room (oak, right).
 *                Partition at col 11 ends at row 9 (mail room entrance);
 *                partition at col 26 has a glass door on row 5 and also opens at row 9.
 *  rows 10-13    open carpet
 *  rows 14-19    workstations on carpet with a red rug (cols 17-22)
 *  rows 20-27    quiet corner (forest) | entrance path (walnut, cols 17-22) | lounge (check rug)
 *  row 28        teal baseboard strip (walnut path continues at cols 17-22)
 *  row 29        south wall with the wooden entrance door (cols 19-20, walkable)
 */
export const OFFICE_ROWS: string[] = [
  "#####nnnn#######nnnn##########nnnn######",
  "========================================",
  "|gggggggggg|..............|WWWWWWWWWWWW|",
  "|gggggggggg|..............|WWWWWWWWWWWW|",
  "|gggggggggg|..............|WWWWWWWWWWWW|",
  "|gggggggggg|..............EWWWWWWWWWWWW|",
  "|gggggggggg|..............|WWWWWWWWWWWW|",
  "|gggggggggg|..............|WWWWWWWWWWWW|",
  "|gggggggggg|..............|WWWWWWWWWWWW|",
  "|gggggggggg................WWWWWWWWWWWW|",
  "|......................................|",
  "|......................................|",
  "|......................................|",
  "|......................................|",
  "|......................................|",
  "|................RRRRRR................|",
  "|................RRRRRR................|",
  "|................RRRRRR................|",
  "|................RRRRRR................|",
  "|......................................|",
  "|ffffffffffff..............rrrrrrrrrrrr|",
  "|ffffffffffff..............rrrrrrrrrrrr|",
  "|ffffffffffff....wwwwww....rrrrrrrrrrrr|",
  "|ffffffffffff....wwwwww....rrrrrrrrrrrr|",
  "|ffffffffffff....wwwwww....rrrrrrrrrrrr|",
  "|ffffffffffff....wwwwww....rrrrrrrrrrrr|",
  "|ffffffffffff....wwwwww....rrrrrrrrrrrr|",
  "|ffffffffffff....wwwwww....rrrrrrrrrrrr|",
  "=================wwwwww=================",
  "|||||||||||||||||DD|||||||||||||||||||||",
];

/** Player spawn (feet, world px) — just inside the south entrance door. */
export const PLAYER_SPAWN = { x: 624, y: 860, facing: "up" } as const;

export interface PropPlacement {
  /** `office-props` atlas frame name. */
  frame: string;
  /** Feet position (world px). */
  x: number;
  y: number;
  /** Display scale applied to the source frame. */
  scale: number;
  /** Whether the prop blocks movement (default true). */
  solid?: boolean;
  /**
   * Depth override for items resting ON another prop (e.g. a computer on a
   * desk): set to the supporting prop's feet y + 0.5 so they draw in front of
   * it while keeping their art feet position.
   */
  depth?: number;
}

/** Furniture and props. Depth defaults to the feet y (foot-position sorting). */
export const OFFICE_PROPS: PropPlacement[] = [
  // --- mail room (pickup area, left) ---
  { frame: "mailbox", x: 96, y: 150, scale: 0.24 }, // <- mail pickup point
  { frame: "desk", x: 240, y: 260, scale: 0.25 },
  { frame: "envelope", x: 214, y: 236, scale: 0.16, solid: false, depth: 260.5 },
  { frame: "papers", x: 258, y: 236, scale: 0.16, solid: false, depth: 260.5 },
  { frame: "mug", x: 286, y: 240, scale: 0.14, solid: false, depth: 260.5 },
  { frame: "parcel", x: 150, y: 300, scale: 0.25 },
  { frame: "lockers", x: 400, y: 140, scale: 0.3 },

  // --- corridor / top center ---
  { frame: "printer", x: 560, y: 380, scale: 0.22 },
  { frame: "cabinet", x: 700, y: 380, scale: 0.22 },
  { frame: "clock", x: 640, y: 80, scale: 0.18, solid: false }, // hung on the top wall
  { frame: "notice-board", x: 770, y: 130, scale: 0.24 },

  // --- meeting room (officer, top right) ---
  { frame: "desk", x: 1056, y: 216, scale: 0.25 },
  { frame: "computer", x: 1046, y: 190, scale: 0.18, solid: false, depth: 216.5 },
  { frame: "chair", x: 1056, y: 150, scale: 0.2 },
  { frame: "plant", x: 1210, y: 200, scale: 0.22 },

  // --- workstation row (sage carpet) ---
  { frame: "desk", x: 288, y: 560, scale: 0.25 },
  { frame: "computer", x: 278, y: 534, scale: 0.18, solid: false, depth: 560.5 },
  { frame: "chair", x: 288, y: 636, scale: 0.2 },
  { frame: "desk", x: 608, y: 560, scale: 0.25 },
  { frame: "computer", x: 598, y: 534, scale: 0.18, solid: false, depth: 560.5 },
  { frame: "chair", x: 608, y: 636, scale: 0.2 },
  { frame: "desk", x: 928, y: 560, scale: 0.25 },
  { frame: "computer", x: 918, y: 534, scale: 0.18, solid: false, depth: 560.5 },
  { frame: "chair", x: 928, y: 636, scale: 0.2 },

  // --- lounge (right, check rug) ---
  { frame: "couch", x: 1080, y: 790, scale: 0.25 },
  { frame: "water-cooler", x: 1215, y: 700, scale: 0.22 },
  { frame: "plant", x: 910, y: 730, scale: 0.22 },
  { frame: "lamp", x: 1195, y: 860, scale: 0.22 },
  { frame: "wastebasket", x: 940, y: 870, scale: 0.22 },

  // --- quiet corner (left, forest carpet) ---
  { frame: "bookshelf", x: 110, y: 720, scale: 0.25 },
  { frame: "couch", x: 310, y: 845, scale: 0.25 },
  { frame: "plant", x: 390, y: 740, scale: 0.22 },
  { frame: "wastebasket", x: 180, y: 880, scale: 0.2 },

  // --- entrance ---
  { frame: "notice-board", x: 470, y: 870, scale: 0.24 },
  { frame: "plant", x: 776, y: 870, scale: 0.22 },

  // --- left wall ---
  { frame: "cabinet", x: 96, y: 470, scale: 0.22 },
  { frame: "water-cooler", x: 96, y: 560, scale: 0.22 },
];

export type Direction = "down" | "left" | "right" | "up";

export interface NpcPlacement {
  /** Matches questConfig deliveryNpcId / NPC_DIALOGUE keys. */
  id: string;
  /** Name used in prompts and dialogue headers. */
  name: string;
  /** `office-npcs` atlas column (frame = `${id}-${facing}`... see name below). */
  frameBase: string;
  x: number;
  y: number;
  facing: Direction;
}

/** The four office NPCs (full roster). */
export const OFFICE_NPCS: NpcPlacement[] = [
  { id: "officer", name: "Officer", frameBase: "officer", x: 1056, y: 180, facing: "down" },
  { id: "agent", name: "Agent", frameBase: "agent", x: 470, y: 620, facing: "down" },
  { id: "monkey", name: "Monkey", frameBase: "monkey", x: 1000, y: 800, facing: "left" },
  { id: "intern", name: "Intern", frameBase: "intern", x: 288, y: 300, facing: "down" },
];

/** Feet position of the mail pickup (the mailbox prop above). */
export const MAIL_PICKUP = { x: 96, y: 150 } as const;

/** Convert one OFFICE_ROWS string into manifest tile slots. */
export function rowToTiles(row: string): number[] {
  return [...row].map((ch) => {
    const slot = TILE_LEGEND[ch];
    if (slot === undefined) {
      throw new Error(`officeMap: unknown map character '${ch}'`);
    }
    return slot;
  });
}
