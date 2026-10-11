/**
 * Phase B7 — instrumentation hook + worker runtime singleton tests.
 *
 * Covers phase_b7.md §11: "Worker disabled must not prevent app build /
 * static rendering" (register() is a provable no-op during the production
 * build phase, on Edge, and under WORKER_ENABLED=false), "dev hot reload
 * does not create unbounded polling loops" (globalThis singleton + idempotent
 * start), and the guard ORDER in instrumentation.ts (static source check —
 * the loop is only reachable behind all three guards, via dynamic import).
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";

import { register } from "./instrumentation";
import { currentDevWorker, startDevWorker, stopDevWorker } from "./lib/server/workerRuntime";
import type { WorkerDb, WorkerOptions } from "./lib/server/worker";

const ENV_KEYS = ["NEXT_RUNTIME", "NEXT_PHASE", "WORKER_ENABLED"] as const;
let savedEnv: Record<string, string | undefined>;

let fake: FakeDb;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  fake = createFakeDb();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await stopDevWorker(); // never leave a loop behind
  vi.restoreAllMocks();
});

describe("register() guards — the worker can be disabled without side effects", () => {
  it("Edge runtime: returns without starting anything", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(currentDevWorker()).toBeUndefined();
  });

  it("build phase: static rendering never starts the loop (worker absent => build fine)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-build";
    await register();
    expect(currentDevWorker()).toBeUndefined();
  });

  it("WORKER_ENABLED=false: explicit kill-switch, no worker", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.WORKER_ENABLED = "false";
    await register();
    expect(currentDevWorker()).toBeUndefined();
  });

  it("undefined NEXT_RUNTIME (never the nodejs case): conservative no-op", async () => {
    await register();
    expect(currentDevWorker()).toBeUndefined();
  });
});

describe("workerRuntime singleton — no stacked loops across hot reloads", () => {
  it("startDevWorker returns the SAME handle when called twice", async () => {
    const overrides: WorkerOptions = {
      db: fake.client as unknown as WorkerDb,
      owner: "singleton-test",
      pollIntervalMs: 600_000, // no recurring ticks during the test
    };
    const first = startDevWorker(overrides);
    const second = startDevWorker(overrides);
    expect(second).toBe(first); // one loop per process, whatever re-imports
    expect(currentDevWorker()).toBe(first);
    expect(first.isStarted()).toBe(true);

    // A second start() on the same handle is also a no-op (defense in depth).
    first.start();
    expect(first.isStarted()).toBe(true);

    await stopDevWorker();
    expect(currentDevWorker()).toBeUndefined();
    expect(first.isStarted()).toBe(false);
  });

  it("stopDevWorker is idempotent and safe when nothing is running", async () => {
    await expect(stopDevWorker()).resolves.toBeUndefined();
    await expect(stopDevWorker()).resolves.toBeUndefined();
    expect(currentDevWorker()).toBeUndefined();
  });
});

describe("instrumentation.ts source — guard order and lazy wiring (static)", () => {
  const source = readFileSync(`${process.cwd()}/instrumentation.ts`, "utf8");

  it("all three guards precede the (dynamic) worker start", () => {
    const runtime = source.indexOf('NEXT_RUNTIME !== "nodejs"');
    const build = source.indexOf('NEXT_PHASE === "phase-production-build"');
    const killSwitch = source.indexOf('WORKER_ENABLED === "false"');
    const start = source.indexOf("startDevWorker()");

    expect(runtime).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(runtime);
    expect(killSwitch).toBeGreaterThan(build);
    expect(start).toBeGreaterThan(killSwitch);
  });

  it("workerRuntime is imported dynamically inside register (no import-time side effects)", () => {
    expect(source).toMatch(/await import\(["']\.\/lib\/server\/workerRuntime["']\)/);
    expect(source).not.toMatch(/^import .*workerRuntime/m); // never a static import
  });

  it("register() contains no route/request hooks and no top-level loop", () => {
    expect(source).not.toMatch(/export (async )?function onRequestError/);
    // Count in code only — the guard list in the file's doc header mentions
    // the call in prose as well.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // The only start call lives inside register()'s async body (guards above).
    expect(code.match(/startDevWorker\(\)/g)).toHaveLength(1);
  });
});
