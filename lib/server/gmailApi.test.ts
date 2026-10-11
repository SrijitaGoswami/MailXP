/**
 * Phase B9 — Gmail REST client tests (fetch stubbed; no real network).
 *
 * Covers: refresh-token → access-token exchange, `invalid_grant` →
 * GmailReconnectRequiredError (no secret leakage), category-only errors for
 * every other failure, timeout handling, and the outbound HOST allow-list (the
 * same discipline googleOAuth.test.ts enforces for B8).
 */

import { describe, expect, it, vi } from "vitest";
import {
  GMAIL_API_BASE,
  GMAIL_TOKEN_ENDPOINT,
  GmailApiError,
  GmailReconnectRequiredError,
  getMessage,
  getProfile,
  listHistory,
  listMessages,
  refreshAccessToken,
} from "./gmailApi";

const CONFIG = { clientId: "cid", clientSecret: "csecret" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("refreshAccessToken", () => {
  it("posts the refresh token to the token endpoint and returns the access token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: "at-1", expires_in: 3600 }));
    const result = await refreshAccessToken(CONFIG, "rt-1", fetchFn as unknown as typeof fetch);
    expect(result.accessToken).toBe("at-1");
    expect(result.expiresInSeconds).toBe(3600);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GMAIL_TOKEN_ENDPOINT);
    const params = new URLSearchParams(init.body as string);
    expect(params.get("refresh_token")).toBe("rt-1");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe("cid");
  });

  it("invalid_grant → GmailReconnectRequiredError (dead/revoked credentials)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
    await expect(refreshAccessToken(CONFIG, "rt-dead", fetchFn as unknown as typeof fetch)).rejects.toBeInstanceOf(
      GmailReconnectRequiredError,
    );
  });

  it("a 5xx / quota / network failure is a category error, NOT reconnect", async () => {
    const server = vi.fn().mockResolvedValue(jsonResponse(500, { error: "server_error" }));
    await expect(refreshAccessToken(CONFIG, "rt", server as unknown as typeof fetch)).rejects.toBeInstanceOf(
      GmailApiError,
    );
    const quota = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    await expect(refreshAccessToken(CONFIG, "rt", quota as unknown as typeof fetch)).rejects.toMatchObject({
      category: "refresh_quota",
    });
    const network = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(refreshAccessToken(CONFIG, "rt", network as unknown as typeof fetch)).rejects.toMatchObject({
      category: "refresh_network",
    });
  });

  it("a malformed token response (no access_token) is a shape error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { expires_in: 100 }));
    await expect(refreshAccessToken(CONFIG, "rt", fetchFn as unknown as typeof fetch)).rejects.toMatchObject({
      category: "refresh_shape",
    });
  });

  it("thrown messages never contain the refresh token or client secret", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const error = (await refreshAccessToken(CONFIG, "SUPER-SECRET-RT", fetchFn as unknown as typeof fetch).catch(
      (caught: unknown) => caught,
    )) as Error;
    expect(error.message).not.toContain("SUPER-SECRET-RT");
    expect(error.message).not.toContain("csecret");
  });
});

describe("Gmail read helpers", () => {
  it("listMessages pages message refs and surfaces nextPageToken", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        messages: [{ id: "m1", threadId: "t1" }, { id: "m2" }],
        nextPageToken: "p2",
      }),
    );
    const page = await listMessages("at", { newerThanUnixSeconds: 1000, maxResults: 50 }, fetchFn as unknown as typeof fetch);
    expect(page.messages).toEqual([{ id: "m1", threadId: "t1" }, { id: "m2" }]);
    expect(page.nextPageToken).toBe("p2");
    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url.startsWith(`${GMAIL_API_BASE}/messages`)).toBe(true);
    expect(url).toContain("after%3A1000");
  });

  it("listMessages tolerates an empty mailbox (no messages key)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const page = await listMessages("at", { newerThanUnixSeconds: 1 }, fetchFn as unknown as typeof fetch);
    expect(page.messages).toEqual([]);
    expect(page.nextPageToken).toBeUndefined();
  });

  it("listHistory maps added/removed ids and the new cursor", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        historyId: "h2",
        history: [
          { messagesAdded: [{ message: { id: "a1" } }] },
          { messagesRemoved: [{ message: { id: "r1" } }], messagesDeleted: [{ message: { id: "r2" } }] },
        ],
      }),
    );
    const result = await listHistory("at", { startHistoryId: "h1" }, fetchFn as unknown as typeof fetch);
    expect(result.historyId).toBe("h2");
    expect(result.addedMessageIds).toEqual(["a1"]);
    expect(result.removedMessageIds).toEqual(["r1", "r2"]);
  });

  it("listHistory falls back to the requested cursor when the response omits historyId", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { history: [] }));
    const result = await listHistory("at", { startHistoryId: "h9" }, fetchFn as unknown as typeof fetch);
    expect(result.historyId).toBe("h9"); // a no-op page never clobbers the cursor
  });

  it("getProfile returns the mailbox historyId (cursor source)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { historyId: "hcur", emailAddress: "x@y.z" }));
    const profile = await getProfile("at", fetchFn as unknown as typeof fetch);
    expect(profile.historyId).toBe("hcur");
  });

  it("a 404 on a message is a not_found category (drives controlled skip/resync)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    await expect(getMessage("at", "gone", fetchFn as unknown as typeof fetch)).rejects.toMatchObject({
      category: "not_found",
    });
  });

  it("a 429 is a quota category; a 401 is unauthorized; a timeout is timeout", async () => {
    const quota = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    await expect(getMessage("at", "m", quota as unknown as typeof fetch)).rejects.toMatchObject({ category: "quota" });
    const unauth = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    await expect(getMessage("at", "m", unauth as unknown as typeof fetch)).rejects.toMatchObject({
      category: "unauthorized",
    });
    const timeoutError = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    const timedOut = vi.fn().mockRejectedValue(timeoutError);
    await expect(getMessage("at", "m", timedOut as unknown as typeof fetch)).rejects.toMatchObject({
      category: "timeout",
    });
  });

  it("error messages never embed the provider response body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(500, { error: { message: "sensitive provider text" } }));
    const error = (await getMessage("at", "m", fetchFn as unknown as typeof fetch).catch(
      (caught: unknown) => caught,
    )) as Error;
    expect(error.message).not.toContain("sensitive provider text");
  });
});

describe("outbound host allow-list (same discipline as B8)", () => {
  it("the Gmail client references only Google API hosts", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(`${process.cwd()}/lib/server/gmailApi.ts`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const hosts = Array.from(code.matchAll(/https:\/\/([a-z0-9.-]+)\b/gi), (m) => (m[1] as string).toLowerCase());
    const allowed = ["gmail.googleapis.com", "oauth2.googleapis.com"];
    for (const host of hosts) {
      expect(allowed, `unexpected outbound host: ${host}`).toContain(host);
    }
    expect(hosts.length).toBeGreaterThan(0);
  });
});
