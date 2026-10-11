/**
 * Durable auth audit records (Phase B4).
 *
 * The B1 contract lists "audit <event>" as a side effect of every auth route;
 * BACKEND_PHASE_PLAN's B4 scope includes "audit logging"; MASTER_REQUIREMENTS
 * §19 requires maintained audit records. User decision 2026-10-10: an
 * AuditEvent table (not just log lines), migrated additively in
 * 20261010074147_b4_auth_tokens_audit.
 *
 * Privacy (B1 §1.9): rows never contain email addresses, email content,
 * passwords, tokens, session ids, or IP addresses — only the event type, the
 * acting user (nullable; survives as a non-personal tombstone after account
 * deletion via SetNull), the correlation requestId, and a minimal meta bucket
 * passed through the same secret-key redaction as the logger.
 */

import type { Prisma } from "@prisma/client";
import { redactFields } from "./logger";

export const AUTH_AUDIT_EVENTS = [
  "auth.register",
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.email_verified",
  "auth.verification_resent",
  "auth.reset_requested",
  "auth.password_reset",
  "auth.deletion_requested",
  // B7: written by the deletion worker as durable, non-personal evidence that
  // physical erasure ran (userId is null from the start; contract me.delete §2
  // keeps deletion-related audits as tombstones).
  "auth.account_erased",
  // B8a: "Continue with Google" entrance — account created vs. signed into.
  "auth.register_google",
  "auth.login_google",
] as const;

// B6: economy side effects (contract §4 shop.purchase → "audit economy.purchase").
export const ECONOMY_AUDIT_EVENTS = ["economy.purchase"] as const;

// B8: connection lifecycle (phase_b8.md §4, contract §7.1). Meta carries the
// internal accountId only — no email address, no google sub, no tokens.
export const GOOGLE_AUDIT_EVENTS = [
  "google.connected",
  "google.reconnected",
  "google.transferred",
  "google.disconnected",
  "google.released",
  "google.link_conflict",
  // B9: a mailbox sync was requested (enqueued). Meta carries only the
  // internal connectionId and the trigger source — never email content.
  "gmail.sync_requested",
] as const;

export type AuthAuditEvent = (typeof AUTH_AUDIT_EVENTS)[number];
export type EconomyAuditEvent = (typeof ECONOMY_AUDIT_EVENTS)[number];
export type GoogleAuditEvent = (typeof GOOGLE_AUDIT_EVENTS)[number];
// B10: advisory analysis lifecycle (phase_b10.md §7). Meta carries the
// internal messageId and outcome only — never email content, prompts,
// provider payloads, or the API key.
export const AI_AUDIT_EVENTS = ["ai.analysis_requested", "ai.settings_updated"] as const;
export type AiAuditEvent = (typeof AI_AUDIT_EVENTS)[number];
export type AuditEventType = AuthAuditEvent | EconomyAuditEvent | GoogleAuditEvent | AiAuditEvent;

export interface AuditInput {
  userId: string | null;
  eventType: AuditEventType;
  requestId: string;
  meta?: Record<string, unknown>;
}

/** Write one audit row — call inside the same transaction as the action. */
export async function recordAudit(client: Prisma.TransactionClient, input: AuditInput): Promise<void> {
  const meta = input.meta ? redactFields(input.meta) : undefined;
  await client.auditEvent.create({
    data: {
      userId: input.userId,
      eventType: input.eventType,
      requestId: input.requestId,
      ...(meta ? { meta: meta as Prisma.InputJsonValue } : {}),
    },
  });
}
