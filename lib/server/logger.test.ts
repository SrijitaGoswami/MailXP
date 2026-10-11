/** Phase B3 — structured logger and request-ID policy tests. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, resolveRequestId } from "./logger";

let lines: string[];
let spies: Array<() => void>;

function capture(): void {
  lines = [];
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const push =
    (native: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      lines.push(String(args[0]));
      native(...args);
    };
  spies = [
    vi.spyOn(console, "log").mockImplementation(push(origLog)),
    vi.spyOn(console, "warn").mockImplementation(push(origWarn)),
    vi.spyOn(console, "error").mockImplementation(push(origError)),
  ] as unknown as Array<() => void>;
}

beforeEach(capture);
afterEach(() => {
  for (const spy of spies) (spy as unknown as { mockRestore: () => void }).mockRestore();
});

describe("structured logging", () => {
  it("emits one JSON line per call with ts/level/msg and caller fields", () => {
    logger.info("health.ok", { requestId: "req-12345678" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("health.ok");
    expect(parsed.requestId).toBe("req-12345678");
    expect(typeof parsed.ts).toBe("string");
  });

  it("routes levels to the right console method", () => {
    logger.info("a");
    logger.warn("b");
    logger.error("c");
    expect(lines).toHaveLength(3);
    expect((JSON.parse(lines[0] as string) as { level: string }).level).toBe("info");
    expect((JSON.parse(lines[1] as string) as { level: string }).level).toBe("warn");
    expect((JSON.parse(lines[2] as string) as { level: string }).level).toBe("error");
  });

  it("drops secret-ish field keys defensively", () => {
    logger.warn("redaction", {
      requestId: "req-12345678",
      password: "hunter2",
      token: "abc",
      authorization: "Bearer x",
      cookie: "sid=1",
      databaseUrl: "postgres://x",
      apiKey: "k",
      credentials: { user: "u" },
      category: "db", // safe keys survive
    });
    const line = lines[0] as string;
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("Bearer");
    expect(line).not.toContain("postgres://x");
    expect(line).not.toContain("apiKey");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.category).toBe("db");
    expect(parsed.requestId).toBe("req-12345678");
  });
});

describe("resolveRequestId", () => {
  it("accepts a safe inbound ID (8-64 chars of [A-Za-z0-9_-])", () => {
    expect(resolveRequestId("abcdef12")).toBe("abcdef12");
    expect(resolveRequestId("A-b_C9".repeat(3))).toBe("A-b_C9".repeat(3));
  });

  it("replaces unsafe inbound IDs with a fresh UUID", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(resolveRequestId(null)).toMatch(uuid);
    expect(resolveRequestId(undefined)).toMatch(uuid);
    expect(resolveRequestId("")).toMatch(uuid);
    expect(resolveRequestId("short")).toMatch(uuid); // 5 chars < 8
    expect(resolveRequestId("has spaces in it")).toMatch(uuid);
    expect(resolveRequestId("inject\"quoted")).toMatch(uuid);
    expect(resolveRequestId("x".repeat(65))).toMatch(uuid); // > 64
    expect(resolveRequestId("<script>alert(1)</script>")).toMatch(uuid);
  });
});
