"use client";

import { useEffect, useRef } from "react";

import type * as Phaser from "phaser";

/**
 * Client-only host that mounts the Phaser game inside a responsive container.
 *
 * - Phaser is loaded with a dynamic `import()` inside `useEffect`, so it is
 *   never evaluated during server rendering (Phaser needs `window`).
 * - The effect cleanup destroys the game (`destroy(true)` removes the canvas),
 *   and a `disposed` flag guards the async import, so React Strict Mode's
 *   double-mount cannot leave duplicate canvases behind.
 *
 * - `preview` (used by /preview) mounts the game in Phase 3 asset-preview mode
 *   inside the original boxed 16:9 stage. The normal game (Phase 7) fills its
 *   container edge-to-edge — the container is absolutely positioned to the
 *   full viewport by AppShell, and Phaser's Scale.RESIZE follows it.
 */
export default function PhaserCanvas({ preview = false }: { preview?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let game: Phaser.Game | null = null;

    void (async () => {
      const { createGame } = await import("../game/createGame");
      if (disposed) return;
      const parent = containerRef.current;
      if (!parent) return;
      game = createGame(parent, { preview });
    })();

    return () => {
      disposed = true;
      if (game) {
        game.destroy(true);
        game = null;
      }
    };
  }, [preview]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={preview ? "MailXP asset preview" : "MailXP game window"}
      className={
        preview
          ? "relative mx-auto aspect-[16/9] w-full max-w-[960px] overflow-hidden rounded-lg border-4 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] shadow-lg"
          : "absolute inset-0 overflow-hidden bg-[var(--mailxp-cream)]"
      }
    />
  );
}
