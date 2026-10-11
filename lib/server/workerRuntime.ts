/**
 * Process-level worker lifecycle (Phase B7, phase_b7.md §6).
 *
 * Exactly ONE worker loop may exist per process:
 *   - the handle lives on globalThis, which survives Next.js dev hot module
 *     re-evaluation — re-importing this module (or re-running
 *     instrumentation register()) returns the SAME worker instead of
 *     stacking another polling loop;
 *   - createWorker().start() is itself idempotent (started flag), so even a
 *     duplicated handle cannot double-schedule;
 *   - SIGTERM/SIGINT ask for a clean stop (timer cancelled, in-flight tick
 *     drained). Durability never depends on it: an interrupted job's lease
 *     simply expires and the next claim re-runs the idempotent handler.
 *
 * Startup guards live in instrumentation.ts (NEXT_RUNTIME, build phase,
 * WORKER_ENABLED kill-switch). This module only owns the singleton.
 */

import { createWorker, type WorkerHandle, type WorkerOptions } from "./worker";

interface WorkerGlobals {
  __mailxpWorker?: WorkerHandle;
  __mailxpWorkerSignals?: boolean;
}

const globalForWorker = globalThis as unknown as WorkerGlobals;

/** Start (or return the already-running) process worker. Idempotent. */
export function startDevWorker(overrides: WorkerOptions = {}): WorkerHandle {
  const existing = globalForWorker.__mailxpWorker;
  if (existing) return existing; // hot reload / double register -> one loop

  const worker = createWorker({ owner: `next-${process.pid}`, ...overrides });
  globalForWorker.__mailxpWorker = worker;
  worker.start();

  // Register process signal handlers once per process, not once per start.
  if (!globalForWorker.__mailxpWorkerSignals) {
    globalForWorker.__mailxpWorkerSignals = true;
    const shutdown = (): void => {
      void stopDevWorker();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
  return worker;
}

/** Stop and forget the process worker (idempotent; safe when not running). */
export function stopDevWorker(): Promise<void> {
  const existing = globalForWorker.__mailxpWorker;
  if (!existing) return Promise.resolve();
  delete globalForWorker.__mailxpWorker;
  return existing.stop();
}

/** The running process worker, if any (diagnostics/tests). */
export function currentDevWorker(): WorkerHandle | undefined {
  return globalForWorker.__mailxpWorker;
}
