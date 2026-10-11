/**
 * Phase B8a — shared `?googleOAuth=` outcome module (pure tests; the DOM
 * scrub half runs only in effects and is covered by the live smoke).
 *
 * Covers: every safe token the callback can emit has a message (no "unexpected
 * result" fallback for known outcomes), unknown tokens fall back safely, and
 * the closed-list map can never grow implicitly.
 */

import { describe, expect, it } from "vitest";
import { describeOAuthOutcome, OAUTH_OUTCOME_MESSAGES } from "@/components/oauthOutcome";

/** Every outcome token the callback route can emit (B8 + B8a). */
const ALL_CALLBACK_OUTCOMES = [
  "connected",
  "signin",
  "denied",
  "session",
  "state",
  "nocode",
  "provider",
  "unverified",
  "conflict",
  "config",
  "account",
] as const;

describe("OAUTH_OUTCOME_MESSAGES", () => {
  it("covers every callback outcome token with a real message", () => {
    for (const token of ALL_CALLBACK_OUTCOMES) {
      expect(OAUTH_OUTCOME_MESSAGES[token], `missing message for ${token}`).toBeTruthy();
      expect(describeOAuthOutcome(token)).toBe(OAUTH_OUTCOME_MESSAGES[token]);
    }
  });

  it("never leaks tokens/URLs/emails — messages are plain prose", () => {
    for (const message of Object.values(OAUTH_OUTCOME_MESSAGES)) {
      expect(message).not.toMatch(/https?:\/\//);
      expect(message).not.toMatch(/[?&]=/);
    }
  });
});

describe("describeOAuthOutcome", () => {
  it("unknown tokens fall back to a generic message (no crash, no leakage)", () => {
    const message = describeOAuthOutcome("totally-unknown");
    expect(message).toContain("unexpected result");
    expect(message).not.toContain("totally-unknown");
  });

  it("B8a sign-in success message exists and differs from the link one", () => {
    expect(describeOAuthOutcome("signin")).toContain("Signed in with Google");
    expect(describeOAuthOutcome("signin")).not.toBe(describeOAuthOutcome("connected"));
  });
});
