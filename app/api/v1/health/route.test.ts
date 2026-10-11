/**
 * Phase B3 — health route tests (MOCKED database; a separate live check is
 * recorded in docs/B3_REPORT.md §7). Asserts the B1 contract exactly and that
 * no internal diagnostic ever reaches a response body.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/server/prisma";
import { GET } from "./route";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

const getDbMock = vi.mocked(getDb);

function dbWith(queryRaw: unknown) {
  return { $queryRaw: queryRaw } as unknown as ReturnType<typeof getDbMock>;
}

const PKG_VERSION = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function healthRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/health", { headers });
}

beforeEach(() => {
  getDbMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/v1/health (mocked DB)", () => {
  it("returns the B1 contract on success, with X-Request-Id echoing a safe inbound id", async () => {
    getDbMock.mockReturnValue(dbWith(vi.fn().mockResolvedValue([{ "?column?": 1 }])));
    const response = await GET(healthRequest({ "x-request-id": "health-check-01" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBe("health-check-01");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok", db: "ok", version: PKG_VERSION });
  });

  it("generates a fresh request id when the inbound one is unsafe", async () => {
    getDbMock.mockReturnValue(dbWith(vi.fn().mockResolvedValue([])));
    const response = await GET(healthRequest({ "x-request-id": "bad id!" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toMatch(UUID);
  });

  it("returns the B1 error envelope on database failure — with no internals leaked", async () => {
    getDbMock.mockReturnValue(
      dbWith(
        vi.fn().mockRejectedValue(
          new Error('password authentication failed for user "postgres" at host "localhost"'),
        ),
      ),
    );
    const response = await GET(healthRequest({ "x-request-id": "req-99999999" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Request-Id")).toBe("req-99999999");

    const raw = await response.text();
    // Nothing internal may appear anywhere in the body:
    for (const forbidden of ["SELECT", "password", "postgres", "localhost", "authentication", "stack", "    at "]) {
      expect(raw).not.toContain(forbidden);
    }
    const body = JSON.parse(raw) as { error: { code: string; message: string; requestId: string; details: unknown[] } };
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error.requestId).toBe("req-99999999");
    expect(body.error.details).toEqual([]);
  });

  it("returns the same safe envelope when configuration is missing (lazy validation path)", async () => {
    getDbMock.mockImplementation(() => {
      throw new Error("SERVER_ENV_MISSING: required variable DATABASE_URL is not set (see .env.example).");
    });
    const response = await GET(healthRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Request-Id")).toMatch(UUID);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("bounds the probe: a hanging database times out into the safe 503", async () => {
    vi.useFakeTimers();
    getDbMock.mockReturnValue(dbWith(new Promise(() => {}))); // never resolves
    const pending = GET(healthRequest({ "x-request-id": "timeout-12345" }));
    await vi.advanceTimersByTimeAsync(2_100);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Request-Id")).toBe("timeout-12345");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("sets X-Request-Id on every handled response (success and both failures)", async () => {
    // success
    getDbMock.mockReturnValue(dbWith(vi.fn().mockResolvedValue([])));
    expect((await GET(healthRequest())).headers.get("X-Request-Id")).toMatch(UUID);
    // db failure
    getDbMock.mockReturnValue(dbWith(vi.fn().mockRejectedValue(new Error("boom"))));
    expect((await GET(healthRequest())).headers.get("X-Request-Id")).toMatch(UUID);
    // sync throw (config)
    getDbMock.mockImplementation(() => {
      throw new Error("SERVER_ENV_INVALID: nope");
    });
    expect((await GET(healthRequest())).headers.get("X-Request-Id")).toMatch(UUID);
  });
});
