/**
 * Phase B6 — idempotency unit tests (contract §1.6 semantics, MOCKED storage).
 *
 * Key validation, canonical fingerprinting (order-independent), and every
 * begin outcome: OK / REPLAY / MISMATCH / IN_PROGRESS, stale take-over of a
 * crashed reservation, and 24 h retention replacement.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import {
  beginIdempotency,
  canonicalJson,
  completeIdempotency,
  ENDPOINT_SHOP_PURCHASE,
  IDEMPOTENCY_RETENTION_MS,
  IN_PROGRESS_STALE_MS,
  isValidIdempotencyKey,
  releaseIdempotency,
  requestFingerprint,
  type IdempotencyDb,
} from "./idempotency";

let fake: FakeDb;
let db: IdempotencyDb;

beforeEach(() => {
  fake = createFakeDb();
  db = fake.client as unknown as IdempotencyDb;
});

const PROFILE = "profile-1";
const args = (overrides: Partial<{ key: string; fingerprint: string; now: number }> = {}) => ({
  profileId: PROFILE,
  endpoint: ENDPOINT_SHOP_PURCHASE,
  key: overrides.key ?? randomUUID(),
  fingerprint: overrides.fingerprint ?? "fp-A",
  ...(overrides.now !== undefined ? { now: overrides.now } : {}),
});

describe("isValidIdempotencyKey", () => {
  it("accepts UUID-shaped keys and rejects everything else", () => {
    expect(isValidIdempotencyKey(randomUUID())).toBe(true);
    expect(isValidIdempotencyKey("not-a-uuid")).toBe(false);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
    expect(isValidIdempotencyKey("12345678-1234-1234-1234-1234567890123")).toBe(false); // 13-char tail
  });
});

describe("canonicalJson / requestFingerprint", () => {
  it("is key-order independent at every depth", () => {
    const a = { itemId: "plant", expectedVersion: 3, nested: { b: 2, a: 1 } };
    const b = { nested: { a: 1, b: 2 }, expectedVersion: 3, itemId: "plant" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(requestFingerprint("e", a)).toBe(requestFingerprint("e", b));
  });

  it("changes when any value changes or the endpoint changes", () => {
    const base = { itemId: "plant", expectedVersion: 3 };
    expect(requestFingerprint("e", base)).not.toBe(requestFingerprint("e", { ...base, expectedVersion: 4 }));
    expect(requestFingerprint("e", base)).not.toBe(requestFingerprint("other", base));
  });
});

describe("beginIdempotency outcomes", () => {
  it("fresh key → OK (reservation created, 24 h retention)", async () => {
    const now = Date.now();
    const outcome = await beginIdempotency(db, args({ now }));
    expect(outcome.kind).toBe("OK");
    expect(fake.idempotency).toHaveLength(1);
    expect(fake.idempotency[0]).toMatchObject({ status: "in_progress" });
    expect((fake.idempotency[0].expiresAt as Date).getTime()).toBe(now + IDEMPOTENCY_RETENTION_MS);
  });

  it("completed same fingerprint → REPLAY with stored status/body", async () => {
    const key = randomUUID();
    await beginIdempotency(db, args({ key, fingerprint: "fp-A" }));
    await completeIdempotency(db, {
      profileId: PROFILE,
      endpoint: ENDPOINT_SHOP_PURCHASE,
      key,
      httpStatus: 201,
      summary: { transactionId: "t-1", balance: 94 },
    });

    const outcome = await beginIdempotency(db, args({ key, fingerprint: "fp-A" }));
    expect(outcome.kind).toBe("REPLAY");
    if (outcome.kind === "REPLAY") {
      expect(outcome.httpStatus).toBe(201);
      expect(outcome.summary).toEqual({ transactionId: "t-1", balance: 94 });
    }
    expect(fake.idempotency).toHaveLength(1); // no new record
  });

  it("different fingerprint → MISMATCH (even before completion)", async () => {
    const key = randomUUID();
    await beginIdempotency(db, args({ key, fingerprint: "fp-A" }));
    const outcome = await beginIdempotency(db, args({ key, fingerprint: "fp-B" }));
    expect(outcome.kind).toBe("MISMATCH");
  });

  it("same fingerprint while in progress → IN_PROGRESS", async () => {
    const key = randomUUID();
    await beginIdempotency(db, args({ key, fingerprint: "fp-A" }));
    const outcome = await beginIdempotency(db, args({ key, fingerprint: "fp-A" }));
    expect(outcome.kind).toBe("IN_PROGRESS");
  });

  it("stale in_progress (crashed request) is taken over after the threshold", async () => {
    const key = randomUUID();
    const now = Date.now();
    await beginIdempotency(db, args({ key, fingerprint: "fp-A", now }));
    // The reservation sits uncompleted past the stale threshold…
    fake.idempotency[0].createdAt = new Date(now - IN_PROGRESS_STALE_MS - 1000);
    // …and a retry takes it over instead of blocking for 24 h.
    const outcome = await beginIdempotency(db, args({ key, fingerprint: "fp-A", now: now + 1000 }));
    expect(outcome.kind).toBe("OK");
    expect(fake.idempotency).toHaveLength(1);
  });

  it("expired record (24 h retention) is replaced instead of replayed", async () => {
    const key = randomUUID();
    const now = Date.now();
    await beginIdempotency(db, args({ key, fingerprint: "fp-A", now }));
    await completeIdempotency(db, {
      profileId: PROFILE,
      endpoint: ENDPOINT_SHOP_PURCHASE,
      key,
      httpStatus: 201,
      summary: { stale: true },
    });
    fake.idempotency[0].expiresAt = new Date(now - 1000); // well past retention

    const outcome = await beginIdempotency(db, args({ key, fingerprint: "fp-B", now }));
    expect(outcome.kind).toBe("OK"); // fresh reservation, not a replay of the stale one
    expect(fake.idempotency).toHaveLength(1);
    expect(fake.idempotency[0].status).toBe("in_progress");
  });

  it("release drops only the in_progress reservation so a retry can re-execute", async () => {
    const key = randomUUID();
    await beginIdempotency(db, args({ key }));
    await releaseIdempotency(db, { profileId: PROFILE, endpoint: ENDPOINT_SHOP_PURCHASE, key });
    expect(fake.idempotency).toHaveLength(0);

    // Completed records are never released by a late failure call.
    await beginIdempotency(db, args({ key }));
    await completeIdempotency(db, {
      profileId: PROFILE,
      endpoint: ENDPOINT_SHOP_PURCHASE,
      key,
      httpStatus: 201,
      summary: {},
    });
    await releaseIdempotency(db, { profileId: PROFILE, endpoint: ENDPOINT_SHOP_PURCHASE, key });
    expect(fake.idempotency).toHaveLength(1);
    expect(fake.idempotency[0].status).toBe("completed");
  });

  it("keys are scoped per player: two players can use the same key value", async () => {
    const key = randomUUID();
    const first = await beginIdempotency(db, { ...args({ key }), profileId: "profile-A" });
    const second = await beginIdempotency(db, { ...args({ key }), profileId: "profile-B" });
    expect(first.kind).toBe("OK");
    expect(second.kind).toBe("OK");
    expect(fake.idempotency).toHaveLength(2);
  });
});
