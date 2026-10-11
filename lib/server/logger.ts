/**
 * Server-only structured logger + request-ID policy (Phase B3).
 *
 * Format: one JSON object per line (always — user decision 2026-10-10), e.g.
 *   {"ts":"2026-10-10T06:30:00.000Z","level":"info","msg":"health.ok","requestId":"…"}
 *
 * Guarantees:
 * - never logs stack traces, SQL, connection strings, request bodies, email
 *   content, tokens, or raw driver errors (callers pass short primitive fields
 *   only; keys matching secret-ish names are dropped defensively);
 * - request IDs are accepted from inbound headers ONLY when they match
 *   /^[A-Za-z0-9_-]{8,64}$/; anything else is replaced with crypto.randomUUID().
 */

import { randomUUID } from "node:crypto";

export type LogLevel = "info" | "warn" | "error";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const FORBIDDEN_KEY = /(pass|secret|token|auth|cookie|credential|connection|database|dburl|api[-_]?key|private)/i;

/** Resolve the request ID for this request: safe inbound value, else a fresh UUID. */
export function resolveRequestId(inbound: string | null | undefined): string {
  if (typeof inbound === "string" && SAFE_REQUEST_ID.test(inbound)) return inbound;
  return randomUUID();
}

export type LogFields = Record<string, unknown>;

/**
 * Drop secret-ish field keys defensively. Exported so AuditEvent metadata goes
 * through the exact same redaction policy as log lines (Phase B4 reuse).
 */
export function redactFields(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEY.test(key)) continue; // defensive drop — never log/store these
    safe[key] = value;
  }
  return safe;
}

function emit(level: LogLevel, msg: string, fields: LogFields): void {
  const safe = redactFields(fields);
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, fields: LogFields = {}) => emit("info", msg, fields),
  warn: (msg: string, fields: LogFields = {}) => emit("warn", msg, fields),
  error: (msg: string, fields: LogFields = {}) => emit("error", msg, fields),
};
