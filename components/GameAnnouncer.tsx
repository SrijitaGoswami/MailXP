"use client";

import { useEffect, useState } from "react";

import { getSnapshot, subscribeState, type GameSnapshot } from "../game/bridge";
import { QUEST } from "../game/data/questConfig";

/**
 * Phase 7 — screen-reader announcer (the accessibility half of the removed
 * GameStatusPanel, kept but visually hidden).
 *
 * The visual instruction panel is gone (the spec folded its content into the
 * in-game UI), but its announcement duty stays: objective, status and balance
 * changes still reach assistive technology through this `aria-live="polite"`
 * region. Nothing is rendered on screen — `sr-only`.
 *
 * Announcements only become active once Play has been pressed, so the office
 * booting underneath the title overlay stays silent.
 */
export default function GameAnnouncer({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<GameSnapshot>(getSnapshot);

  useEffect(() => subscribeState(setSnapshot), []);

  // Keep the live region mounted at all times (remounting a live region can
  // drop announcements); just blank its content until the game starts.
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {active ? (
        <>
          <p>{snapshot.objective}</p>
          {snapshot.status ? <p>{snapshot.status}</p> : null}
          <p>
            {QUEST.currency}: {snapshot.draftCoin}
            {snapshot.carrying ? " — carrying the sample mail" : ""}
          </p>
        </>
      ) : null}
    </div>
  );
}
