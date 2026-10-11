"use client";

import type { GameSnapshot } from "../game/bridge";

/**
 * Phase 7 — compact in-game HUD overlay.
 *
 * Only at-a-glance stats (level, XP, DraftCoin) plus the task shortcut sit on
 * top of the game, top-left; the Menu button (rendered by AppShell) sits
 * top-right. The group is `pointer-events-none` so taps between the chips
 * still reach the canvas (decor placement); only the interactive children
 * re-enable pointer events. The jobs list itself is NOT duplicated here — the
 * Tasks shortcut opens the same Tasks panel that holds it.
 */
function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5 rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)]/95 px-2.5 py-1 text-xs shadow-md">
      <span className="font-bold uppercase tracking-wide text-[var(--mailxp-teal)]">{label}</span>
      <span className="font-bold text-[var(--mailxp-walnut)]">{value}</span>
    </span>
  );
}

export default function GameHud({
  snapshot,
  onOpenTasks,
}: {
  snapshot: GameSnapshot;
  onOpenTasks: () => void;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-3"
      role="group"
      aria-label="Game status"
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
        <StatChip label="Lv" value={String(snapshot.level)} />
        <StatChip label="XP" value={`${snapshot.xpInLevel}/${snapshot.xpPerLevel}`} />
        <StatChip label="DraftCoin" value={String(snapshot.draftCoin)} />
        <button
          type="button"
          onClick={onOpenTasks}
          className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-teal)] px-3 py-1 text-xs font-bold text-white shadow-md transition hover:opacity-90"
        >
          Tasks
        </button>
      </div>
    </div>
  );
}
