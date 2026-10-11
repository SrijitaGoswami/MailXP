/**
 * Phase B9 — safe MIME extraction tests (pure, no network/db).
 *
 * Policy under test (user decision 2026-10-11): PLAIN TEXT ONLY. HTML is
 * never returned or stored; an HTML-only message falls back to the snippet.
 * Attachments are METADATA only (filename/MIME/size — never bytes). Malformed
 * provider payloads must not throw or leak.
 */

import { describe, expect, it } from "vitest";
import { extractMessage } from "./gmailMime";
import type { RawGmailMessage } from "./gmailApi";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

function message(overrides: Partial<RawGmailMessage> = {}): RawGmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    internalDate: "1728000000000",
    labelIds: ["UNREAD", "INBOX"],
    snippet: "A short snippet",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "Subject", value: "Hello there" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Plain body line") } },
        { mimeType: "text/html", body: { data: b64("<p>HTML body</p>") } },
      ],
    },
    ...overrides,
  };
}

describe("extractMessage — plain-text policy", () => {
  it("extracts sender, subject, snippet, unread, and the text/plain body", () => {
    const fields = extractMessage(message());
    expect(fields.sender).toBe("Alice <alice@example.com>");
    expect(fields.subject).toBe("Hello there");
    expect(fields.snippet).toBe("A short snippet");
    expect(fields.isUnread).toBe(true);
    expect(fields.labelIds).toEqual(["UNREAD", "INBOX"]);
    expect(fields.bodyText).toBe("Plain body line");
    expect(fields.internalDateMs).toBe(1728000000000);
    expect(fields.threadId).toBe("t1");
  });

  it("NEVER returns HTML — prefers text/plain even inside a multipart body", () => {
    const fields = extractMessage(message());
    expect(fields.bodyText).not.toContain("<p>");
    expect(fields.bodyText).not.toContain("html");
    expect(fields.bodyText).toBe("Plain body line");
  });

  it("an HTML-ONLY message falls back to the plain snippet (never raw HTML)", () => {
    const htmlOnly = message({
      snippet: "Plain snippet fallback",
      payload: {
        mimeType: "text/html",
        headers: [{ name: "From", value: "bob@example.com" }],
        parts: [{ mimeType: "text/html", body: { data: b64("<script>alert(1)</script>Click") } }],
      },
    });
    const fields = extractMessage(htmlOnly);
    expect(fields.bodyText).toBe("Plain snippet fallback");
    expect(fields.bodyText).not.toContain("<script>");
  });

  it("an HTML-only message with no snippet yields a null body (never HTML)", () => {
    const htmlOnly = message({
      snippet: undefined,
      payload: {
        mimeType: "text/html",
        headers: [],
        parts: [{ mimeType: "text/html", body: { data: b64("<b>bold</b>") } }],
      },
    });
    expect(extractMessage(htmlOnly).bodyText).toBeNull();
  });
});

describe("extractMessage — attachments are metadata only", () => {
  it("collects filename/MIME/size and never any attachment bytes", () => {
    const withAttachment = message({
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "From", value: "carol@example.com" }],
        parts: [
          { mimeType: "text/plain", body: { data: b64("See attached") } },
          {
            mimeType: "application/pdf",
            filename: "report.pdf",
            body: { attachmentId: "att-1", size: 2048, data: b64("BYTES") },
          },
        ],
      },
    });
    const fields = extractMessage(withAttachment);
    expect(fields.attachments).toEqual([{ filename: "report.pdf", mimeType: "application/pdf", size: 2048 }]);
    // No attachment payload data leaks into the body or attachments metadata.
    expect(fields.bodyText).toBe("See attached");
    for (const attachment of fields.attachments) {
      expect(Object.keys(attachment).sort()).toEqual(["filename", "mimeType", "size"]);
    }
  });

  it("an attachment-less message yields an empty attachment list", () => {
    expect(extractMessage(message()).attachments).toEqual([]);
  });
});

describe("extractMessage — malformed payloads never throw or leak", () => {
  it("a message with no payload/headers degrades to safe defaults", () => {
    const bare = { id: "m2", snippet: "hi" } as RawGmailMessage;
    const fields = extractMessage(bare);
    expect(fields.sender).toBe("Unknown sender");
    expect(fields.subject).toBeNull();
    expect(fields.bodyText).toBe("hi"); // snippet fallback
    expect(fields.attachments).toEqual([]);
    expect(fields.isUnread).toBe(false);
    expect(fields.internalDateMs).toBeNull();
  });

  it("garbage base64 in a text/plain part does not throw (returns empty/decoded best-effort)", () => {
    const garbage = message({
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "From", value: "d@example.com" }],
        parts: [{ mimeType: "text/plain", body: { data: "!!!not-base64url!!!" } }],
      },
    });
    expect(() => extractMessage(garbage)).not.toThrow();
  });

  it("a non-numeric internalDate yields null rather than NaN", () => {
    expect(extractMessage(message({ internalDate: "not-a-number" })).internalDateMs).toBeNull();
  });
});
