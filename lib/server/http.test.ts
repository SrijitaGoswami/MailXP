/** Phase B4 — HTTP envelope / origin check / body parsing tests. */

import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  CODES,
  csrfRejected,
  errorCategory,
  errorResponse,
  handle,
  isUniqueViolation,
  originConflicts,
  originMismatch,
  readJsonObject,
  validationError,
} from "./http";

const ORIGIN = "http://localhost:3000";
const URL = "http://localhost:3000/api/v1/me";

function mutation(headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "DELETE", headers });
}

describe("Origin check (B1 CSRF contract)", () => {
  it("accepts same-origin", () => {
    expect(originMismatch(mutation({ origin: ORIGIN }))).toBe(false);
  });

  it("rejects cross-origin (different host)", () => {
    expect(originMismatch(mutation({ origin: "https://evil.example" }))).toBe(true);
    expect(originMismatch(mutation({ origin: "http://localhost:3001" }))).toBe(true);
  });

  it("rejects a missing Origin header (browsers always send it on mutations)", () => {
    expect(originMismatch(mutation())).toBe(true);
  });

  it("rejects Origin: null and garbage", () => {
    expect(originMismatch(mutation({ origin: "null" }))).toBe(true);
    expect(originMismatch(mutation({ origin: ":::" }))).toBe(true);
  });

  it("tolerates protocol differences on the same host (proxy termination)", () => {
    // http app behind an https load balancer must still pass (host equality).
    expect(originMismatch(mutation({ origin: "https://localhost:3000" }))).toBe(false);
  });

  it("csrfRejected produces the 403 envelope with the stable code", async () => {
    const response = csrfRejected("req-abcdef12");
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe(CODES.CSRF_ORIGIN_REJECTED);
    expect(body.error.requestId).toBe("req-abcdef12");
    expect(response.headers.get("X-Request-Id")).toBe("req-abcdef12");
  });
});

describe("Relaxed stream Origin check (B5 events.stream)", () => {
  function streamGet(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost:3000/api/v1/events", { headers });
  }

  it("ALLOWS a missing Origin (browsers omit it on same-origin EventSource GETs — verified live in B5)", () => {
    expect(originConflicts(streamGet())).toBe(false);
  });

  it("still rejects a PRESENT cross-site Origin", () => {
    expect(originConflicts(streamGet({ origin: "https://evil.example" }))).toBe(true);
    expect(originConflicts(streamGet({ origin: "http://localhost:3001" }))).toBe(true);
  });

  it("still rejects Origin: null and garbage when present", () => {
    expect(originConflicts(streamGet({ origin: "null" }))).toBe(true);
    expect(originConflicts(streamGet({ origin: ":::" }))).toBe(true);
  });

  it("accepts a present same-origin Origin", () => {
    expect(originConflicts(streamGet({ origin: ORIGIN }))).toBe(false);
  });

  it("does NOT relax the mutation rule (originMismatch still rejects absence)", () => {
    expect(originMismatch(mutation())).toBe(true);
  });
});

describe("error envelope", () => {
  it("matches the B1 shape exactly", async () => {
    const response = errorResponse(401, CODES.INVALID_CREDENTIALS, "Invalid email or password.", "req-xyz12345");
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toEqual({
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password.",
      requestId: "req-xyz12345",
    });
  });

  it("validation details carry field names/messages only", async () => {
    const response = validationError("req-abc12345", [{ field: "password", message: "Password is too common." }]);
    const body = (await response.json()) as { error: { details?: unknown[] } };
    expect(body.error.details).toEqual([{ field: "password", message: "Password is too common." }]);
  });

  it("omits details when there are none (B1: optional)", async () => {
    const response = errorResponse(404, CODES.NOT_FOUND, "Not found.", "req-abc12345");
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect("details" in body.error).toBe(false);
  });
});

describe("readJsonObject", () => {
  it("accepts an object body", async () => {
    const request = new Request(URL, { method: "POST", body: JSON.stringify({ email: "a@b.co" }) });
    const result = await readJsonObject(request, "req-abc12345");
    expect(result.ok).toBe(true);
  });

  it("400s on malformed JSON, arrays, and null", async () => {
    for (const raw of ["{not json", "[1,2]", "null", '"str"', "33"]) {
      const request = new Request(URL, { method: "POST", body: raw });
      const result = await readJsonObject(request, "req-abc12345");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(400);
    }
  });
});

describe("handle() route wrapper", () => {
  it("stamps X-Request-Id on success, echoing a safe inbound id", async () => {
    const request = new Request(URL, { method: "GET", headers: { "x-request-id": "req-id-abcdef12" } });
    const response = await handle(request, "test.route", async (requestId) =>
      NextResponse.json({ ok: true, requestId }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBe("req-id-abcdef12");
  });

  it("turns an unhandled throw into the sanitized 500 envelope (code+requestId only) and logs category, never the message", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const request = new Request(URL, { method: "POST", body: "{}" });
      const response = await handle(request, "test.route", async () => {
        throw new Error("db exploded: password=hunter2-secret token=abc");
      });
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe(CODES.INTERNAL_ERROR);
      expect(body.error.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      expect(response.headers.get("X-Request-Id")).toBe(body.error.requestId);

      const rendered = lines.join("\n");
      expect(rendered).toContain('"route.unhandled"');
      expect(rendered).toContain('"category":"unexpected"');
      // Neither the raw error message nor anything resembling it reaches logs...
      expect(rendered).not.toContain("hunter2-secret");
      expect(rendered).not.toContain("db exploded");
      // ...and the response never carries it either.
      expect(JSON.stringify(body)).not.toContain("hunter2");
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies a DB-coded throw as category=db in the single log line", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const request = new Request(URL, { method: "GET" });
      const response = await handle(request, "test.route", async () => {
        throw Object.assign(new Error("relation does not exist"), { code: "P2025" });
      });
      expect(response.status).toBe(500);
      expect(lines.join("\n")).toContain('"category":"db"');
      expect(lines.join("\n")).not.toContain("relation does not exist");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("diagnostics stay safe", () => {
  it("errorCategory never depends on message content", () => {
    expect(errorCategory(new Error("SERVER_ENV_MISSING: nope"))).toBe("config");
    expect(errorCategory({ code: "P2002" })).toBe("db");
    expect(errorCategory(new Error("password auth failed at localhost"))).toBe("unexpected");
    expect(errorCategory("string")).toBe("unexpected");
  });

  it("isUniqueViolation duck-types the Prisma code", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
