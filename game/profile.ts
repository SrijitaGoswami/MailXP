/**
 * Local demo profile — the single source of truth for state that persists in
 * the player's browser (Phase 6).
 *
 * Holds the local DraftCoin balance, owned cosmetics, the equipped outfit,
 * placed office decor and the Settings preferences (sound/motion/controls).
 * Everything is stored in localStorage on this machine only: no backend, no
 * wallet, no blockchain, no network calls of any kind.
 *
 * Framework-free on purpose so both React screens (Shop, Character, Settings,
 * …) and Phaser scenes (OfficeScene reads the equipped outfit and decor)
 * can share it without importing each other. Every mutation goes through
 * `patchProfile`, which persists and notifies subscribers — scenes subscribe
 * in `create()` and unsubscribe on shutdown, exactly like the typed bridge.
 *
 * Since B2, persistence goes through the `ProfileStorage` adapter
 * (game/profileStorage.ts). The active adapter is the same synchronous
 * localStorage backend as before — same key, same defaults, same behaviour —
 * but a future server-sync phase can swap it without touching this API.
 */

import { QUEST_START_BALANCE } from "./data/questConfig";
import { getProfileStorage } from "./profileStorage";

// --------------------------------------------------------------------- types --

export type OutfitId = "worker" | "courier" | "tech" | "forest";

/** A decor item placed somewhere in the office (world px, foot anchor). */
export interface PlacedDecor {
  /** Shop item id (see `game/data/shopConfig.ts`). */
  itemId: string;
  /** Center-x of the snapped tile the item occupies. */
  x: number;
  /** Foot-y the item is depth-sorted from. */
  y: number;
}

export type MotionSetting = "full" | "reduced";
export type TouchSetting = "auto" | "on" | "off";

export interface Preferences {
  /** Master volume, 0 … 1 (multiplies the ui/game buses). */
  masterVolume: number;
  /** UI bus volume, 0 … 1. */
  uiVolume: number;
  /** Game (office/mail) bus volume, 0 … 1. */
  gameVolume: number;
  /** Mute everything instantly (gain 0 — no context teardown). */
  muted: boolean;
  /** "reduced" disables decorative looping tweens and softens panel motion. */
  motion: MotionSetting;
  /** Touch D-pad visibility: shown automatically on touch devices, forced, off. */
  touchControls: TouchSetting;
}

export interface Profile {
  version: 1;
  /** Local demo balance — NOT a real wallet balance. */
  draftCoin: number;
  /** Shop item ids the player owns (base "worker" outfit is always owned). */
  ownedItems: string[];
  /** Currently worn outfit. */
  equippedOutfit: OutfitId;
  /** Decor placed in the office, in placement order. */
  placedDecor: PlacedDecor[];
  prefs: Preferences;
}

type Listener = (profile: Profile) => void;

/** Patch accepted by `patchProfile` — prefs may be partial and are merged. */
export type ProfilePatch = Partial<Omit<Profile, "prefs">> & { prefs?: Partial<Preferences> };

// -------------------------------------------------------------------- storage --
// B2: reads/writes go through the ProfileStorage adapter (game/profileStorage.ts).
// The active adapter is the same synchronous localStorage backend as before —
// key, defaults, migrations and fallbacks are unchanged.

const DEFAULTS: Profile = {
  version: 1,
  draftCoin: QUEST_START_BALANCE,
  ownedItems: [],
  equippedOutfit: "worker",
  placedDecor: [],
  prefs: {
    masterVolume: 0.8,
    uiVolume: 0.9,
    gameVolume: 0.8,
    muted: false,
    motion: "full",
    touchControls: "auto",
  },
};

let cached: Profile | null = null;
const listeners = new Set<Listener>();

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Coerces anything from storage into a valid profile (schema drift = defaults). */
function sanitize(raw: unknown): Profile {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS, prefs: { ...DEFAULTS.prefs } };
  const data = raw as Partial<Profile>;
  const prefs = (data.prefs ?? {}) as Partial<Preferences>;
  return {
    version: 1,
    draftCoin: isNum(data.draftCoin) && data.draftCoin >= 0 ? Math.floor(data.draftCoin) : DEFAULTS.draftCoin,
    ownedItems: Array.isArray(data.ownedItems) ? data.ownedItems.filter((id): id is string => typeof id === "string") : [],
    equippedOutfit:
      data.equippedOutfit === "courier" || data.equippedOutfit === "tech" || data.equippedOutfit === "forest"
        ? data.equippedOutfit
        : "worker",
    placedDecor: Array.isArray(data.placedDecor)
      ? data.placedDecor.filter(
          (d): d is PlacedDecor =>
            !!d && typeof d === "object" && typeof d.itemId === "string" && isNum(d.x) && isNum(d.y),
        )
      : [],
    prefs: {
      masterVolume: clamp01(prefs.masterVolume, DEFAULTS.prefs.masterVolume),
      uiVolume: clamp01(prefs.uiVolume, DEFAULTS.prefs.uiVolume),
      gameVolume: clamp01(prefs.gameVolume, DEFAULTS.prefs.gameVolume),
      muted: typeof prefs.muted === "boolean" ? prefs.muted : DEFAULTS.prefs.muted,
      motion: prefs.motion === "reduced" ? "reduced" : "full",
      touchControls:
        prefs.touchControls === "on" || prefs.touchControls === "off" ? prefs.touchControls : "auto",
    },
  };
}

function clamp01(value: unknown, fallback: number): number {
  return isNum(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function read(): Profile {
  const raw = getProfileStorage().read();
  return raw ? sanitize(raw) : { ...DEFAULTS, prefs: { ...DEFAULTS.prefs } };
}

/**
 * The pristine defaults, as one stable (frozen) reference. This is what the
 * server renders and what React hydrates against — `getProfile` may return
 * persisted values, so passing it as `useSyncExternalStore`'s server snapshot
 * would mismatch on every reload where storage differs from the defaults.
 */
const SERVER_PROFILE: Profile = Object.freeze({ ...DEFAULTS, prefs: Object.freeze({ ...DEFAULTS.prefs }) });

function persist(profile: Profile): void {
  getProfileStorage().write(profile);
}

// ---------------------------------------------------------------- public API --

/** Current profile (loaded from localStorage on first use). */
export function getProfile(): Profile {
  if (!cached) cached = read();
  return cached;
}

/**
 * Pristine defaults — stable reference for React's `useSyncExternalStore`
 * `getServerSnapshot` (matches the server-rendered HTML during hydration).
 */
export function getDefaultProfile(): Profile {
  return SERVER_PROFILE;
}

/** Subscribe to profile changes. Returns an idempotent unsubscribe function. */
export function subscribeProfile(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Merge a patch into the profile, persist it and notify subscribers. */
export function patchProfile(patch: ProfilePatch): Profile {
  const current = getProfile();
  const next: Profile = { ...current, ...patch, prefs: { ...current.prefs, ...(patch.prefs ?? {}) } };
  cached = next;
  persist(next);
  for (const listener of listeners) listener(next);
  return next;
}

/** Add (or subtract, with a negative value) local DraftCoin. Never goes below 0. */
export function addDraftCoin(delta: number): Profile {
  const draftCoin = Math.max(0, getProfile().draftCoin + Math.round(delta));
  return patchProfile({ draftCoin });
}

/**
 * Spend `amount` local DraftCoin if the balance covers it.
 * Returns false (and plays nothing — the caller decides feedback) otherwise.
 */
export function spendDraftCoin(amount: number): boolean {
  if (amount < 0) return false;
  if (getProfile().draftCoin < amount) return false;
  patchProfile({ draftCoin: getProfile().draftCoin - amount });
  return true;
}

/** Whether the player owns a shop item (base worker outfit is implicit). */
export function ownsItem(itemId: string): boolean {
  return itemId === "worker" || getProfile().ownedItems.includes(itemId);
}

/**
 * Buy a shop item with local demo DraftCoin (simulated — no wallet, no chain).
 * Returns `"ok"`, `"owned"` or `"insufficient"`.
 */
export function purchaseItem(itemId: string, price: number): "ok" | "owned" | "insufficient" {
  if (ownsItem(itemId)) return "owned";
  if (getProfile().draftCoin < price) return "insufficient";
  patchProfile({
    draftCoin: getProfile().draftCoin - price,
    ownedItems: [...getProfile().ownedItems, itemId],
  });
  return "ok";
}

/** Reset every persisted field (Settings → reset demo data). */
export function resetProfile(): Profile {
  return patchProfile({
    draftCoin: DEFAULTS.draftCoin,
    ownedItems: [],
    equippedOutfit: "worker",
    placedDecor: [],
    prefs: { ...DEFAULTS.prefs },
  });
}
