/**
 * Safe MIME extraction for the in-game inbox (Phase B9, spec §5).
 *
 * Policy (user decision 2026-10-11, B9 question round): PLAIN TEXT ONLY.
 * - We extract the `text/plain` body and store it as `bodyText`.
 * - HTML is NEVER rendered and NEVER stored. We do not run an HTML sanitizer
 *   because we never produce HTML at all — if a message is HTML-only (no
 *   text/plain part), the body falls back to the provider's plain-text snippet
 *   (or null). This is the safest posture: no scripts, forms, remote images,
 *   or active content can ever reach the DOM from an email.
 * - Attachments are METADATA only (filename, MIME type, size) — bytes are
 *   never downloaded or persisted (spec §5).
 *
 * Everything here is pure and deterministic over the raw Gmail message shape
 * returned by lib/server/gmailMime.ts's sibling gmailApi.getMessage, so it is
 * fully unit-testable without a network or database.
 */

import type { RawGmailMessage, RawGmailPart } from "./gmailApi";

/** Attachment metadata — never carries bytes or an attachmentId to the client. */
export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
}

export interface ExtractedMessage {
  sender: string;
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  isUnread: boolean;
  labelIds: string[];
  attachments: AttachmentMeta[];
  /** Provider receive time in epoch milliseconds (UTC); null when absent. */
  internalDateMs: number | null;
  threadId: string | null;
}

function headerValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string | null {
  if (!Array.isArray(headers)) return null;
  const target = name.toLowerCase();
  for (const header of headers) {
    if (typeof header?.name === "string" && header.name.toLowerCase() === target) {
      return typeof header.value === "string" ? header.value : null;
    }
  }
  return null;
}

/** base64url → UTF-8 text. Tolerant of malformed input (returns ""). */
function decodeBase64Url(data: string): string {
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    // Buffer is available in the Node runtime this app runs in.
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** Depth-first search for the first non-empty `text/plain` part body. */
function findPlainText(part: RawGmailPart | undefined): string | null {
  if (!part) return null;
  const isPlain = typeof part.mimeType === "string" && part.mimeType.toLowerCase() === "text/plain";
  const data = part.body?.data;
  if (isPlain && typeof data === "string" && data !== "") {
    const text = decodeBase64Url(data).trim();
    if (text !== "") return text;
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const found = findPlainText(child);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Depth-first collection of attachment parts (any part with a filename or attachmentId). */
function collectAttachments(part: RawGmailPart | undefined, into: AttachmentMeta[]): void {
  if (!part) return;
  const hasAttachmentId = typeof part.body?.attachmentId === "string" && part.body.attachmentId !== "";
  const hasFilename = typeof part.filename === "string" && part.filename !== "";
  if (hasAttachmentId || hasFilename) {
    into.push({
      filename: typeof part.filename === "string" ? part.filename : "attachment",
      mimeType: typeof part.mimeType === "string" ? part.mimeType : "application/octet-stream",
      size: typeof part.body?.size === "number" ? part.body.size : 0,
    });
    return; // an attachment part has no meaningful children to recurse into
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) collectAttachments(child, into);
  }
}

/**
 * Turn a raw Gmail message into the minimal, safe fields the inbox persists.
 * HTML is dropped by construction (only `text/plain` is ever decoded).
 */
export function extractMessage(raw: RawGmailMessage): ExtractedMessage {
  const payload = raw.payload;
  const sender =
    headerValue(payload?.headers, "from") ??
    headerValue(payload?.headers, "sender") ??
    "Unknown sender";
  const subject = headerValue(payload?.headers, "subject");
  const snippet = typeof raw.snippet === "string" && raw.snippet !== "" ? raw.snippet : null;

  // Body: prefer a text/plain part; fall back to the plain snippet (never HTML).
  let bodyText = findPlainText(payload ? (payload as RawGmailPart) : undefined);
  if (bodyText === null && snippet !== null) bodyText = snippet;

  const attachments: AttachmentMeta[] = [];
  collectAttachments(payload ? (payload as RawGmailPart) : undefined, attachments);

  const labelIds = Array.isArray(raw.labelIds) ? raw.labelIds.filter((l): l is string => typeof l === "string") : [];
  const isUnread = labelIds.includes("UNREAD");

  const internalDateMs =
    typeof raw.internalDate === "string" && /^\d+$/.test(raw.internalDate) ? Number(raw.internalDate) : null;

  return {
    sender,
    subject,
    snippet,
    bodyText,
    isUnread,
    labelIds,
    attachments,
    internalDateMs,
    threadId: typeof raw.threadId === "string" && raw.threadId !== "" ? raw.threadId : null,
  };
}
