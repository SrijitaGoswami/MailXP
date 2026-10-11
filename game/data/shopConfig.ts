/**
 * Phase 6 — demo shop catalog. Every product references real artwork that
 * ships in `public/assets/mailxp/shop/` (outfit sheets) and the four shop
 * decor atlases measured by `scripts/measure-shop-assets.ps1` into
 * `processed/shop-*.json`.
 *
 * All prices are paid in the LOCAL demo currency (DraftCoin) through
 * `profile.purchaseItem` — simulated purchases only. No wallet, no blockchain,
 * no real money, no backend: purchases are stored in this browser.
 *
 * Display sizes are given as the on-screen height in world pixels; the office
 * scene derives each sprite's scale from the measured frame size, so swapping
 * the art (drop-in a new PNG + re-run the measure script) never requires
 * touching this file's geometry.
 */

import type { OutfitId } from "../profile";

export type ShopCategory =
  | "Outfits"
  | "Wall art"
  | "Plants & rugs"
  | "Desk & lounge"
  | "Extras";

export interface OutfitProduct {
  /** Also the equipped-outfit id stored in the profile. */
  id: Exclude<OutfitId, "worker">;
  name: string;
  description: string;
  /** DraftCoin price (demo). */
  price: number;
  /** Phaser spritesheet texture key (loaded by PreloadScene). */
  texture: string;
  /** Static path for the React preview (exact same sheet the game plays). */
  sheet: string;
}

export interface DecorProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  category: Exclude<ShopCategory, "Outfits">;
  /** Phaser atlas texture key (loaded by PreloadScene from processed JSON). */
  atlas: string;
  /** Frame name inside the atlas (see processed/shop-*.json). */
  frame: string;
  /** On-screen height in world px (scale = displayHeight / measured frame h). */
  displayHeight: number;
  /**
   * Wall pieces hang at the click point (center anchor); everything else
   * stands on the floor (foot anchor).
   */
  wall?: boolean;
}

// ------------------------------------------------------------------ outfits --

export const OUTFITS: readonly OutfitProduct[] = [
  {
    id: "courier",
    name: "Courier Outfit",
    description: "Quick-dry teal courier kit — cap, vest and satchel for fast deliveries.",
    price: 25,
    texture: "outfit-courier",
    sheet: "/assets/mailxp/shop/outfits/worker-courier.png",
  },
  {
    id: "tech",
    name: "Tech Outfit",
    description: "Bright tech-crew look with headphones — for replies that need debugging.",
    price: 25,
    texture: "outfit-tech",
    sheet: "/assets/mailxp/shop/outfits/worker-tech.png",
  },
  {
    id: "forest",
    name: "Forest Outfit",
    description: "Leafy green ranger outfit — a calm, natural palette for busy days.",
    price: 25,
    texture: "outfit-forest",
    sheet: "/assets/mailxp/shop/outfits/worker-forest.png",
  },
];

/** The always-owned base appearance (the shipped worker sheet). */
export const BASE_OUTFIT = {
  id: "worker" as const,
  name: "Worker Outfit",
  description: "The classic MailXP uniform — owned from the start.",
  texture: "worker",
  sheet: "/assets/mailxp/characters/player/worker.png",
};

/** shop item id of an outfit === its OutfitId. */
export function outfitTexture(outfit: OutfitId): string {
  return outfit === "worker" ? BASE_OUTFIT.texture : `outfit-${outfit}`;
}

// ------------------------------------------------------------------- decor --

export const DECOR_ITEMS: readonly DecorProduct[] = [
  // --- Wall art (center-anchored, hang at the click point) -------------------
  { id: "art-mountain", name: "Mountain Print", description: "Framed mountain landscape for the north wall.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "art-mountain", displayHeight: 84, wall: true },
  { id: "art-abstract", name: "Abstract Print", description: "Warm abstract shapes in a slim frame.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "art-abstract", displayHeight: 84, wall: true },
  { id: "art-botanical", name: "Botanical Print", description: "Pressed-leaf artwork in a wooden frame.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "art-botanical", displayHeight: 84, wall: true },
  { id: "art-city", name: "City Print", description: "Sunset skyline print for a modern wall.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "art-city", displayHeight: 84, wall: true },
  { id: "plaque-shield", name: "Gold Shield Plaque", description: "A shiny shield plaque — office achievements, on display.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "plaque-shield", displayHeight: 60, wall: true },
  { id: "bulletin-board", name: "Bulletin Board", description: "Cork board for notes and pinned reminders.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "bulletin-board", displayHeight: 92, wall: true },
  { id: "clock-gold", name: "Gold Wall Clock", description: "Classic round clock with gold trim.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "clock-gold", displayHeight: 64, wall: true },
  { id: "clock-teal", name: "Teal Wall Clock", description: "Round clock in MailXP teal.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "clock-teal", displayHeight: 64, wall: true },
  { id: "pennant", name: "Teal Pennant", description: "Felt pennant banner with gold trim.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "pennant", displayHeight: 70, wall: true },
  { id: "mirror-oval", name: "Oval Mirror", description: "Beveled oval mirror to open up the room.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "mirror-oval", displayHeight: 94, wall: true },
  { id: "mail-sorter", name: "Wall Mail Sorter", description: "Six-cubby sorter that keeps post off the floor.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "mail-sorter", displayHeight: 84, wall: true },
  { id: "wall-sconce", name: "Wall Sconce", description: "Small shaded sconce for a warm corner.", price: 10, category: "Wall art", atlas: "shop-wall", frame: "wall-sconce", displayHeight: 76, wall: true },
  { id: "frame-abstract", name: "Framed Art", description: "Big framed piece with soft shapes — floor-leaning or hung.", price: 10, category: "Wall art", atlas: "shop-decor", frame: "frame-abstract", displayHeight: 88, wall: true },

  // --- Plants & rugs ---------------------------------------------------------
  { id: "plant-fiddle", name: "Fiddle-Leaf Plant", description: "Tall fiddle-leaf in a blue pot.", price: 12, category: "Plants & rugs", atlas: "shop-plants", frame: "plant-fiddle", displayHeight: 105 },
  { id: "plant-hanging", name: "Hanging Plant", description: "Trailing vines in a woven basket.", price: 12, category: "Plants & rugs", atlas: "shop-plants", frame: "plant-hanging", displayHeight: 110 },
  { id: "plant-monstera", name: "Monstera Planter", description: "Wide monstera leaves in a wooden planter.", price: 12, category: "Plants & rugs", atlas: "shop-plants", frame: "plant-monstera", displayHeight: 100 },
  { id: "succulents-tray", name: "Succulent Tray", description: "Three small succulents on a wooden tray.", price: 10, category: "Plants & rugs", atlas: "shop-plants", frame: "succulents-tray", displayHeight: 62 },
  { id: "plant-bamboo", name: "Bamboo Plant", description: "Slender bamboo in a dark ceramic pot.", price: 12, category: "Plants & rugs", atlas: "shop-plants", frame: "plant-bamboo", displayHeight: 104 },
  { id: "orchid", name: "White Orchid", description: "Blooming orchid in a cream pot.", price: 12, category: "Plants & rugs", atlas: "shop-plants", frame: "orchid", displayHeight: 96 },
  { id: "potted-plant", name: "Potted Plant", description: "Bushy green plant in a white pot.", price: 12, category: "Plants & rugs", atlas: "shop-decor", frame: "potted-plant", displayHeight: 92 },
  { id: "rug-round", name: "Round Sage Rug", description: "Braided round rug in muted sage.", price: 10, category: "Plants & rugs", atlas: "shop-plants", frame: "rug-round", displayHeight: 96 },
  { id: "rug-runner", name: "Diamond Runner", description: "Teal runner with a diamond motif and fringe.", price: 10, category: "Plants & rugs", atlas: "shop-plants", frame: "rug-runner", displayHeight: 88 },
  { id: "rug-oval", name: "Oval Ochre Rug", description: "Soft oval rug with an ochre border.", price: 10, category: "Plants & rugs", atlas: "shop-plants", frame: "rug-oval", displayHeight: 92 },
  { id: "rug-sage", name: "Sage Floor Rug", description: "Large woven rug in soft sage and cream.", price: 10, category: "Plants & rugs", atlas: "shop-decor", frame: "rug-sage", displayHeight: 96 },
  { id: "floor-cushions", name: "Floor Cushions", description: "A pair of pouffe floor cushions for lounging.", price: 10, category: "Plants & rugs", atlas: "shop-plants", frame: "floor-cushions", displayHeight: 66 },
  { id: "umbrella-stand", name: "Umbrella Stand", description: "Scalloped stand holding two umbrellas.", price: 8, category: "Plants & rugs", atlas: "shop-plants", frame: "umbrella-stand", displayHeight: 88 },
  { id: "boot-tray", name: "Boot Tray", description: "Boots and a fern on a slatted wooden tray.", price: 10, category: "Plants & rugs", atlas: "shop-plants", frame: "boot-tray", displayHeight: 74 },

  // --- Desk & lounge ---------------------------------------------------------
  { id: "desk-organizer", name: "Desk Organizer", description: "Wooden caddy with pens and a notepad.", price: 8, category: "Desk & lounge", atlas: "shop-desk", frame: "desk-organizer", displayHeight: 64 },
  { id: "pen-cup", name: "Pen Cup", description: "Teal cup of pencils for the desk.", price: 6, category: "Desk & lounge", atlas: "shop-desk", frame: "pen-cup", displayHeight: 56 },
  { id: "notebooks", name: "Notebook Stack", description: "A tidy stack of notebooks and files.", price: 6, category: "Desk & lounge", atlas: "shop-desk", frame: "notebooks", displayHeight: 58 },
  { id: "timer", name: "Kitchen Timer", description: "Teal wind-up timer for focused sprints.", price: 6, category: "Desk & lounge", atlas: "shop-desk", frame: "timer", displayHeight: 48 },
  { id: "photo-frame", name: "Photo Frame", description: "Standing frame with a landscape photo.", price: 6, category: "Desk & lounge", atlas: "shop-desk", frame: "photo-frame", displayHeight: 62 },
  { id: "bird-statue", name: "Bird Statue", description: "Mail-bird figurine holding an envelope.", price: 8, category: "Desk & lounge", atlas: "shop-desk", frame: "bird-statue", displayHeight: 66 },
  { id: "desk-lamp", name: "Desk Lamp", description: "Teal adjustable lamp with a bright shade.", price: 10, category: "Desk & lounge", atlas: "shop-decor", frame: "desk-lamp", displayHeight: 74 },
  { id: "mug-cloud", name: "Cloud Mug", description: "Favorite office mug with a cloud motif.", price: 6, category: "Desk & lounge", atlas: "shop-decor", frame: "mug-cloud", displayHeight: 40 },
  { id: "beanbag", name: "Beanbag", description: "Slouchy teal beanbag for the corner.", price: 12, category: "Desk & lounge", atlas: "shop-desk", frame: "beanbag", displayHeight: 78 },
  { id: "floor-lamp", name: "Floor Lamp", description: "Tall lamp with a cream shade.", price: 12, category: "Desk & lounge", atlas: "shop-desk", frame: "floor-lamp", displayHeight: 120 },
  { id: "loveseat", name: "Loveseat", description: "Two-seat sage sofa for the lounge area.", price: 12, category: "Desk & lounge", atlas: "shop-desk", frame: "loveseat", displayHeight: 104 },
  { id: "footrest", name: "Footrest", description: "Round teal ottoman to put your feet up.", price: 10, category: "Desk & lounge", atlas: "shop-desk", frame: "footrest", displayHeight: 62 },
  { id: "coffee-tray", name: "Coffee Tray", description: "Tray with two fresh cups — on the house.", price: 8, category: "Desk & lounge", atlas: "shop-desk", frame: "coffee-tray", displayHeight: 56 },
  { id: "radio", name: "Vintage Radio", description: "Wood-panelled radio for easy-listening hours.", price: 10, category: "Desk & lounge", atlas: "shop-desk", frame: "radio", displayHeight: 62 },

  // --- Extras ----------------------------------------------------------------
  { id: "trophy", name: "Gold Trophy", description: "A trophy for the fastest replier in the office.", price: 10, category: "Extras", atlas: "shop-decor", frame: "trophy", displayHeight: 74 },
  { id: "clock-pendulum", name: "Pendulum Clock", description: "Tall wooden grandfather clock with a swinging pendulum.", price: 12, category: "Extras", atlas: "shop-decor", frame: "clock-pendulum", displayHeight: 124 },
  { id: "bird-figurine", name: "Mail-Bird Figurine", description: "Little blue mail-bird mascot for a shelf.", price: 8, category: "Extras", atlas: "shop-decor", frame: "bird-figurine", displayHeight: 56 },
];

export const SHOP_CATEGORIES: readonly ShopCategory[] = [
  "Outfits",
  "Wall art",
  "Plants & rugs",
  "Desk & lounge",
  "Extras",
];

const byId = new Map<string, DecorProduct | OutfitProduct>(
  [...DECOR_ITEMS, ...OUTFITS].map((item) => [item.id, item]),
);

/** Look up any product by its shop id (outfit id === shop item id). */
export function getShopItem(id: string): DecorProduct | OutfitProduct | undefined {
  return byId.get(id);
}

export function isDecorItem(item: DecorProduct | OutfitProduct): item is DecorProduct {
  return "atlas" in item;
}

/** Total number of products (3 outfits + 44 decor). */
export const SHOP_ITEM_COUNT = OUTFITS.length + DECOR_ITEMS.length;
