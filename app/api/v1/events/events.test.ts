/**
 * Phase B5 — `events.stream` (GET /api/v1/events) route tests (MOCKED
 * storage; sessions constructed directly).
 *
 * Covers phase_b5 §9/§11: origin gate before session work, 401 envelopes,
 * `retry: 5000` on connect, named-event wire format, ~25 s heartbeat, the
 * documented max-age close, the §1.8 3-streams-per-player cap (429), cleanup
 * on cancel (no leaked subscribers), player-scoped delivery, and X-Request-Id
 * correlation. Timers are faked per test; the isolation race uses real timers.
 */

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashSessionToken } from "@/lib/server/session";
import {
  publishSse,
  resetSseHub,
  SSE_MAX_STREAM_AGE_MS,
  SSE_MAX_STREAMS_PER_PLAYER,
  sseSubscriberCount,
} from "@/lib/server/sseHub";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { GET as eventsGET } from "./route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1/events`;
const DEFAULT_PREFS = {
  masterVolume: 0.8,
  uiVolume: 0.9,
  gameVolume: 0.8,
  muted: false,
  motion: "full",
  touchControls: "auto",
};

let fake: FakeDb;
const getDbMock = vi.mocked(getDb);

beforeEach(() => {
  fake = createFakeDb();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(fake.client);
  resetSseHub();
});

afterEach(() => {
  vi.useRealTimers();
  resetSseHub();
});

interface Account {
  userId: string;
  cookie: string;
}

async function makeAccount(email: string): Promise<Account> {
  const user = await fake.client.user.create({
    data: { email, passwordHash: "$2b$10$notarealhashmaterial0123456789abcdefghijklmn" },
  });
  const token = randomBytes(32).toString("base64url");
  await fake.client.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId: user.id,
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await fake.client.playerProfile.create({ data: { userId: user.id, prefs: DEFAULT_PREFS } });
  return { userId: user.id as string, cookie: `mailxp.session=${token}` };
}

function getEvents(cookie?: string, origin?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin !== undefined) headers.origin = origin;
  return eventsGET(new Request(BASE, { headers }));
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done) return "<done>";
  return new TextDecoder().decode(value);
}

describe("events.stream guards", () => {
  it("missing Origin + valid session → 200 (browsers omit it on same-origin EventSource GET — verified live in B5)", async () => {
    vi.useFakeTimers();
    const account = await makeAccount("sse-origin-none@example.test");
    const response = await getEvents(account.cookie); // no Origin header
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(sseSubscriberCount(account.userId)).toBe(1);
    await (response.body as ReadableStream<Uint8Array>).getReader().cancel();
    expect(sseSubscriberCount(account.userId)).toBe(0);
  });

  it("missing Origin without a session → 401 (cookie still gates the stream)", async () => {
    const response = await getEvents(undefined); // no cookie, no Origin
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("cross-site Origin → 403 CSRF_ORIGIN_REJECTED", async () => {
    const account = await makeAccount("sse-origin-cross@example.test");
    const response = await getEvents(account.cookie, "https://evil.example");
    expect(response.status).toBe(403);
  });

  it("no cookie → 401 UNAUTHENTICATED envelope; dead cookie → SESSION_EXPIRED", async () => {
    const none = await getEvents(undefined, ORIGIN);
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");

    const dead = await getEvents("mailxp.session=deadbeef", ORIGIN);
    expect(dead.status).toBe(401);
    expect(((await dead.json()) as { error: { code: string } }).error.code).toBe("SESSION_EXPIRED");
  });
});

describe("events.stream wire protocol", () => {
  it("200 text/event-stream with retry: 5000 first, X-Request-Id set", async () => {
    vi.useFakeTimers();
    const account = await makeAccount("sse-open@example.test");
    const response = await getEvents(account.cookie, ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-request-id")).toBeTruthy();

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await readChunk(reader);
    expect(first).toBe("retry: 5000\n\n");
    expect(sseSubscriberCount(account.userId)).toBe(1);
    await reader.cancel();
    expect(sseSubscriberCount(account.userId)).toBe(0); // cleanup on cancel
  });

  it("publishes named events with JSON data (minimal pointer payload)", async () => {
    vi.useFakeTimers();
    const account = await makeAccount("sse-event@example.test");
    const response = await getEvents(account.cookie, ORIGIN);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readChunk(reader); // retry directive

    expect(publishSse(account.userId, "profile.updated", { version: 7 })).toBe(1);
    const chunk = await readChunk(reader);
    expect(chunk).toBe('event: profile.updated\ndata: {"version":7}\n\n');

    expect(publishSse(account.userId, "economy.updated", { balance: 10, reason: "purchase", version: 8 })).toBe(1);
    const economy = await readChunk(reader);
    expect(economy).toContain("event: economy.updated");
    expect(economy).toContain('"balance":10');
    await reader.cancel();
  });

  it("heartbeat ping every ~25 s", async () => {
    vi.useFakeTimers();
    const account = await makeAccount("sse-ping@example.test");
    const response = await getEvents(account.cookie, ORIGIN);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readChunk(reader); // retry directive

    await vi.advanceTimersByTimeAsync(25_000);
    const ping = await readChunk(reader);
    expect(ping).toBe("event: ping\ndata: {}\n\n");

    await vi.advanceTimersByTimeAsync(25_000);
    const ping2 = await readChunk(reader);
    expect(ping2).toContain("event: ping");
    await reader.cancel();
  });

  it("server closes the stream at the documented max age (client reconnects)", async () => {
    vi.useFakeTimers();
    const account = await makeAccount("sse-maxage@example.test");
    const response = await getEvents(account.cookie, ORIGIN);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readChunk(reader); // retry directive

    await vi.advanceTimersByTimeAsync(SSE_MAX_STREAM_AGE_MS);
    // Heartbeats buffered before the close drain first; then the stream ends.
    expect(sseSubscriberCount(account.userId)).toBe(0);
    let sawDone = false;
    for (let i = 0; i < 200 && !sawDone; i += 1) {
      const { done } = await reader.read();
      sawDone = done;
    }
    expect(sawDone).toBe(true); // closed by the server, not left open
  });

  it("aborting the request signal tears the subscriber down", async () => {
    vi.useFakeTimers();
    const account = await makeAccount("sse-abort@example.test");
    const controller = new AbortController();
    const headers: Record<string, string> = { cookie: account.cookie, origin: ORIGIN };
    const response = await eventsGET(new Request(BASE, { headers, signal: controller.signal }));
    expect(response.status).toBe(200);
    expect(sseSubscriberCount(account.userId)).toBe(1);

    controller.abort();
    expect(sseSubscriberCount(account.userId)).toBe(0);
    await response.body?.cancel();
  });
});

describe("events.stream connection cap (§1.8)", () => {
  it(`allows ${SSE_MAX_STREAMS_PER_PLAYER} streams then answers 429 with Retry-After`, async () => {
    vi.useFakeTimers();
    const account = await makeAccount("sse-cap@example.test");
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

    for (let i = 0; i < SSE_MAX_STREAMS_PER_PLAYER; i += 1) {
      const response = await getEvents(account.cookie, ORIGIN);
      expect(response.status).toBe(200);
      readers.push((response.body as ReadableStream<Uint8Array>).getReader());
    }
    expect(sseSubscriberCount(account.userId)).toBe(SSE_MAX_STREAMS_PER_PLAYER);

    const overflow = await getEvents(account.cookie, ORIGIN);
    expect(overflow.status).toBe(429);
    expect(((await overflow.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect(overflow.headers.get("retry-after")).toBeTruthy();
    expect(sseSubscriberCount(account.userId)).toBe(SSE_MAX_STREAMS_PER_PLAYER); // unchanged

    await Promise.all(readers.map((reader) => reader.cancel()));
    expect(sseSubscriberCount(account.userId)).toBe(0);
  });

  it("the cap is per player (another player still connects)", async () => {
    vi.useFakeTimers();
    const a = await makeAccount("sse-cap-a@example.test");
    const b = await makeAccount("sse-cap-b@example.test");
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

    for (let i = 0; i < SSE_MAX_STREAMS_PER_PLAYER; i += 1) {
      const response = await getEvents(a.cookie, ORIGIN);
      readers.push((response.body as ReadableStream<Uint8Array>).getReader());
    }
    const forB = await getEvents(b.cookie, ORIGIN);
    expect(forB.status).toBe(200);
    readers.push((forB.body as ReadableStream<Uint8Array>).getReader());

    await Promise.all(readers.map((reader) => reader.cancel()));
  });
});

describe("events.stream delivery isolation", () => {
  it("an event for player A never reaches player B's stream (real timers)", async () => {
    const a = await makeAccount("sse-iso-a@example.test");
    const b = await makeAccount("sse-iso-b@example.test");

    const responseA = await getEvents(a.cookie, ORIGIN);
    const responseB = await getEvents(b.cookie, ORIGIN);
    const readerA = (responseA.body as ReadableStream<Uint8Array>).getReader();
    const readerB = (responseB.body as ReadableStream<Uint8Array>).getReader();
    await readChunk(readerA); // consume retry directives
    await readChunk(readerB);

    expect(publishSse(a.userId, "profile.updated", { version: 2 })).toBe(1);
    const receivedA = await readChunk(readerA);
    expect(receivedA).toContain("event: profile.updated");

    // B must NOT receive A's event: a race resolves only if a chunk arrives.
    const raced = await Promise.race([
      readChunk(readerB).then((chunk) => ({ got: chunk })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 60)),
    ]);
    expect(raced).toBeNull();

    await readerA.cancel();
    await readerB.cancel();
    expect(sseSubscriberCount(a.userId)).toBe(0);
    expect(sseSubscriberCount(b.userId)).toBe(0);
  });
});
