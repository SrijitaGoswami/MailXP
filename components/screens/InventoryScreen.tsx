"use client";

import { useState } from "react";

import { playSound } from "../../game/audio/audioManager";
import { sendCommand } from "../../game/bridge";
import { DECOR_ITEMS, OUTFITS, getShopItem, isDecorItem, outfitTexture } from "../../game/data/shopConfig";
import { patchProfile } from "../../game/profile";
import { DecorThumb, OutfitThumb } from "../ShopThumb";
import { useGameSnapshot, useProfile } from "../useGameState";

/**
 * Inventory menu section — what the player owns and how to use it.
 *
 * - Outfits: worn one + shortcut to the Character section.
 * - Decor: every owned piece with Place / Move / Remove actions. Place and
 *   Move hand a typed `decorate` command to OfficeScene and close the menu
 *   panel (`onStartPlacement`), so the live game map is visible to click or
 *   tap the spot on; Remove edits `profile.placedDecor` directly.
 * - An active placement shows its cancel bar here (and in the live region via
 *   the announcer), so decorate mode can always be exited.
 *
 * Placed decor is local-only and purely visual — it never affects collision.
 */
export default function InventoryScreen({
  onGoShop,
  onGoCharacter,
  onStartPlacement,
}: {
  onGoShop: () => void;
  onGoCharacter: () => void;
  /** Closes the menu panel so the player can see the map they place onto. */
  onStartPlacement?: () => void;
}) {
  const profile = useProfile();
  const snapshot = useGameSnapshot();
  const [message, setMessage] = useState("");

  const ownedOutfits = OUTFITS.filter((outfit) => profile.ownedItems.includes(outfit.id));
  const ownedDecor = DECOR_ITEMS.filter((item) => profile.ownedItems.includes(item.id));
  const placed = profile.placedDecor;
  const mode = snapshot.decorMode;

  const wornName =
    profile.equippedOutfit === "worker"
      ? "Worker Outfit"
      : OUTFITS.find((o) => o.id === profile.equippedOutfit)?.name ?? "Worker Outfit";

  function startPlace(itemId: string): void {
    const item = getShopItem(itemId);
    if (!item) return;
    // Placement happens on the live map — close the menu panel so the player
    // can see (and tap) the spot they are placing on.
    sendCommand({ type: "decorate", action: "place", itemId });
    setMessage(`Click or tap a spot in the office to place the ${item.name}.`);
    onStartPlacement?.();
  }

  function startMove(index: number): void {
    const slot = placed[index];
    if (!slot) return;
    const item = getShopItem(slot.itemId);
    sendCommand({ type: "decorate", action: "move", index });
    setMessage(`Click or tap a new spot in the office for the ${item?.name ?? "item"}.`);
    onStartPlacement?.();
  }

  function remove(index: number): void {
    const slot = placed[index];
    if (!slot) return;
    const item = getShopItem(slot.itemId);
    patchProfile({ placedDecor: placed.filter((_, i) => i !== index) });
    playSound("cancel");
    setMessage(
      `Removed the ${item && isDecorItem(item) ? item.name : "item"} from the office — it stays in your inventory.`,
    );
  }

  function cancelPlacement(): void {
    sendCommand({ type: "decorate", action: "cancel" });
    setMessage("Placement cancelled.");
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {/* ---------------------------------------------------- active placement */}
      {mode ? (
        <section
          aria-label="Active decor placement"
          className="rounded-lg border-2 border-amber-600 bg-amber-50 p-4 text-left shadow-md"
          role="status"
        >
          <h2 className="text-sm font-bold text-amber-800">Placing decor</h2>
          <p className="mt-1 text-sm text-amber-900">
            {mode.mode === "move" ? "Move" : "Place"} the{" "}
            <strong>{getShopItem(mode.itemId)?.name ?? mode.itemId}</strong>: click or tap a
            spot in the office (grid-snapped). Wall pieces hang at the click point; floor
            pieces need an open floor tile.
          </p>
          <button
            type="button"
            onClick={cancelPlacement}
            className="mt-2 rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/70"
          >
            Cancel placement
          </button>
        </section>
      ) : null}

      {/* --------------------------------------------------------- worn outfit */}
      <section
        aria-label="Equipped cosmetic"
        className="rounded-lg border-2 border-[var(--mailxp-teal)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Equipped</h2>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <OutfitThumb
            sheet={
              profile.equippedOutfit === "worker"
                ? "/assets/mailxp/characters/player/worker.png"
                : `/assets/mailxp/shop/outfits/worker-${profile.equippedOutfit}.png`
            }
            frame={0}
            box={56}
            label={`Worn outfit: ${wornName}`}
            className="rounded border border-[var(--mailxp-walnut)]/30 bg-white/60"
          />
          <p className="text-sm">
            <span className="font-semibold">Outfit:</span> {wornName}
          </p>
          <button
            type="button"
            onClick={() => {
              playSound("ui-nav");
              onGoCharacter();
            }}
            className="ml-auto rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/60"
          >
            Change outfit
          </button>
        </div>

        {ownedOutfits.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {ownedOutfits.map((outfit) => (
              <li key={outfit.id} className="text-xs opacity-80">
                ✓ {outfit.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs opacity-70">
            Only the base Worker Outfit is owned — claim more looks in the Shop.
          </p>
        )}
      </section>

      {/* -------------------------------------------------------- owned decor */}
      <section
        aria-label="Owned decor"
        className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Office decor</h2>
        <p className="mt-1 text-xs opacity-70">
          Decor is cosmetic only: it is drawn depth-sorted in the office and never blocks
          movement. Everything is saved locally in this browser.
        </p>

        {ownedDecor.length === 0 ? (
          <div className="mt-3 rounded border border-dashed border-[var(--mailxp-walnut)]/50 p-4 text-sm">
            <p>No decor owned yet.</p>
            <button
              type="button"
              onClick={() => {
                playSound("ui-nav");
                onGoShop();
              }}
              className="mt-2 rounded bg-[var(--mailxp-teal)] px-3 py-1.5 text-sm font-semibold text-white shadow transition hover:opacity-90"
            >
              Browse the demo Shop
            </button>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {ownedDecor.map((item) => {
              const placedIndex = placed.findIndex((slot) => slot.itemId === item.id);
              const isPlaced = placedIndex >= 0;
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 rounded border border-[var(--mailxp-walnut)]/40 bg-white/50 p-2.5"
                >
                  <DecorThumb itemId={item.id} box={56} label={`${item.name} thumbnail`} className="rounded" />
                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-semibold">{item.name}</p>
                    <p className="text-xs opacity-70">
                      {item.category}
                      {isPlaced
                        ? ` · placed at (${placed[placedIndex].x}, ${placed[placedIndex].y})`
                        : " · not placed yet"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isPlaced ? (
                      <button
                        type="button"
                        onClick={() => startMove(placedIndex)}
                        className="rounded bg-[var(--mailxp-teal)] px-3 py-1.5 text-xs font-semibold text-white shadow transition hover:opacity-90"
                      >
                        Move
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => startPlace(item.id)}
                        className="rounded bg-[var(--mailxp-teal)] px-3 py-1.5 text-xs font-semibold text-white shadow transition hover:opacity-90"
                      >
                        Decorate
                      </button>
                    )}
                    {isPlaced ? (
                      <button
                        type="button"
                        onClick={() => remove(placedIndex)}
                        className="rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1.5 text-xs font-semibold transition hover:bg-white/70"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-3 text-sm" role="status">
          {message}
        </p>
      </section>

      {/* -------------------------------------------------- placed-list summary */}
      <section
        aria-label="Items placed in the office"
        className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">
          Placed in the office ({placed.length})
        </h2>
        {placed.length === 0 ? (
          <p className="mt-2 text-sm opacity-70">Nothing placed yet — use Decorate above.</p>
        ) : (
          <ol className="mt-2 flex list-decimal flex-col gap-1 pl-4 text-sm">
            {placed.map((slot, index) => {
              const item = getShopItem(slot.itemId);
              return (
                <li key={`${slot.itemId}-${index}`}>
                  {item?.name ?? slot.itemId} — at ({slot.x}, {slot.y})
                  {item && isDecorItem(item) ? ` · ${item.wall ? "wall" : "floor"}` : ""}
                </li>
              );
            })}
          </ol>
        )}
        <p className="mt-2 text-xs opacity-70">
          Texture in use: <code>{outfitTexture(profile.equippedOutfit)}</code> · decor is
          stored in <code>localStorage</code> under <code>mailxp.profile.v1</code>.
        </p>
      </section>
    </div>
  );
}
