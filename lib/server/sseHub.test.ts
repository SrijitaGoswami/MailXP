/**
 * Phase B5 — unit tests for the process-local SSE hub (subscription cap,
 * fan-out, cleanup, wire format). The route-level behaviour (auth, origin,
 * headers, timers) is covered in app/api/v1/events/events.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSseEvent,
  publishSse,
  resetSseHub,
  SSE_MAX_STREAMS_PER_PLAYER,
  SSE_RETRY_DIRECTIVE,
  SSE_RETRY_MS,
  subscribeSse,
  sseSubscriberCount,
} from "@/lib/server/sseHub";

afterEach(() => {
  resetSseHub();
  vi.useRealTimers();
});

describe("wire format", () => {
  it("formats named events with JSON data and a trailing blank line", () => {
    expect(formatSseEvent("profile.updated", { version: 3 })).toBe(
      'event: profile.updated\ndata: {"version":3}\n\n',
    );
    expect(formatSseEvent("ping", {})).toBe("event: ping\ndata: {}\n\n");
  });

  it("carries the connect retry directive", () => {
    expect(SSE_RETRY_DIRECTIVE).toBe(`retry: ${SSE_RETRY_MS}\n\n`);
    expect(SSE_RETRY_MS).toBe(5000); // contract §5
  });
});

describe("subscribe / publish / cleanup", () => {
  it("subscribes and delivers only to that player", () => {
    const a: string[] = [];
    const b: string[] = [];
    expect(subscribeSse("player-a", (chunk) => a.push(chunk)).ok).toBe(true);
    expect(subscribeSse("player-b", (chunk) => b.push(chunk)).ok).toBe(true);

    expect(publishSse("player-a", "profile.updated", { version: 2 })).toBe(1);
    expect(a).toEqual(['event: profile.updated\ndata: {"version":2}\n\n']);
    expect(b).toEqual([]);
    expect(sseSubscriberCount("player-a")).toBe(1);
    expect(sseSubscriberCount("player-b")).toBe(1);
  });

  it("enforces the 3-stream cap per player and re-opens after unsubscribe", () => {
    const subs = Array.from({ length: SSE_MAX_STREAMS_PER_PLAYER }, () =>
      subscribeSse("player-a", () => {}),
    );
    expect(subs.every((s) => s.ok)).toBe(true);

    const overflow = subscribeSse("player-a", () => {});
    expect(overflow).toEqual({ ok: false, reason: "CAP" });
    expect(sseSubscriberCount("player-a")).toBe(SSE_MAX_STREAMS_PER_PLAYER);

    (subs[0] as { unsubscribe: () => void }).unsubscribe();
    expect(sseSubscriberCount("player-a")).toBe(SSE_MAX_STREAMS_PER_PLAYER - 1);
    expect(subscribeSse("player-a", () => {}).ok).toBe(true);
  });

  it("unsubscribe is idempotent and removes empty player sets", () => {
    const sub = subscribeSse("player-a", () => {});
    expect(sub.ok).toBe(true);
    const unsubscribe = (sub as { unsubscribe: () => void }).unsubscribe;
    unsubscribe();
    unsubscribe();
    expect(sseSubscriberCount("player-a")).toBe(0);
    expect(publishSse("player-a", "ping", {})).toBe(0);
  });

  it("publishing to a player with no streams is a safe no-op", () => {
    expect(publishSse("nobody", "profile.updated", { version: 1 })).toBe(0);
  });

  it("a throwing sink is dropped without affecting other streams", () => {
    const good: string[] = [];
    subscribeSse("player-a", () => {
      throw new Error("controller closed");
    });
    subscribeSse("player-a", (chunk) => good.push(chunk));

    expect(publishSse("player-a", "ping", {})).toBe(1);
    expect(good).toHaveLength(1);
    expect(sseSubscriberCount("player-a")).toBe(1); // broken sink removed
  });

  it("delivers the SAME serialized chunk to every stream of a player", () => {
    const first: string[] = [];
    const second: string[] = [];
    subscribeSse("player-a", (chunk) => first.push(chunk));
    subscribeSse("player-a", (chunk) => second.push(chunk));
    expect(publishSse("player-a", "profile.updated", { version: 5 })).toBe(2);
    expect(first[0]).toBe(second[0]);
  });

  it("resetSseHub clears every registration (test isolation)", () => {
    subscribeSse("player-a", () => {});
    subscribeSse("player-b", () => {});
    resetSseHub();
    expect(sseSubscriberCount("player-a")).toBe(0);
    expect(sseSubscriberCount("player-b")).toBe(0);
  });
});
