/**
 * Phase B9 — Gmail inbox route tests (MOCKED storage: fakeDb; no network).
 *
 * Covers spec §9/§10 for the player-scoped inbox routes: session gate, cross-
 * USER isolation (another player's mailbox/messages are a safe 404, never
 * 403), the no-connection state, cursor-paginated list, safe message detail
 * (plain text, metadata-only attachments), sync-start coalescing (one job per
 * connection via the dedupeKey), reconnect-required refusal, and the RETENTION
 * policy — disconnect/release wipe the mailbox's synced messages + sync state
 * (user decision 2026-10-11). Route handlers never call fetch (all network is
 * in lib/server/gmailApi.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashSessionToken } from "@/lib/server/session";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { GET as syncStatusGET } from "../gmail/sync-status/route";
import { POST as syncStartPOST } from "../gmail/sync/route";
import { GET as messagesGET, PAGE_SIZE } from "../gmail/messages/route";
import { GET as messageDetailGET } from "../gmail/messages/[messageId]/route";
import { DELETE as accountDELETE } from "../integrations/google/accounts/[accountId]/route";
import { POST as releasePOST } from "../integrations/google/accounts/[accountId]/release/route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;

let fake: FakeDb;
const getDbMock = vi.mocked(getDb);
let ipSeq = 0;

beforeEach(() => {
  fake = createFakeDb();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(fake.client);
  ipSeq += 1;
});

function nextIp(): string {
  ipSeq += 1;
  return `10.9.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

function originHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": nextIp() };
  if (cookie) headers.cookie = cookie;
  return headers;
}

/** Seed a user + session (cookie) directly. */
async function seedUser(email: string): Promise<{ userId: string; cookie: string }> {
  const user = (await fake.client.user.create({
    data: { email, passwordHash: "x", emailVerifiedAt: new Date() },
  })) as { id: string };
  const raw = `raw-${email}`;
  await fake.client.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(raw),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 1e9),
    },
  });
  return { userId: user.id, cookie: `mailxp.session=${raw}` };
}

/** Seed a connected mailbox + sync state + some messages for a user. */
async function seedMailbox(
  userId: string,
  opts: { status?: string; syncStatus?: string; historyId?: string | null } = {},
): Promise<{ connectionId: string }> {
  const connection = (await fake.client.googleConnection.create({
    data: {
      userId,
      googleSub: `sub-${Math.random().toString(36).slice(2)}`,
      email: "box@example.com",
      scopes: "openid email https://www.googleapis.com/auth/gmail.modify",
      status: (opts.status ?? "connected") as never,
    },
  })) as { id: string };
  await fake.client.gmailSyncState.create({
    data: {
      googleConnectionId: connection.id,
      status: (opts.syncStatus ?? "synced") as never,
      historyId: opts.historyId ?? "h1",
    },
  });
  return { connectionId: connection.id };
}

async function seedMessage(
  connectionId: string,
  gmailMessageId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return (await fake.client.gmailMessage.create({
    data: {
      googleConnectionId: connectionId,
      gmailMessageId,
      internalDate: new Date("2026-10-10T12:00:00Z"),
      sender: `${gmailMessageId}@example.com`,
      subject: `Subj ${gmailMessageId}`,
      snippet: "snip",
      bodyText: `Body of ${gmailMessageId}`,
      isUnread: true,
      labels: ["UNREAD"],
      attachments: [],
      ...overrides,
    },
  })) as { id: string };
}

// --------------------------------------------------------------- sync-status ---

describe("GET /api/v1/gmail/sync-status", () => {
  it("requires a session (401 for a dead cookie)", async () => {
    const response = await syncStatusGET(new Request(`${BASE}/gmail/sync-status`, { headers: originHeaders("mailxp.session=dead") }));
    expect(response.status).toBe(401);
  });

  it("reports connected:false with zero counts when no mailbox is linked", async () => {
    const user = await seedUser("none@example.com");
    const response = await syncStatusGET(new Request(`${BASE}/gmail/sync-status`, { headers: originHeaders(user.cookie) }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connected: boolean; messageCount: number; email: string | null };
    expect(body.connected).toBe(false);
    expect(body.messageCount).toBe(0);
    expect(body.email).toBeNull();
  });

  it("reports the connected mailbox's status + counts (player-scoped)", async () => {
    const user = await seedUser("withbox@example.com");
    const { connectionId } = await seedMailbox(user.userId, { syncStatus: "synced" });
    await seedMessage(connectionId, "m1");
    await seedMessage(connectionId, "m2", { isUnread: false });

    const response = await syncStatusGET(new Request(`${BASE}/gmail/sync-status`, { headers: originHeaders(user.cookie) }));
    const body = (await response.json()) as {
      connected: boolean;
      status: string;
      messageCount: number;
      unreadCount: number;
      reconnectRequired: boolean;
    };
    expect(body.connected).toBe(true);
    expect(body.status).toBe("synced");
    expect(body.messageCount).toBe(2);
    expect(body.unreadCount).toBe(1);
    expect(body.reconnectRequired).toBe(false);
  });

  it("surfaces reconnect_required honestly", async () => {
    const user = await seedUser("recon@example.com");
    await seedMailbox(user.userId, { syncStatus: "reconnect_required" });
    const response = await syncStatusGET(new Request(`${BASE}/gmail/sync-status`, { headers: originHeaders(user.cookie) }));
    const body = (await response.json()) as { status: string; reconnectRequired: boolean };
    expect(body.status).toBe("reconnect_required");
    expect(body.reconnectRequired).toBe(true);
  });
});

// --------------------------------------------------------------- messages list ---

describe("GET /api/v1/gmail/messages", () => {
  it("cross-user: another player's mailbox is never listed (empty, not 403)", async () => {
    const owner = await seedUser("owner@example.com");
    const { connectionId } = await seedMailbox(owner.userId);
    await seedMessage(connectionId, "secret");

    const intruder = await seedUser("intruder@example.com");
    const response = await messagesGET(new Request(`${BASE}/gmail/messages`, { headers: originHeaders(intruder.cookie) }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]); // scoped to the intruder's (absent) mailbox
  });

  it("lists the session user's messages newest-first with a nextCursor", async () => {
    const user = await seedUser("list@example.com");
    const { connectionId } = await seedMailbox(user.userId);
    await seedMessage(connectionId, "older", { internalDate: new Date("2026-10-09T12:00:00Z") });
    await seedMessage(connectionId, "newer", { internalDate: new Date("2026-10-11T12:00:00Z") });

    const response = await messagesGET(new Request(`${BASE}/gmail/messages`, { headers: originHeaders(user.cookie) }));
    const body = (await response.json()) as { messages: Array<{ subject: string }>; nextCursor: string | null };
    expect(body.messages.map((m) => m.subject)).toEqual(["Subj newer", "Subj older"]);
    expect(body.nextCursor).toBeNull(); // only 2 rows, under the page size
  });

  it("uses the cursor to continue after a full page, including equal-date messages", async () => {
    const user = await seedUser("paginated@example.com");
    const { connectionId } = await seedMailbox(user.userId);
    const internalDate = new Date("2026-10-11T12:00:00Z");
    const seeded = await Promise.all(
      Array.from({ length: PAGE_SIZE + 2 }, (_, index) =>
        seedMessage(connectionId, `page-${index}`, { internalDate }),
      ),
    );

    const firstResponse = await messagesGET(
      new Request(`${BASE}/gmail/messages`, { headers: originHeaders(user.cookie) }),
    );
    const first = (await firstResponse.json()) as {
      messages: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(first.messages).toHaveLength(PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await messagesGET(
      new Request(`${BASE}/gmail/messages?cursor=${encodeURIComponent(first.nextCursor!)}`, {
        headers: originHeaders(user.cookie),
      }),
    );
    const second = (await secondResponse.json()) as {
      messages: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(second.messages).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    const returnedIds = [...first.messages, ...second.messages].map((message) => message.id);
    expect(new Set(returnedIds).size).toBe(PAGE_SIZE + 2);
    expect(returnedIds).toEqual(seeded.map((message) => message.id).sort().reverse());
  });

  it("an invalid cursor yields an empty page rather than an error", async () => {
    const user = await seedUser("badcursor@example.com");
    await seedMailbox(user.userId);
    const response = await messagesGET(
      new Request(`${BASE}/gmail/messages?cursor=%00bad`, { headers: originHeaders(user.cookie) }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });
});

// ------------------------------------------------------------- message detail ---

describe("GET /api/v1/gmail/messages/{messageId}", () => {
  it("cross-user detail is a safe 404 (never 403, never leaks existence)", async () => {
    const owner = await seedUser("own@example.com");
    const { connectionId } = await seedMailbox(owner.userId);
    const message = await seedMessage(connectionId, "priv");

    const intruder = await seedUser("spy@example.com");
    await seedMailbox(intruder.userId); // the spy has their OWN mailbox
    const response = await messageDetailGET(
      new Request(`${BASE}/gmail/messages/${message.id}`, { headers: originHeaders(intruder.cookie) }),
      { params: Promise.resolve({ messageId: message.id }) },
    );
    expect(response.status).toBe(404);
  });

  it("returns the owner's plain-text detail with metadata-only attachments", async () => {
    const user = await seedUser("read@example.com");
    const { connectionId } = await seedMailbox(user.userId);
    const message = await seedMessage(connectionId, "readable", {
      attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 10, attachmentId: "SECRET-BYTES-ID" }],
    });

    const response = await messageDetailGET(
      new Request(`${BASE}/gmail/messages/${message.id}`, { headers: originHeaders(user.cookie) }),
      { params: Promise.resolve({ messageId: message.id }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      bodyText: string;
      attachments: Array<Record<string, unknown>>;
    };
    expect(body.bodyText).toBe("Body of readable");
    // Attachment metadata only — no byte/attachment id leaks to the client.
    expect(body.attachments).toEqual([{ filename: "a.pdf", mimeType: "application/pdf", size: 10 }]);
    expect(JSON.stringify(body)).not.toContain("SECRET-BYTES-ID");
  });
});

// ----------------------------------------------------------------- sync start ---

describe("POST /api/v1/gmail/sync", () => {
  it("404 with no connected mailbox", async () => {
    const user = await seedUser("nobox@example.com");
    const response = await syncStartPOST(new Request(`${BASE}/gmail/sync`, { method: "POST", headers: originHeaders(user.cookie) }));
    expect(response.status).toBe(404);
  });

  it("enqueues a coalesced job (repeated taps collapse to one dedupeKey row)", async () => {
    const user = await seedUser("sync@example.com");
    await seedMailbox(user.userId, { syncStatus: "synced" });

    const first = await syncStartPOST(new Request(`${BASE}/gmail/sync`, { method: "POST", headers: originHeaders(user.cookie) }));
    expect(first.status).toBe(202);
    expect(((await first.json()) as { enqueued: boolean }).enqueued).toBe(true);

    const second = await syncStartPOST(new Request(`${BASE}/gmail/sync`, { method: "POST", headers: originHeaders(user.cookie) }));
    expect(second.status).toBe(202);
    expect(((await second.json()) as { enqueued: boolean }).enqueued).toBe(false); // coalesced

    // Exactly ONE job row (the unique dedupeKey collapsed the repeat).
    const jobs = fake.jobs.filter((j) => j.jobType === "gmail.sync");
    expect(jobs).toHaveLength(1);
    expect(String(jobs[0]?.dedupeKey)).toMatch(/^gmail\.sync:.+/);
  });

  it("refuses with RECONNECT_REQUIRED when the mailbox is in that state", async () => {
    const user = await seedUser("recon-sync@example.com");
    await seedMailbox(user.userId, { syncStatus: "reconnect_required" });
    const response = await syncStartPOST(new Request(`${BASE}/gmail/sync`, { method: "POST", headers: originHeaders(user.cookie) }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("RECONNECT_REQUIRED");
    expect(fake.jobs.filter((j) => j.jobType === "gmail.sync")).toHaveLength(0); // no retry storm
  });

  it("cross-site Origin is rejected before anything else", async () => {
    const user = await seedUser("csrf@example.com");
    await seedMailbox(user.userId);
    const response = await syncStartPOST(
      new Request(`${BASE}/gmail/sync`, { method: "POST", headers: { ...originHeaders(user.cookie), origin: "https://evil.example" } }),
    );
    expect(response.status).toBe(403);
    expect(fake.jobs).toHaveLength(0);
  });
});

// ------------------------------------------------------- retention on disconnect/release ---

describe("retention: disconnect/release wipe synced messages (user decision 2026-10-11)", () => {
  it("disconnect deletes the mailbox's messages + sync state", async () => {
    const user = await seedUser("disc@example.com");
    const { connectionId } = await seedMailbox(user.userId);
    await seedMessage(connectionId, "wipe-me");

    const response = await accountDELETE(
      new Request(`${BASE}/integrations/google/accounts/${connectionId}`, { method: "DELETE", headers: originHeaders(user.cookie) }),
      { params: Promise.resolve({ accountId: connectionId }) },
    );
    expect(response.status).toBe(204);
    expect(fake.gmailMessages.filter((m) => m.googleConnectionId === connectionId)).toHaveLength(0);
    expect(fake.gmailSyncStates.filter((s) => s.googleConnectionId === connectionId)).toHaveLength(0);
    expect(fake.googleConnections.filter((c) => c.id === connectionId)).toHaveLength(0);
  });

  it("release keeps the identity row reserved but deletes its messages + sync state", async () => {
    const user = await seedUser("rel@example.com");
    const { connectionId } = await seedMailbox(user.userId);
    await seedMessage(connectionId, "handoff");

    const response = await releasePOST(
      new Request(`${BASE}/integrations/google/accounts/${connectionId}/release`, { method: "POST", headers: originHeaders(user.cookie) }),
      { params: Promise.resolve({ accountId: connectionId }) },
    );
    expect(response.status).toBe(200);
    // The connection row survives (reserved for transfer)…
    const row = fake.googleConnections.find((c) => c.id === connectionId);
    expect(row?.status).toBe("released");
    // …but no personal email content does.
    expect(fake.gmailMessages.filter((m) => m.googleConnectionId === connectionId)).toHaveLength(0);
    expect(fake.gmailSyncStates.filter((s) => s.googleConnectionId === connectionId)).toHaveLength(0);
  });

  it("another player cannot disconnect/release a mailbox they do not own (404)", async () => {
    const owner = await seedUser("realowner@example.com");
    const { connectionId } = await seedMailbox(owner.userId);
    await seedMessage(connectionId, "keep");

    const intruder = await seedUser("notowner@example.com");
    const disc = await accountDELETE(
      new Request(`${BASE}/integrations/google/accounts/${connectionId}`, { method: "DELETE", headers: originHeaders(intruder.cookie) }),
      { params: Promise.resolve({ accountId: connectionId }) },
    );
    expect(disc.status).toBe(404);
    const rel = await releasePOST(
      new Request(`${BASE}/integrations/google/accounts/${connectionId}/release`, { method: "POST", headers: originHeaders(intruder.cookie) }),
      { params: Promise.resolve({ accountId: connectionId }) },
    );
    expect(rel.status).toBe(404);
    // The owner's mailbox is untouched.
    expect(fake.gmailMessages.filter((m) => m.googleConnectionId === connectionId)).toHaveLength(1);
  });
});

// ------------------------------------------------------------- no network in routes ---

describe("route handlers never call fetch (all network lives in the audited lib)", () => {
  it("the Gmail inbox routes contain no direct fetch calls", async () => {
    const { readFileSync } = await import("node:fs");
    const files = [
      "app/api/v1/gmail/sync-status/route.ts",
      "app/api/v1/gmail/sync/route.ts",
      "app/api/v1/gmail/messages/route.ts",
      "app/api/v1/gmail/messages/[messageId]/route.ts",
    ];
    for (const file of files) {
      const code = readFileSync(`${process.cwd()}/${file}`, "utf8");
      expect(/\bfetch\s*\(/.test(code), `${file} must not call fetch directly`).toBe(false);
    }
  });
});
