"use client";

import { useState } from "react";

import { playSound } from "../../game/audio/audioManager";
import { BASE_OUTFIT, OUTFITS } from "../../game/data/shopConfig";
import { patchProfile, type OutfitId } from "../../game/profile";
import { OutfitThumb } from "../ShopThumb";
import { useProfile } from "../useGameState";

interface Candidate {
  id: OutfitId;
  name: string;
  description: string;
  sheet: string;
  owned: boolean;
}

const DIRECTIONS = [
  { frame: 0, label: "facing down" },
  { frame: 4, label: "facing left" },
  { frame: 8, label: "facing right" },
  { frame: 12, label: "facing up" },
] as const;

/**
 * Character tab — selection and appearance using only the real character
 * sheets (worker.png + the three shop outfit sheets). Previews are cropped
 * from those exact frames, so what is shown is what the game plays.
 * Outfits that are not owned yet link to the Shop (no dead buttons).
 */
export default function CharacterScreen({
  onGoShop,
}: {
  onGoShop: () => void;
}) {
  const profile = useProfile();
  const [message, setMessage] = useState("");

  const candidates: Candidate[] = [
    { id: "worker", name: BASE_OUTFIT.name, description: BASE_OUTFIT.description, sheet: BASE_OUTFIT.sheet, owned: true },
    ...OUTFITS.map((outfit) => ({
      id: outfit.id as OutfitId,
      name: outfit.name,
      description: outfit.description,
      sheet: outfit.sheet,
      // From the hydration-safe hook, not ownsItem(): a direct storage read
      // here would mismatch the server-rendered HTML on reload (React #418).
      owned: profile.ownedItems.includes(outfit.id),
    })),
  ];

  const worn = candidates.find((c) => c.id === profile.equippedOutfit) ?? candidates[0];

  function equip(candidate: Candidate): void {
    if (!candidate.owned) {
      playSound("blocked");
      setMessage(`${candidate.name} is not owned yet — claim it in the Shop with local demo DraftCoin.`);
      return;
    }
    if (candidate.id === profile.equippedOutfit) return;
    patchProfile({ equippedOutfit: candidate.id });
    playSound("equip");
    setMessage(`Now wearing the ${candidate.name}. The office worker changes instantly.`);
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {/* --------------------------------------------------- currently worn */}
      <section
        aria-label="Current appearance"
        className="rounded-lg border-2 border-[var(--mailxp-teal)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Current appearance</h2>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <OutfitThumb sheet={worn.sheet} frame={0} box={96} label={`${worn.name}, front view`} className="rounded border border-[var(--mailxp-walnut)]/30 bg-white/60" />
          <div className="min-w-40 flex-1">
            <p className="text-sm font-semibold">{worn.name}</p>
            <p className="text-xs opacity-70">{worn.description}</p>
            <p className="mt-1 text-xs font-semibold text-[var(--mailxp-teal)]">Worn now</p>
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className="text-xs font-semibold uppercase tracking-wide opacity-70">
            In-game directions (idle frames from the same sheet)
          </legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {DIRECTIONS.map((dir) => (
              <figure key={dir.frame} className="flex flex-col items-center gap-1">
                <OutfitThumb
                  sheet={worn.sheet}
                  frame={dir.frame}
                  box={56}
                  label={`${worn.name} ${dir.label}`}
                  className="rounded border border-[var(--mailxp-walnut)]/30 bg-white/60"
                />
                <figcaption className="text-[10px] uppercase opacity-70">{dir.label.replace("facing ", "")}</figcaption>
              </figure>
            ))}
          </div>
        </fieldset>
      </section>

      {/* -------------------------------------------------------- collection */}
      <section
        aria-label="Outfit collection"
        className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Outfits</h2>
        <p className="mt-1 text-xs opacity-70">
          Owned outfits can be worn any time; locked ones are claimed in the Shop with
          local demo DraftCoin (simulated — no real payment).
        </p>

        <ul className="mt-3 flex flex-col gap-3">
          {candidates.map((candidate) => {
            const wornNow = candidate.id === profile.equippedOutfit;
            return (
              <li
                key={candidate.id}
                className="flex flex-wrap items-center gap-3 rounded border border-[var(--mailxp-walnut)]/40 bg-white/50 p-3"
              >
                <OutfitThumb
                  sheet={candidate.sheet}
                  frame={0}
                  box={64}
                  label={`${candidate.name} preview`}
                  className="rounded border border-[var(--mailxp-walnut)]/30 bg-white/60"
                />
                <div className="min-w-48 flex-1">
                  <p className="text-sm font-semibold">
                    {candidate.name}
                    {wornNow ? (
                      <span className="ml-2 rounded bg-[var(--mailxp-teal)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                        Worn
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs opacity-70">{candidate.description}</p>
                  <p className="mt-0.5 text-xs">
                    {candidate.owned ? "Owned" : "Not owned yet"}
                  </p>
                </div>
                {wornNow ? (
                  <span className="rounded border-2 border-[var(--mailxp-walnut)]/40 px-3 py-1.5 text-xs font-semibold opacity-60">
                    Wearing now
                  </span>
                ) : candidate.owned ? (
                  <button
                    type="button"
                    onClick={() => equip(candidate)}
                    className="rounded bg-[var(--mailxp-teal)] px-3 py-1.5 text-sm font-semibold text-white shadow transition hover:opacity-90 focus-visible:outline focus-visible:outline-2"
                  >
                    Wear this outfit
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      playSound("ui-nav");
                      onGoShop();
                    }}
                    className="rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/60"
                  >
                    Get it in the Shop
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-sm" role="status">
          {message}
        </p>
      </section>
    </div>
  );
}
