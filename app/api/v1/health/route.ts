/**
 * GET /api/v1/health — the only API route of Phase B3.
 *
 * Contract (docs/BACKEND_API_CONTRACT.md §6, binding):
 *   200 { "status": "ok", "db": "ok", "version": "<app version>" }
 *   503 { "error": { "code": "SERVICE_UNAVAILABLE", …envelope } } when the
 *        database probe fails or times out (2 s bound, user decision B3).
 *
 * Public by design (no auth exists yet) and minimal: no environment dumps, no
 * host/database names, no SQL, no stack traces, no driver messages in any
 * response. Every handled response carries X-Request-Id (safe inbound value
 * or a fresh UUID — see lib/server/logger.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { logger, resolveRequestId } from "@/lib/server/logger";
import { getDb } from "@/lib/server/prisma";

export const dynamic = "force-dynamic"; // always evaluated at runtime — never prerendered, never probes the DB at build

const PROBE_TIMEOUT_MS = 2_000;

let cachedVersion: string | null = null;

/** Safe, documented version source: the "version" field of package.json (user decision B3). */
function readAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
    cachedVersion = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

class ProbeTimeoutError extends Error {
  constructor() {
    super("database probe timed out");
    this.name = "ProbeTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Coarse, safe failure category for logs — never the raw error message. */
function errorCategory(error: unknown): string {
  if (error instanceof ProbeTimeoutError) return "timeout";
  if (error instanceof Error && error.message.startsWith("SERVER_ENV_")) return "config";
  return "db";
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const headers = { "X-Request-Id": requestId };
  try {
    await withTimeout(getDb().$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS);
    logger.info("health.ok", { requestId });
    return NextResponse.json({ status: "ok", db: "ok", version: readAppVersion() }, { headers });
  } catch (error) {
    // Log only the category (+ requestId); raw driver errors can embed hosts,
    // usernames or SQL and must never reach logs or responses unfiltered.
    logger.warn("health.unavailable", { requestId, category: errorCategory(error) });
    return NextResponse.json(
      { error: { code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable.", requestId, details: [] } },
      { status: 503, headers },
    );
  }
}
