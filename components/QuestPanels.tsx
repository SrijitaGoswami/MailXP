"use client";

import { useEffect, useRef, useState } from "react";

import {
  getSnapshot,
  sendCommand,
  subscribeState,
  type GameSnapshot,
  type ReplyDraft,
} from "../game/bridge";

/**
 * Tasks menu section — React-owned, keyboard-accessible quest and reply-review
 * panels (Phase 5 feature; Phase 7 moved it into the in-game menu's Tasks
 * section, and the game pauses while it is open).
 *
 * - **Quest panel**: renders the typed quest list from
 *   `game/data/questConfig.ts` (via the bridge snapshot) with each job's
 *   status, plus the active job's inbox prompt and the Understanding
 *   Worker's classification when it exists. A native `<button>` reopens the
 *   reply review whenever a finished draft exists (the keyboard alternative to
 *   walking back to the Response Worker and pressing E).
 *
 * - **Reply review panel**: opens automatically when the Response Worker has
 *   drafted a reply (the menu opens on Tasks), and via the reopen button /
 *   in-game E. The player edits recipient, subject and message, sees the
 *   configured send cost and reward *before* confirming, and only sends
 *   through an explicit confirm button. The confirm button is disabled (with
 *   a visible reason) when the local balance cannot cover the send cost.
 *
 * Edits live in local state — the game only receives the final draft on
 * confirm, which avoids pushing keystrokes back through the bridge. Local
 * state is seeded from the snapshot once, on the frame the review opens.
 * Every subscribe effect returns the bridge's idempotent unsubscribe function,
 * so React Strict Mode's double-mount stays safe.
 */
export default function QuestPanels() {
  const [snapshot, setSnapshot] = useState<GameSnapshot>(getSnapshot);
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => subscribeState(setSnapshot), []);

  // Seed the editable copy only on the transition into "review open", so
  // unrelated bridge publishes never clobber what the player is typing.
  useEffect(() => {
    if (snapshot.reviewOpen && !wasOpenRef.current && snapshot.draft) {
      setDraft(snapshot.draft);
    }
    wasOpenRef.current = snapshot.reviewOpen;
  }, [snapshot.reviewOpen, snapshot.draft]);

  const inOffice = snapshot.screen === "office";
  const reviewOpen = snapshot.reviewOpen && draft !== null;
  const affordable = snapshot.canSend;

  return (
    <div className="flex w-full flex-col gap-4">
      {/* ---------------------------------------------------------- quest list */}
      <section
        aria-label="Quest list"
        className="rounded-lg border-2 border-[var(--mailxp-teal)] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
      >
        <h2 className="text-base font-bold text-[var(--mailxp-teal)]">
          Jobs {inOffice ? `(${snapshot.questCount} total)` : ""}
        </h2>

        {snapshot.quests.length === 0 ? (
          <p className="mt-2 text-sm opacity-70">
            The quest list appears once the game has booted.
          </p>
        ) : (
          <ol className="mt-2 flex flex-col gap-1.5">
            {snapshot.quests.map((quest, index) => {
              const isActive = inOffice && index + 1 === snapshot.questIndex;
              return (
                <li
                  key={quest.id}
                  aria-current={isActive ? "step" : undefined}
                  className={`flex items-baseline gap-2 text-sm ${
                    isActive ? "font-semibold" : ""
                  }`}
                >
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-bold text-white ${
                      quest.status === "completed"
                        ? "bg-[var(--mailxp-teal)]"
                        : quest.status === "active"
                          ? "bg-[#5b4232]"
                          : "bg-gray-400"
                    }`}
                  >
                    {index + 1}
                  </span>
                  <span className="flex-1">
                    {quest.title}
                    {isActive && snapshot.classification
                      ? ` — classified as: ${snapshot.classification}`
                      : ""}
                  </span>
                  <span className="text-xs uppercase tracking-wide opacity-70">
                    {quest.status === "completed"
                      ? "done"
                      : quest.status === "active"
                        ? "in progress"
                        : "locked"}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {inOffice && snapshot.canOpenReview ? (
          <button
            type="button"
            onClick={() => sendCommand({ type: "open-review" })}
            className="mt-3 rounded bg-[var(--mailxp-teal)] px-3 py-1.5 text-sm font-semibold text-white shadow transition hover:opacity-90"
          >
            Open reply review
          </button>
        ) : null}
      </section>

      {/* -------------------------------------------------------- reply review */}
      {inOffice && (reviewOpen || snapshot.sending) ? (
        <section
          aria-label="Reply review"
          className="rounded-lg border-2 border-[#5b4232] bg-[var(--mailxp-cream)] p-4 text-left shadow-md"
        >
          <h2 className="text-base font-bold text-[var(--mailxp-teal)]">
            Review the drafted reply
          </h2>
          <p className="mt-1 text-xs opacity-70">
            Local sample draft — nothing is sent anywhere. Edit the fields, then
            confirm explicitly.
          </p>

          {snapshot.sending ? (
            <p className="mt-3 text-sm font-semibold text-[var(--mailxp-teal)]" role="status">
              Sending — the mail-bird is carrying your reply out of the office…
            </p>
          ) : reviewOpen && draft ? (
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold">To</span>
                <input
                  type="text"
                  value={draft.recipient}
                  onChange={(e) => setDraft({ ...draft, recipient: e.target.value })}
                  className="rounded border border-[var(--mailxp-walnut)] bg-white px-2 py-1.5 font-mono text-sm"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold">Subject</span>
                <input
                  type="text"
                  value={draft.subject}
                  onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                  className="rounded border border-[var(--mailxp-walnut)] bg-white px-2 py-1.5 font-mono text-sm"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold">Reply</span>
                <textarea
                  value={draft.body}
                  rows={6}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  className="resize-y rounded border border-[var(--mailxp-walnut)] bg-white px-2 py-1.5 font-mono text-sm"
                />
              </label>

              <p className="text-sm">
                <span className="font-semibold">Send cost:</span> {snapshot.sendCost}{" "}
                DraftCoin · <span className="font-semibold">Reward:</span>{" "}
                {snapshot.sendReward} DraftCoin ·{" "}
                <span className="font-semibold">Balance:</span> {snapshot.draftCoin} DraftCoin
              </p>

              {!affordable ? (
                <p className="text-sm font-semibold text-red-700" role="status">
                  Not enough DraftCoin — you need {snapshot.sendCost}, you have{" "}
                  {snapshot.draftCoin}. Deliver more mail to earn some.
                </p>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={!affordable}
                  onClick={() => sendCommand({ type: "confirm-send", draft })}
                  className="rounded bg-[var(--mailxp-teal)] px-4 py-2 text-sm font-semibold text-white shadow transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Confirm send (−{snapshot.sendCost} DraftCoin)
                </button>
                <button
                  type="button"
                  onClick={() => sendCommand({ type: "cancel-review" })}
                  className="rounded border-2 border-[var(--mailxp-walnut)] px-4 py-2 text-sm font-semibold transition hover:bg-white/60"
                >
                  Discard
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
