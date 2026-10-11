import PhaserCanvas from "@/components/PhaserCanvas";

/**
 * Phase 3 asset preview route.
 *
 * Mounts the Phaser canvas in preview mode: Boot -> Preload -> AssetPreview,
 * bypassing the Title scene entirely (see game/createGame.ts). This route is
 * verification tooling and is intentionally separate from the game flow.
 */
export default function AssetPreviewPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-3xl font-bold text-[var(--mailxp-teal)]">MailXP Asset Preview</h1>
        <p className="text-sm opacity-70">
          Phase 3 asset pipeline: every extracted frame from the original PNGs,
          loaded with named atlas frames and nearest-neighbor filtering.
        </p>
      </div>

      <PhaserCanvas preview />

      <p className="max-w-xl text-xs opacity-70">
        Preview scene (Boot → Preload → AssetPreview), separate from the game
        flow. Scroll with arrow keys, WASD, mouse drag, or the wheel. The canvas
        is labeled &quot;MailXP asset preview&quot; for assistive technology.
      </p>
    </main>
  );
}
