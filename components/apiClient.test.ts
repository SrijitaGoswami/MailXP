/**
 * Phase B5 — client API layer tests (fetch stubbed; no server, no network).
 *
 * Covers phase_b5 §11: B4 request shapes (login/register/logout paths, JSON
 * bodies, same-origin credentials), envelope → ApiError mapping (stable codes
 * + details incl. currentVersion), deliberate 401 handling in fetchMe, the
 * logout-401-tolerated rule, and the game route calls (state + preferences
 * with expectedVersion).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchGameState,
  fetchMe,
  isSessionErrorCode,
  logoutRequest,
  patchPreferences,
  resendVerificationEmail,
  startGoogleSignIn,
  verifyEmailToken,
} from "@/components/apiClient";

const PLAYER = { id: "user-1", email: "a@example.test", emailVerified: false, createdAt: "2026-01-01T00:00:00.000Z" };

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];
let nextResponse: Response | (() => Response | Promise<Response>) | null = null;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  nextResponse = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const value = nextResponse;
      if (typeof value === "function") return value();
      if (value) return value;
      return jsonResponse(200, {});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request shapes (B4 contracts)", () => {
  it("logout posts with credentials and accepts 204", async () => {
    nextResponse = () => new Response(null, { status: 204 });
    await expect(logoutRequest()).resolves.toBeUndefined();
    expect(calls[0].url).toBe("/api/v1/auth/logout");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("logout treats 401 as already-signed-out (no throw)", async () => {
    nextResponse = () => jsonResponse(401, { error: { code: "SESSION_EXPIRED", message: "expired", requestId: "r" } });
    await expect(logoutRequest()).resolves.toBeUndefined();
  });

  it("logout rethrows non-auth failures (network honesty)", async () => {
    nextResponse = () => jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r" } });
    await expect(logoutRequest()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

describe("fetchMe (boot probe)", () => {
  it("200 → player", async () => {
    nextResponse = () => jsonResponse(200, { player: PLAYER });
    expect(await fetchMe()).toEqual(PLAYER);
    expect(calls[0].url).toBe("/api/v1/me");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
  });

  it("401 UNAUTHENTICATED → null (signed out, not an error)", async () => {
    nextResponse = () => jsonResponse(401, { error: { code: "UNAUTHENTICATED", message: "x", requestId: "r" } });
    expect(await fetchMe()).toBeNull();
  });

  it("401 SESSION_EXPIRED → null", async () => {
    nextResponse = () => jsonResponse(401, { error: { code: "SESSION_EXPIRED", message: "x", requestId: "r" } });
    expect(await fetchMe()).toBeNull();
  });

  it("network failure → ApiError NETWORK_ERROR (surfaced, no retry loop)", async () => {
    nextResponse = () => {
      throw new TypeError("fetch failed");
    };
    await expect(fetchMe()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    expect(calls).toHaveLength(1); // exactly one attempt — no hidden retries
  });

  it("server 500 → ApiError with the envelope code", async () => {
    nextResponse = () =>
      jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "x", requestId: "req-1" } });
    await expect(fetchMe()).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      requestId: "req-1",
    });
  });
});

describe("error mapping", () => {
  it("parses field details incl. currentVersion (STALE_VERSION shape)", async () => {
    nextResponse = () =>
      jsonResponse(409, {
        error: {
          code: "STALE_VERSION",
          message: "Profile version is stale.",
          requestId: "req-9",
          details: [
            { field: "expectedVersion", message: "stale", currentVersion: 4 },
            { field: "preferences.muted", message: "Must be a boolean." },
          ],
        },
      });
    const error = await patchPreferences({ muted: true }, 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;
    expect(api.status).toBe(409);
    expect(api.code).toBe("STALE_VERSION");
    expect(api.fieldErrors).toEqual([
      { field: "expectedVersion", message: "stale", currentVersion: 4 },
      { field: "preferences.muted", message: "Must be a boolean." },
    ]);
  });

  it("malformed/non-envelope error bodies still yield a usable ApiError", async () => {
    nextResponse = () => new Response("<html>gateway</html>", { status: 502 });
    const error = await logoutRequest().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("INTERNAL_ERROR");
    expect((error as ApiError).status).toBe(502);
  });

  it("isSessionErrorCode covers exactly the two session codes", () => {
    expect(isSessionErrorCode("UNAUTHENTICATED")).toBe(true);
    expect(isSessionErrorCode("SESSION_EXPIRED")).toBe(true);
    expect(isSessionErrorCode("INVALID_CREDENTIALS")).toBe(false);
    expect(isSessionErrorCode("VALIDATION_ERROR")).toBe(false);
  });
});

describe("game routes", () => {
  it("fetchGameState issues a GET against /game/state", async () => {
    nextResponse = () =>
      jsonResponse(200, {
        playerId: "user-1",
        draftCoin: 0,
        xp: 0,
        level: 1,
        stats: { mailCount: 0 },
        ownedItems: [],
        equippedOutfit: "worker",
        placedDecor: [],
        preferences: {
          masterVolume: 0.8,
          uiVolume: 0.9,
          gameVolume: 0.8,
          muted: false,
          motion: "full",
          touchControls: "auto",
        },
        version: 1,
      });
    const state = await fetchGameState();
    expect(state.version).toBe(1);
    expect(calls[0].url).toBe("/api/v1/game/state");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("patchPreferences sends { preferences, expectedVersion } as PATCH", async () => {
    nextResponse = () => jsonResponse(200, { preferences: { muted: true }, version: 3 });
    const result = await patchPreferences({ muted: true }, 2);
    expect(result.version).toBe(3);
    expect(calls[0].url).toBe("/api/v1/game/preferences");
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      preferences: { muted: true },
      expectedVersion: 2,
    });
    expect(calls[0].init?.credentials).toBe("same-origin");
  });
});

// --------------------------------------------- B8a: google signin + email verification UI ---

describe("B8a client calls", () => {
  it("startGoogleSignIn posts { intent: 'signin' } to the SAME start endpoint", async () => {
    nextResponse = () => jsonResponse(200, { authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
    const { authUrl } = await startGoogleSignIn();
    expect(authUrl).toContain("accounts.google.com");
    expect(calls[0].url).toBe("/api/v1/integrations/google/start");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ intent: "signin" });
  });

  it("resendVerificationEmail posts {} and surfaces devDelivery when present", async () => {
    nextResponse = () =>
      jsonResponse(202, {
        devDelivery: { purpose: "email_verification", token: "dev-token", expiresAt: "2026-01-01T00:00:00.000Z" },
      });
    const { devDelivery } = await resendVerificationEmail();
    expect(devDelivery?.token).toBe("dev-token");
    expect(calls[0].url).toBe("/api/v1/auth/resend-verification");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("verifyEmailToken posts { token } and parses the player result", async () => {
    nextResponse = () => jsonResponse(200, { player: { emailVerified: true } });
    const result = await verifyEmailToken("some-token");
    expect(result.player.emailVerified).toBe(true);
    expect(calls[0].url).toBe("/api/v1/auth/verify-email");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ token: "some-token" });
  });
});
