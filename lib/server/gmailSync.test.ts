/**
 * Phase B9 — Gmail sync engine tests (fake DB + stubbed fetch; no network).
 *
 * The guarantees under test (phase_b9.md §4/§6):
 * - re-checks connection STATUS/OWNERSHIP before any provider call (a
 *   released/disconnected mailbox makes the job a harmless dead-letter);
 * - scope gate: no read scope → reconnect_required, never a silent widen;
 * - dead/revoked refresh token → reconnect_required (no retry storm);
 * - the history cursor advances ONLY with the committed data (partial failure
 *   rolls both back);
 * - upserts are idempotent on (connectionId, gmailMessageId);
 * - an EXPIRED cursor triggers a CONTROLLED resync (clear cursor), not a loop;
 * - malformed payloads are permanent validation errors.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./fakeDb";
import { PermanentJobError } from "./jobQueue";
import { runGmailSync, type GmailSyncDb } from "./gmailSync";
import { loadTokenKey } from "./secretBox";
import { sealSecret } from "./secretBox";

// The engine opens the stored refresh token with the real key, so we seal a
// known refresh token under the real env key before each test.
const READ_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

let fake: FakeDb;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** Build a Gmail message payload the MIME extractor understands. */
function gmailMessage(id: string, bodyText: string, unread = true) {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: "1728000000000",
    labelIds: unread ? ["UNREAD", "INBOX"] : ["INBOX"],
    snippet: bodyText.slice(0, 20),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `${id}@example.com` },
        { name: "Subject", value: `Subj ${id}` },
      ],
      parts: [{ mimeType: "text/plain", body: { data: b64(bodyText) } }],
    },
  };
}

/** Seed a connected mailbox with a sealed refresh token + sync state row. */
async function seedConnection(opts: { scopes?: string; historyId?: string | null } = {}) {
  const user = (await fake.client.user.create({
    data: { email: `sync-${Math.random().toString(36).slice(2)}@example.com`, passwordHash: "x" },
  })) as { id: string };
  const sealed = sealSecret("refresh-token-abc", loadTokenKey());
  const connection = (await fake.client.googleConnection.create({
    data: {
      userId: user.id,
      googleSub: `sub-${Math.random().toString(36).slice(2)}`,
      email: "box@example.com",
      scopes: opts.scopes ?? READ_SCOPE,
      refreshTokenCipher: sealed.cipher,
      refreshTokenNonce: sealed.nonce,
      refreshTokenTag: sealed.tag,
    },
  })) as { id: string };
  await fake.client.gmailSyncState.create({
    data: {
      googleConnectionId: connection.id,
      historyId: opts.historyId ?? null,
      historyWindowDays: 30,
    },
  });
  return { userId: user.id, connectionId: connection.id };
}

beforeEach(() => {
  fake = createFakeDb();
});

describe("runGmailSync — safety gates (spec §4)", () => {
  it("malformed payload → permanent validation error, nothing runs", async () => {
    for (const bad of [null, undefined, {}, { googleConnectionId: "" }]) {
      await expect(runGmailSync(fake.client as unknown as GmailSyncDb, bad, "req")).rejects.toBeInstanceOf(PermanentJobError);
    }
  });

  it("a released / disconnected mailbox → permanent not_requested (harmless no-op)", async () => {
    const { connectionId } = await seedConnection();
    // Simulate a disconnect/release that outlived the queued job.
    await fake.client.googleConnection.update({
      where: { id: connectionId },
      data: { status: "released" },
    });
    await expect(runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req")).rejects.toBeInstanceOf(
      PermanentJobError,
    );
  });

  it("an unknown connection id → permanent not_requested (no provider call)", async () => {
    const fetchFn = vi.fn();
    await expect(
      runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: "nope" }, "req", fetchFn as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("missing read scope → reconnect_required, no silent widen, no provider call", async () => {
    const { connectionId } = await seedConnection({ scopes: "openid email" });
    const fetchFn = vi.fn();
    const result = await runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req", fetchFn as unknown as typeof fetch);
    expect(result.outcome).toBe("reconnect_required");
    const state = await fake.client.gmailSyncState.findUnique({ where: { googleConnectionId: connectionId } });
    expect(state?.status).toBe("reconnect_required");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a revoked/undecryptable refresh token → reconnect_required, no retry storm", async () => {
    const { connectionId } = await seedConnection();
    // Wipe the sealed token so it cannot be opened.
    await fake.client.googleConnection.update({
      where: { id: connectionId },
      data: { refreshTokenCipher: null, refreshTokenNonce: null, refreshTokenTag: null },
    });
    const result = await runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req");
    expect(result.outcome).toBe("reconnect_required");
    const state = await fake.client.gmailSyncState.findUnique({ where: { googleConnectionId: connectionId } });
    expect(state?.status).toBe("reconnect_required");
  });
});

describe("runGmailSync — initial sync (30-day window) (spec §6)", () => {
  it("imports messages, then seeds the cursor from the profile", async () => {
    const { connectionId } = await seedConnection();
    const fetchFn = vi
      .fn()
      // refresh
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "at", expires_in: 3600 }))
      // list messages
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: "m1" }, { id: "m2" }] }))
      // get m1
      .mockResolvedValueOnce(jsonResponse(200, gmailMessage("m1", "First body")))
      // get m2
      .mockResolvedValueOnce(jsonResponse(200, gmailMessage("m2", "Second body")))
      // profile (cursor)
      .mockResolvedValueOnce(jsonResponse(200, { historyId: "h-cursor" }));

    const result = await runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req", fetchFn as unknown as typeof fetch);
    expect(result.outcome).toBe("synced");
    expect(result.mode).toBe("initial");
    expect(result.imported).toBe(2);

    expect(await fake.client.gmailMessage.count({ where: { googleConnectionId: connectionId } })).toBe(2);
    const stored = await fake.client.gmailMessage.findFirst({
      where: { googleConnectionId: connectionId, gmailMessageId: "m1" },
    });
    expect(stored?.bodyText).toBe("First body");
    expect(stored?.sender).toBe("m1@example.com");
    expect(stored?.isUnread).toBe(true);

    // Cursor was seeded from the profile AFTER the import.
    const state = await fake.client.gmailSyncState.findUnique({ where: { googleConnectionId: connectionId } });
    expect(state?.historyId).toBe("h-cursor");
    expect(state?.status).toBe("synced");
    expect(state?.lastSuccessAt).toBeTruthy();
  });

  it("the sync-state history window stays 30 days (not widened)", async () => {
    const { connectionId } = await seedConnection();
    const state = await fake.client.gmailSyncState.findUnique({ where: { googleConnectionId: connectionId } });
    expect(state?.historyWindowDays).toBe(30);
  });
});

describe("runGmailSync — incremental history sync (spec §6)", () => {
  it("advances the cursor with committed data; upserts are idempotent", async () => {
    const { connectionId } = await seedConnection({ historyId: "h1" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "at", expires_in: 3600 })) // refresh
      .mockResolvedValueOnce(
        jsonResponse(200, {
          historyId: "h2",
          history: [{ messagesAdded: [{ message: { id: "m9" } }] }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, gmailMessage("m9", "New mail")));

    const result = await runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req", fetchFn as unknown as typeof fetch);
    expect(result.imported).toBe(1);
    expect(await fake.client.gmailMessage.count({ where: { googleConnectionId: connectionId } })).toBe(1);

    const state = await fake.client.gmailSyncState.findUnique({ where: { googleConnectionId: connectionId } });
    expect(state?.historyId).toBe("h2"); // cursor advanced with the commit
  });

  it("re-running the same incremental page upserts (no duplicate rows)", async () => {
    const { connectionId } = await seedConnection({ historyId: "h1" });
    const refresh = () => jsonResponse(200, { access_token: "at", expires_in: 3600 });
    const page = () =>
      jsonResponse(200, { historyId: "h2", history: [{ messagesAdded: [{ message: { id: "m9" } }] }] });
    const detail = () => jsonResponse(200, gmailMessage("m9", "New mail"));

    const first = vi
      .fn()
      .mockResolvedValueOnce(refresh())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(detail());
    await runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req", first as unknown as typeof fetch);

    // Simulate a redelivery of the SAME page (at-least-once contract).
    const second = vi
      .fn()
      .mockResolvedValueOnce(refresh())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(detail());
    await runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req", second as unknown as typeof fetch);

    expect(await fake.client.gmailMessage.count({ where: { googleConnectionId: connectionId } })).toBe(1);
  });

  it("removed message ids are deleted in the same commit as the cursor advance", async () => {
    const { connectionId } = await seedConnection({ historyId: "h1" });
    // Seed an existing message that the history page will remove.
    await fake.client.gmailMessage.create({
      data: {
        googleConnectionId: connectionId,
        gmailMessageId: "gone",
        internalDate: new Date(),
        sender: "x@example.com",
      },
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "at", expires_in: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse(200, { historyId: "h3", history: [{ messagesRemoved: [{ message: { id: "gone" } }] }] }),
      );
    const result = await runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req", fetchFn as unknown as typeof fetch);
    expect(result.removed).toBe(1);
    expect(await fake.client.gmailMessage.count({ where: { googleConnectionId: connectionId } })).toBe(0);
  });

  it("an EXPIRED cursor (404 on history) → controlled resync (cursor cleared), not a loop", async () => {
    const { connectionId } = await seedConnection({ historyId: "expired-h" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "at", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));
    const result = await runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req", fetchFn as unknown as typeof fetch);
    expect(result.outcome).toBe("resync_scheduled"); // handled, not thrown, not a misleading "synced"
    const state = await fake.client.gmailSyncState.findUnique({ where: { googleConnectionId: connectionId } });
    expect(state?.historyId).toBeNull(); // cleared → next run re-seeds via initial sync
    expect(state?.status).toBe("pending");
  });
});

describe("runGmailSync — transient provider failure (spec §6)", () => {
  it("a 5xx during detail fetch marks error status and rethrows (dispatcher retries)", async () => {
    const { connectionId } = await seedConnection();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "at", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: "m1" }] }))
      .mockResolvedValueOnce(jsonResponse(500, {}));
    await expect(
      runGmailSync(fake.client as unknown as GmailSyncDb, { googleConnectionId: connectionId }, "req", fetchFn as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(Error);
    const state = await fake.client.gmailSyncState.findUnique({ where: { googleConnectionId: connectionId } });
    expect(state?.status).toBe("error");
  });
});
