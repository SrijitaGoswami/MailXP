/**
 * Request-field validation for the B4 auth routes (Phase B4).
 *
 * Policy is the binding B1 contract §2:
 * - email: trimmed, lowercased (case normalization), max 254 characters;
 * - password: min 10, max 128 characters, static common-password blocklist,
 *   NO composition rules, no forced periodic rotation.
 * Structural problems (wrong type / missing) are 400 VALIDATION_ERROR with
 * field-name details — never echoing the submitted values back.
 */

import { isCommonPassword } from "./commonPasswords";
import type { FieldError } from "./http";

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 254;

// Deliberately pragmatic: one @, no whitespace, a dotted domain part. Full
// RFC 5322 matching is a known anti-pattern (over-permissive + unusable);
// correctness ultimately comes from the verification link anyway.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Contract §2: trimmed + lowercased email form used for storage/lookup. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export type Validation =
  | { ok: true; value: string }
  | { ok: false; errors: FieldError[] };

export function validateEmail(value: unknown): Validation {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, errors: [{ field: "email", message: "Email is required." }] };
  }
  const email = normalizeEmail(value);
  if (email.length > EMAIL_MAX || !EMAIL_SHAPE.test(email)) {
    return { ok: false, errors: [{ field: "email", message: "Email format is invalid." }] };
  }
  return { ok: true, value: email };
}

export function validatePassword(value: unknown): Validation {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, errors: [{ field: "password", message: "Password is required." }] };
  }
  if (value.length < PASSWORD_MIN) {
    return {
      ok: false,
      errors: [{ field: "password", message: `Password must be at least ${PASSWORD_MIN} characters.` }],
    };
  }
  if (value.length > PASSWORD_MAX) {
    return {
      ok: false,
      errors: [{ field: "password", message: `Password must be at most ${PASSWORD_MAX} characters.` }],
    };
  }
  if (isCommonPassword(value)) {
    return {
      ok: false,
      errors: [{ field: "password", message: "Password is too common. Choose a less predictable one." }],
    };
  }
  return { ok: true, value };
}
