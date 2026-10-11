"use client";

import { useState } from "react";

import { playSound } from "../../game/audio/audioManager";
import { CURRENCY } from "../../game/data/questConfig";
import { useGameSnapshot, useProfile } from "../useGameState";

/**
 * Rewards tab — wallet and rewards preview.
 *
 * Draws a hard line between what is real and what is demo:
 *
 * - **Local DraftCoin** (this page's balance) is a demo number persisted in
 *   this browser's localStorage. It is not a cryptocurrency, not on-chain and
 *   cannot be spent anywhere.
 * - **Wallet / on-chain balance / NFT claims** are future integrations. The
 *   disclosure explains exactly what is and is not implemented; no address,
 *   transaction hash or fake chain activity is ever fabricated.
 */
export default function RewardsScreen() {
  const snapshot = useGameSnapshot();
  const profile = useProfile();
  const [walletOpen, setWalletOpen] = useState(false);

  const completed = snapshot.quests.filter((quest) => quest.status === "completed").length;
  const questCount = snapshot.quests.length || snapshot.questCount;

  function toggleWallet(): void {
    setWalletOpen((open) => {
      playSound(open ? "panel-close" : "panel-open");
      return !open;
    });
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {/* -------------------------------------------------- local balance card */}
      <section
        aria-label="Local DraftCoin balance"
        className="rounded-lg border-2 border-[var(--mailxp-teal)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">Rewards & wallet preview</h2>

        <div className="mt-3 flex flex-wrap items-baseline gap-3">
          <p className="text-3xl font-bold text-[var(--mailxp-teal)]">
            {profile.draftCoin} {CURRENCY}
          </p>
          <span className="rounded bg-white/70 px-2 py-1 text-xs font-semibold uppercase tracking-wide">
            Local demo balance
          </span>
        </div>

        <p className="mt-2 max-w-2xl text-sm opacity-80">
          This balance lives only in <code>localStorage</code> on this device
          (<code>mailxp.profile.v1</code>). It is <strong>not</strong> a real on-chain
          balance, not a cryptocurrency, and it cannot be transferred or spent outside this
          demo. Quest rewards add to it; shop purchases and simulated sends subtract from it.
        </p>

        {/* Always 2×2: this sits in the 440 px menu panel, where a viewport
            sm: breakpoint would force four cramped columns. */}
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded border border-[var(--mailxp-walnut)]/40 bg-white/60 p-2">
            <dt className="text-xs uppercase opacity-70">Mail handled</dt>
            <dd className="text-lg font-bold">{snapshot.mailCount}</dd>
          </div>
          <div className="rounded border border-[var(--mailxp-walnut)]/40 bg-white/60 p-2">
            <dt className="text-xs uppercase opacity-70">Jobs done</dt>
            <dd className="text-lg font-bold">
              {completed}/{questCount || "—"}
            </dd>
          </div>
          <div className="rounded border border-[var(--mailxp-walnut)]/40 bg-white/60 p-2">
            <dt className="text-xs uppercase opacity-70">Level</dt>
            <dd className="text-lg font-bold">{snapshot.level}</dd>
          </div>
          <div className="rounded border border-[var(--mailxp-walnut)]/40 bg-white/60 p-2">
            <dt className="text-xs uppercase opacity-70">Total XP</dt>
            <dd className="text-lg font-bold">{snapshot.xp}</dd>
          </div>
        </dl>

        <ul className="mt-4 flex flex-col gap-1 text-sm">
          {snapshot.quests.length === 0 ? (
            <li className="opacity-70">
              Reward history appears once the game has booted — finish jobs to earn.
            </li>
          ) : (
            snapshot.quests.map((quest) => (
              <li key={quest.id} className="flex items-baseline gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-bold text-white ${
                    quest.status === "completed"
                      ? "bg-[var(--mailxp-teal)]"
                      : quest.status === "active"
                        ? "bg-[#5b4232]"
                        : "bg-gray-400"
                  }`}
                >
                  {quest.status === "completed" ? "done" : quest.status === "active" ? "active" : "locked"}
                </span>
                <span>{quest.title}</span>
              </li>
            ))
          )}
        </ul>
      </section>

      {/* --------------------------------------------- wallet (demo disclosure) */}
      <section
        aria-label="Wallet connection demo status"
        className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-[var(--mailxp-teal)]">
              Crypto wallet & NFTs — future integration
            </h2>
            <p className="mt-1 text-xs opacity-70">
              Labeled demo-only: nothing here touches a real wallet or chain.
            </p>
          </div>
          <button
            type="button"
            aria-expanded={walletOpen}
            aria-controls="wallet-demo-details"
            onClick={toggleWallet}
            className="rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/60"
          >
            {walletOpen ? "Hide details" : "Connect a wallet (demo only)"}
          </button>
        </div>

        <div id="wallet-demo-details" hidden={!walletOpen} className="mt-3 rounded border border-[var(--mailxp-walnut)]/40 bg-white/60 p-3 text-sm">
          <p>
            <strong>Not implemented on purpose.</strong> Wallet connection, on-chain
            balances, NFT claims and real email sending are deferred to a future backend
            phase. Pressing this button did not create an address, sign anything or
            produce a transaction — there is no fake transaction hash anywhere in this
            app.
          </p>
          <p className="mt-2 opacity-70">
            When a backend arrives, this panel will show the connected address and the
            real on-chain balance next to the local demo balance above.
          </p>
        </div>
      </section>
    </div>
  );
}
