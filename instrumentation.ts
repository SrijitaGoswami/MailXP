/**
 * Next.js server instrumentation hook (Phase B7, phase_b7.md §6).
 *
 * `register()` runs once per Next.js server instance, before the server
 * accepts requests (Next docs: dist/docs/01-app/03-api-reference/
 * 03-file-conventions/instrumentation.md). It starts the in-process worker —
 * the ONLY production entry point for the loop (never a route, never per
 * request). Guards, in order:
 *
 *   1. NEXT_RUNTIME !== "nodejs"        -> Edge runtime never touches the DB;
 *   2. NEXT_PHASE === "phase-production-build"
 *                                        -> `next build` / static rendering
 *                                           never starts a loop, so a
 *                                           disabled or absent worker can't
 *                                           affect builds (§6);
 *   3. WORKER_ENABLED === "false"       -> explicit kill-switch;
 *   4. startDevWorker()                 -> globalThis-guarded, idempotent
 *                                           (workerRuntime.ts): dev hot
 *                                           reload can't stack loops (§6).
 *
 * The dynamic import colocates all side effects inside register() per the
 * Next instrumentation guide, so importing this module is free of side effects.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.WORKER_ENABLED === "false") return;

  const { startDevWorker } = await import("./lib/server/workerRuntime");
  startDevWorker();
}
