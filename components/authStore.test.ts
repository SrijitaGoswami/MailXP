/**
 * Phase B5 — shared auth store tests (apiClient mocked; no React rendering —
 * the store is a module store consumed via useSyncExternalStore).
 *
 * Covers phase_b5 §11: probe outcomes (signed-in / signed-out / network →
 * notice, single attempt), sign-in adoption, sign-out finality, and the
 * single-transition rule for 401 UNAUTHENTICATED/SESSION_EXPIRED (no retry
 * loops, no re-probe).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./apiClient", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    requestId: string;
    fieldErrors: Array<{ field: string; message: string; currentVersion?: number }>;
    constructor(
      status: number,
      code: string,
      message: string,
      requestId: string,
      fieldErrors: Array<{ field: string; message: string; currentVersion?: number }> = [],
    ) {
      super(message);
      this.status = status;
      this.code = code;
      this.requestId = requestId;
      this.fieldErrors = fieldErrors;
    }
  },
  fetchMe: vi.fn(),
  logoutRequest: vi.fn(),
  isSessionErrorCode: (code: string) => code === "UNAUTHENTICATED" || code === "SESSION_EXPIRED",
}));

import type { ApiError } from "./apiClient";
import { fetchMe, logoutRequest } from "./apiClient";
import {
  adoptPlayer,
  clearNotice,
  getAuthSnapshot,
  probeAuth,
  reportSessionLost,
  resetAuthStore,
  signOut,
} from "./authStore";

const PLAYER = { id: "user-1", email: "a@example.test", emailVerified: false, createdAt: "2026-01-01T00:00:00.000Z" };

const fetchMeMock = vi.mocked(fetchMe);
const logoutMock = vi.mocked(logoutRequest);

beforeEach(() => {
  resetAuthStore();
  fetchMeMock.mockReset();
  logoutMock.mockReset();
  logoutMock.mockResolvedValue(undefined);
});

afterEach(() => {
  resetAuthStore();
});

describe("probeAuth (boot)", () => {
  it("starts in the checking state", () => {
    expect(getAuthSnapshot()).toEqual({ status: "checking", player: null, notice: null });
  });

  it("200 with a player → signedIn", async () => {
    fetchMeMock.mockResolvedValue(PLAYER);
    await probeAuth();
    expect(getAuthSnapshot()).toEqual({ status: "signedIn", player: PLAYER, notice: null });
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  it("null player (401 either flavor) → signedOut", async () => {
    fetchMeMock.mockResolvedValue(null);
    await probeAuth();
    expect(getAuthSnapshot().status).toBe("signedOut");
    expect(getAuthSnapshot().player).toBeNull();
  });

  it("network failure → signedOut WITH a notice, one attempt only (no retry loop)", async () => {
    fetchMeMock.mockRejectedValue(new Error("network down"));
    await probeAuth();
    const snapshot = getAuthSnapshot();
    expect(snapshot.status).toBe("signedOut");
    expect(snapshot.notice).toContain("Could not reach the server");
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  it("is guarded (StrictMode double-mount cannot double-probe)", async () => {
    fetchMeMock.mockResolvedValue(null);
    await Promise.all([probeAuth(), probeAuth()]);
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });
});

describe("adoptPlayer / signOut", () => {
  it("adoptPlayer marks signed in and clears notices", async () => {
    fetchMeMock.mockResolvedValue(null);
    await probeAuth();
    reportSessionLost("SESSION_EXPIRED");
    expect(getAuthSnapshot().notice).toBeTruthy();

    adoptPlayer(PLAYER);
    expect(getAuthSnapshot()).toEqual({ status: "signedIn", player: PLAYER, notice: null });
  });

  it("sign-out revokes server-side first, then clears local state", async () => {
    adoptPlayer(PLAYER);
    await signOut();
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(getAuthSnapshot()).toEqual({ status: "signedOut", player: null, notice: null });
  });

  it("sign-out still clears locally if the logout call rejects (finally rule)", async () => {
    adoptPlayer(PLAYER);
    logoutMock.mockRejectedValue(new Error("network"));
    await expect(signOut()).rejects.toThrow("network");
    expect(getAuthSnapshot().status).toBe("signedOut"); // no stuck signed-in UI
    expect(getAuthSnapshot().player).toBeNull();
  });
});

describe("reportSessionLost (single transition, no loops)", () => {
  it("SESSION_EXPIRED → signedOut with expiry notice", async () => {
    adoptPlayer(PLAYER);
    reportSessionLost("SESSION_EXPIRED");
    expect(getAuthSnapshot().status).toBe("signedOut");
    expect(getAuthSnapshot().notice).toContain("expired");
  });

  it("UNAUTHENTICATED → signedOut with sign-in notice", async () => {
    adoptPlayer(PLAYER);
    reportSessionLost("UNAUTHENTICATED");
    expect(getAuthSnapshot().status).toBe("signedOut");
    expect(getAuthSnapshot().notice).toContain("sign in");
  });

  it("ignores non-session codes (a VALIDATION_ERROR must not kill the session)", async () => {
    adoptPlayer(PLAYER);
    reportSessionLost("VALIDATION_ERROR");
    reportSessionLost("RATE_LIMITED");
    expect(getAuthSnapshot().status).toBe("signedIn");
  });

  it("repeat reports are idempotent (no notice churn after already signed out)", async () => {
    fetchMeMock.mockResolvedValue(null);
    await probeAuth();
    reportSessionLost("SESSION_EXPIRED");
    const first = getAuthSnapshot();
    reportSessionLost("SESSION_EXPIRED");
    expect(getAuthSnapshot()).toEqual(first);
  });

  it("clearNotice drops the notice without changing status", async () => {
    fetchMeMock.mockResolvedValue(null);
    await probeAuth();
    reportSessionLost("SESSION_EXPIRED");
    clearNotice();
    expect(getAuthSnapshot().notice).toBeNull();
    expect(getAuthSnapshot().status).toBe("signedOut");
  });
});

describe("describeAuthError presentation (AuthPanel pure mapping)", () => {
  it("maps stable codes to non-enumerating messages", async () => {
    const { describeAuthError } = await import("./AuthPanel");
    const { ApiError: ApiErrorClass } = await import("./apiClient");
    const make = (code: string, status = 400): ApiError =>
      new ApiErrorClass(status, code, "raw server text", "req", []) as never;

    expect(describeAuthError(make("GOOGLE_SIGNIN_REQUIRED", 403)).message).toContain("Continue with Google");
    expect(describeAuthError(make("RATE_LIMITED", 429)).message).toContain("Too many attempts");
    expect(describeAuthError(make("NETWORK_ERROR", 0)).message).toContain("reach the server");

    // Unknown codes fall back to the safe server summary — never a throw.
    expect(describeAuthError(make("INTERNAL_ERROR", 500)).message).toBe("raw server text");
    expect(describeAuthError(new Error("programmer error")).message).toBe("Something went wrong. Try again.");
  });
});
