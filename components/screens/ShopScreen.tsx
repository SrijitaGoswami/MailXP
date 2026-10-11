"use client";

import { useEffect, useState } from "react";

import { playSound } from "../../game/audio/audioManager";
import { sendCommand } from "../../game/bridge";
import {
  DECOR_ITEMS,
  OUTFITS,
  SHOP_CATEGORIES,
  isDecorItem,
  type DecorProduct,
  type OutfitProduct,
  type ShopCategory,
} from "../../game/data/shopConfig";
import { patchProfile } from "../../game/profile";
import { ApiError, fetchGameState, fetchShopCatalog, issueDevReward, purchaseShopItem } from "../apiClient";
import { DecorThumb, OutfitThumb } from "../ShopThumb";
import { useProfile } from "../useGameState";

type Tone = "info" | "ok" | "error";

/** Human message per stable B1 code — never branch on server message text. */
function purchaseErrorMessage(
  error: unknown,
  item: OutfitProduct | DecorProduct,
  currentBalance: number | undefined,
): string {
  if (!(error instanceof ApiError)) return "Purchase failed — no money was taken.";
  switch (error.code) {
    case "INSUFFICIENT_FUNDS":
      return (
        `Not enough DraftCoin: the ${item.name} costs ${item.price} and you have ` +
        `${currentBalance ?? "?"}. Finish office jobs to earn more.`
      );
    case "CONFLICT":
      return `You already own the ${item.name}.`;
    case "STALE_VERSION":
      return "Your shop state changed in another tab — balance resynced, please try again.";
    case "IDEMPOTENCY_MISMATCH":
    case "IDEMPOTENCY_IN_PROGRESS":
      return "This purchase is still being processed — give it a moment, then check the Inventory tab.";
    case "NETWORK_ERROR":
      return "Connection problem — the purchase did not go through and no money was taken.";
    case "UNAUTHENTICATED":
    case "SESSION_EXPIRED":
      return "Your session ended — sign in again to buy.";
    default:
      return `Purchase failed (${error.code}) — no money was taken.`;
  }
}

/**
 * Shop tab — the server-authoritative storefront (Phase B6).
 *
 * Artwork/names/descriptions come from the shipped local config; PRICES and
 * availability come from GET /api/v1/shop (server truth). Every purchase is a
 * POST /api/v1/shop/purchases with a fresh UUID Idempotency-Key and the
 * profile version fetched right before the click — the server atomically
 * deducts DraftCoin, grants inventory and writes the ledger row. DraftCoin is
 * still a simulated in-game currency (no wallet, no real money).
 *
 * Rejections carry the authoritative balance/version in `details`, which this
 * screen applies immediately (optimistic rollback without ever showing a
 * success the server did not confirm). Local `draftCoin`/`ownedItems` remain
 * the hydration-safe cache that B5 sync keeps mirrored.
 *
 * Bought items are immediately usable: outfits get a Wear button, decor a
 * Place-in-office button, both acting inline without navigation.
 */
export default function ShopScreen({
  onGoInventory,
  onGoCharacter,
  onStartPlacement,
}: {
  onGoInventory: () => void;
  onGoCharacter: () => void;
  /** Phase 7: called after a Place command so the shell can close the menu. */
  onStartPlacement: () => void;
}) {
  const profile = useProfile();
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<Tone>("info");

  // Server catalog (prices + availability). null until the fetch resolves —
  // Buy buttons stay disabled so a price is never displayed or charged from
  // an unverified source.
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof fetchShopCatalog>> | null>(null);
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  // Flips false when the dev fixture answers 404 (production) — the button
  // disappears instead of sitting there broken.
  const [devAvailable, setDevAvailable] = useState(true);

  const balance = profile.draftCoin;

  useEffect(() => {
    let alive = true;
    fetchShopCatalog()
      .then((result) => {
        if (alive) setCatalog(result);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        if (error instanceof ApiError && error.status === 401) {
          setMessage("Your session ended — sign in again to use the shop.");
          setTone("error");
        } else {
          setMessage("Shop catalog unavailable — buying is paused until the server responds.");
          setTone("error");
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  async function buy(item: OutfitProduct | DecorProduct): Promise<void> {
    if (buyingId || !catalog) return;
    setBuyingId(item.id);
    try {
      // Fresh authoritative version right before the click (contract §1.7:
      // expectedVersion makes a concurrent write lose loudly, not silently).
      const state = await fetchGameState();
      const result = await purchaseShopItem(item.id, state.version, crypto.randomUUID());
      // Success only: commit the server's answer into the local mirror.
      patchProfile({ draftCoin: result.balance, ownedItems: [...profile.ownedItems, item.id] });
      playSound("purchase");
      setTone("ok");
      setMessage(
        `Purchased ${item.name} for ${item.price} DraftCoin — balance is now ${result.balance}.`,
      );
    } catch (error) {
      // Rollback/resync: rejections carry the authoritative balance (§4).
      const detail = error instanceof ApiError ? error.fieldErrors[0] : undefined;
      if (detail?.currentBalance !== undefined) patchProfile({ draftCoin: detail.currentBalance });
      playSound("blocked");
      setTone("error");
      setMessage(purchaseErrorMessage(error, item, detail?.currentBalance));
    } finally {
      setBuyingId(null);
    }
  }

  async function claimDevReward(): Promise<void> {
    if (claiming) return;
    setClaiming(true);
    try {
      const result = await issueDevReward(crypto.randomUUID());
      if (result.awarded > 0) patchProfile({ draftCoin: result.balance });
      if (result.capped) {
        playSound("blocked");
        setTone("info");
        setMessage("Daily reward cap reached — more DraftCoin arrives after the UTC reset.");
      } else {
        playSound("purchase");
        setTone("ok");
        setMessage(`Dev fixture granted ${result.awarded} DraftCoin — balance is now ${result.balance}.`);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // Production: the fixture route does not exist there.
        setDevAvailable(false);
        return;
      }
      playSound("blocked");
      setTone("error");
      if (error instanceof ApiError && (error.code === "UNAUTHENTICATED" || error.code === "SESSION_EXPIRED")) {
        setMessage("Your session ended — sign in again.");
      } else if (error instanceof ApiError && error.code === "NETWORK_ERROR") {
        setMessage("Connection problem — nothing was granted.");
      } else {
        setMessage(error instanceof ApiError ? `Could not claim (${error.code}).` : "Could not claim.");
      }
    } finally {
      setClaiming(false);
    }
  }

  function wear(outfit: OutfitProduct): void {
    patchProfile({ equippedOutfit: outfit.id });
    playSound("equip");
    setTone("ok");
    setMessage(`Now wearing the ${outfit.name}.`);
    onGoCharacter();
  }

  function place(decor: DecorProduct): void {
    // The scene plays the placement "panel-open" cue when it receives the
    // command — React stays silent here to avoid double sounds.
    sendCommand({ type: "decorate", action: "place", itemId: decor.id });
    setTone("info");
    setMessage(
      `Click or tap a spot in the office to place the ${decor.name}. Manage it any time from the Inventory tab.`,
    );
    // Switch to Inventory (its cancel bar shows while decorating) and close
    // the menu so the office — the click target — is fully visible again.
    onGoInventory();
    onStartPlacement();
  }

  function renderCard(item: OutfitProduct | DecorProduct) {
    // Derived from the hydration-safe profile hook — a direct ownsItem()
    // read would hit localStorage during hydration and mismatch the server.
    const owned = profile.ownedItems.includes(item.id);
    const isOutfit = !isDecorItem(item);
    const serverItem = catalog?.items.find((entry) => entry.itemId === item.id);
    const price = serverItem?.price ?? item.price;
    const buying = buyingId === item.id;
    const buyDisabled = !catalog || buyingId !== null;

    return (
      <li
        key={item.id}
        className="flex flex-wrap items-start gap-3 rounded border border-[var(--mailxp-walnut)]/40 bg-white/50 p-3"
      >
        {isOutfit ? (
          <OutfitThumb
            sheet={(item as OutfitProduct).sheet}
            frame={0}
            box={72}
            label={`${item.name} preview`}
            className="rounded border border-[var(--mailxp-walnut)]/30 bg-white/70"
          />
        ) : (
          <DecorThumb itemId={item.id} box={72} label={`${item.name} preview`} className="rounded" />
        )}

        <div className="min-w-48 flex-1">
          <p className="text-sm font-semibold">
            {item.name}
            {owned ? (
              <span className="ml-2 rounded bg-[var(--mailxp-teal)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                Owned
              </span>
            ) : null}
          </p>
          <p className="text-xs opacity-70">{item.description}</p>
          <p className="mt-1 text-sm font-bold text-[var(--mailxp-teal)]">
            {price} DraftCoin
            <span className="ml-1 text-xs font-normal opacity-70">(server price)</span>
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          {!owned ? (
            <button
              type="button"
              onClick={() => void buy(item)}
              disabled={buyDisabled}
              className="rounded bg-[var(--mailxp-teal)] px-3 py-1.5 text-sm font-semibold text-white shadow transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!catalog ? "Loading shop…" : buying ? "Buying…" : `Buy — ${price} DraftCoin`}
            </button>
          ) : isOutfit ? (
            <>
              <span className="text-xs font-semibold text-[var(--mailxp-teal)]">In inventory</span>
              <button
                type="button"
                onClick={() => wear(item as OutfitProduct)}
                className="rounded bg-[var(--mailxp-teal)] px-3 py-1.5 text-sm font-semibold text-white shadow transition hover:opacity-90"
              >
                Wear it now
              </button>
            </>
          ) : (
            <>
              <span className="text-xs font-semibold text-[var(--mailxp-teal)]">In inventory</span>
              <button
                type="button"
                onClick={() => place(item as DecorProduct)}
                className="rounded bg-[var(--mailxp-teal)] px-3 py-1.5 text-sm font-semibold text-white shadow transition hover:opacity-90"
              >
                Place in office
              </button>
            </>
          )}
        </div>
      </li>
    );
  }

  const itemsByCategory: Record<ShopCategory, Array<OutfitProduct | DecorProduct>> = {
    Outfits: [...OUTFITS],
    "Wall art": DECOR_ITEMS.filter((i) => i.category === "Wall art"),
    "Plants & rugs": DECOR_ITEMS.filter((i) => i.category === "Plants & rugs"),
    "Desk & lounge": DECOR_ITEMS.filter((i) => i.category === "Desk & lounge"),
    Extras: DECOR_ITEMS.filter((i) => i.category === "Extras"),
  };

  const ownedCount = profile.ownedItems.length;
  const totalProducts = OUTFITS.length + DECOR_ITEMS.length;

  return (
    <div className="flex w-full flex-col gap-4">
      {/* --------------------------------------------------------- demo notice */}
      <section
        aria-label="Shop notice and balance"
        className="rounded-lg border-2 border-[var(--mailxp-teal)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Shop</h2>
            <p className="mt-1 text-xs opacity-70">
              DraftCoin is an in-game currency — no wallet, no blockchain, no real money.
              Prices, balance and ownership are verified by the server before anything is
              granted; owned items are usable in the game immediately.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <p className="rounded bg-white/70 px-3 py-2 text-sm font-semibold">
              Your balance: {balance} DraftCoin{" "}
              <span className="font-normal opacity-70">(server)</span>
            </p>
            {devAvailable ? (
              <button
                type="button"
                onClick={() => void claimDevReward()}
                disabled={claiming}
                className="rounded border border-[var(--mailxp-walnut)] bg-white/70 px-3 py-2 text-xs font-semibold transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                title="Development-only fixture: grants the daily-capped quest reward."
              >
                {claiming ? "Claiming…" : "Dev: +20 DraftCoin"}
              </button>
            ) : null}
          </div>
        </div>

        <p className="mt-2 text-xs opacity-70">
          Owned: {ownedCount} of {totalProducts} products
        </p>

        <p
          className={`mt-2 rounded border px-3 py-2 text-sm ${
            tone === "error"
              ? "border-red-700 bg-red-50 text-red-800"
              : tone === "ok"
                ? "border-[var(--mailxp-teal)] bg-white text-[var(--mailxp-teal)]"
                : "border-[var(--mailxp-walnut)]/40 bg-white/70"
          }`}
          role="status"
        >
          {message || "Claim any item with your DraftCoin — or keep earning in the office."}
        </p>
      </section>

      {/* ----------------------------------------------------------- products */}
      {SHOP_CATEGORIES.map((category) => (
        <section
          key={category}
          aria-label={`${category} products`}
          className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
        >
          <h2 className="text-base font-bold text-[var(--mailxp-teal)]">{category}</h2>
          {/* One column: the grid lives in the fixed 440 px menu panel, so
              viewport breakpoints (sm:/xl:) would squeeze cards until their
              texts overlapped. */}
          <ul className="mt-3 grid grid-cols-1 gap-3">
            {itemsByCategory[category].map(renderCard)}
          </ul>
        </section>
      ))}
    </div>
  );
}
