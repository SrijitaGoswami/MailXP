import AppShell from "@/components/AppShell";

/**
 * Single-page frontend (Phase 7): a full-viewport game shell. AppShell owns
 * the title overlay, compact HUD, in-game menu panel and the Phaser canvas,
 * which is mounted exactly once and never unmounts — navigating menus can
 * never reset the game.
 *
 * Server component boundary: AppShell is the client island; everything below
 * it runs in the browser.
 */
export default function Home() {
  return (
    <main>
      <AppShell />
    </main>
  );
}
