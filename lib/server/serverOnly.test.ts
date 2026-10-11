/**
 * Phase B3 — server-only boundary test.
 *
 * Static scan: no client-facing code (React components, game/, Phaser scenes,
 * root pages) may import server modules (lib/server/**), the API route tree
 * (app/api/**), or Prisma. This keeps DATABASE_URL, the connection pool and
 * database client out of browser bundles.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCANNED_DIRS = ["game", "components"];
const SCANNED_FILES = ["app/page.tsx", "app/layout.tsx"];

const SERVER_NEEDLE = /(lib\/server|app\/api|@prisma\/client|@prisma\/adapter-pg)/;

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function importsOf(source: string): string[] {
  const text = readFileSync(source, "utf8");
  const specifiers: string[] = [];
  const re = /(?:import[\s\S]*?from|import|export[\s\S]*?from)\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) specifiers.push(match[1] as string);
  return specifiers;
}

describe("server-only modules stay out of client/game code", () => {
  it("finds nothing forbidden in game/, components/ or the root pages", () => {
    const files = [
      ...SCANNED_DIRS.flatMap((dir) => collectSources(join(ROOT, dir))),
      ...SCANNED_FILES.map((file) => join(ROOT, file)),
    ];
    expect(files.length).toBeGreaterThan(10); // sanity: the scan actually ran

    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (SERVER_NEEDLE.test(specifier)) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("sanity-checks the scanner itself would catch a violation", () => {
    expect(SERVER_NEEDLE.test("@/lib/server/prisma")).toBe(true);
    expect(SERVER_NEEDLE.test("@prisma/client")).toBe(true);
    expect(SERVER_NEEDLE.test("@/lib/server/logger")).toBe(true);
    expect(SERVER_NEEDLE.test("phaser")).toBe(false);
    expect(SERVER_NEEDLE.test("game/profileStorage")).toBe(false);
  });
});
