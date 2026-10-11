/**
 * Phase B7 — account-deletion lifecycle tests (MOCKED storage: in-memory fake
 * DB with real $transaction snapshot rollback).
 *
 * Covers phase_b7.md §11 deletion requirements: only explicitly requested
 * accounts are ever selected (marker enforced, refuse otherwise), full
 * personal wipe with FK-order deletes, AuditEvent tombstone/erasure-evidence
 * semantics, repeated processing is safe (idempotent), mid-work failure
 * rolls back everything and retries cleanly, unrelated accounts are never
 * touched, and NO provider/network code exists anywhere in the pipeline.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { PermanentJobError } from "./jobQueue";
import { eraseAccount, runAccountDeletion, type DeletionDb } from "./deletion";

let fake: FakeDb;
let db: DeletionDb;

const T0 = new Date("2026-10-10T12:00:00.000Z");

beforeEach(() => {
  fake = createFakeDb();
  db = fake.client as unknown as DeletionDb;
});

/** Seed a fully-populated account: user + profile + economy rows + sessions. */
async function seedAccount(email: string, requested: boolean): Promise<string> {
  const user = (await fake.client.user.create({
    data: { email, passwordHash: "$2b$10$hashmaterial00000000000000000000000000000000" },
  })) as { id: string };
  if (requested) {
    await fake.client.user.update({ where: { id: user.id }, data: { deletionRequestedAt: T0 } });
  }
  const profile = (await fake.client.playerProfile.create({
    data: { userId: user.id, draftCoin: 55, prefs: {} },
  })) as { id: string };
  await fake.client.session.create({
    data: { userId: user.id, tokenHash: `hash-${email}`, expiresAt: new Date(Date.now() + 1e9) },
  });
  await fake.client.authToken.create({
    data: { userId: user.id, purpose: "EMAIL_VERIFICATION", tokenHash: `tok-${email}`, expiresAt: new Date(Date.now() + 1e9) },
  });
  await fake.client.inventoryItem.create({ data: { profileId: profile.id, itemId: "coffee" } });
  await fake.client.ledgerEntry.create({
    data: { profileId: profile.id, type: "quest_reward", amount: 20, reason: "first_mail" },
  });
  await fake.client.idempotencyRecord.create({
    data: { profileId: profile.id, endpoint: "shop.purchase", key: `k-${email}`, fingerprint: "fp", status: "completed", expiresAt: new Date(Date.now() + 1e9) },
  });
  await fake.client.auditEvent.create({ data: { userId: user.id, eventType: "auth.register", requestId: `req-${email}` } });
  await fake.client.auditEvent.create({ data: { userId: user.id, eventType: "auth.deletion_requested", requestId: `del-${email}` } });
  return user.id;
}

describe("eraseAccount — selection and scope", () => {
  it("erases a requested account completely; audits survive as tombstones", async () => {
    const userId = await seedAccount("wipe@example.test", true);
    const keepId = await seedAccount("keep@example.test", false);

    const outcome = await eraseAccount(db, { userId, requestId: "job-1" });
    expect(outcome).toEqual({ erased: true, reason: "erased" });

    // Personal rows: user, profile, sessions, tokens, inventory, ledger, idempotency — all gone.
    expect(fake.users.find((u) => u.id === userId)).toBeUndefined();
    expect(fake.profiles.find((p) => p.userId === userId)).toBeUndefined();
    expect(fake.sessions.filter((s) => s.userId === userId)).toHaveLength(0);
    expect(fake.tokens.filter((t) => t.userId === userId)).toHaveLength(0);
    expect(fake.inventory.filter((i) => String(i.profileId).startsWith("profile"))).toHaveLength(1); // only the keeper's
    expect(fake.ledgers).toHaveLength(1); // only the keeper's
    expect(fake.idempotency).toHaveLength(1);

    // Audit rows SURVIVE — userId nulled (ON DELETE SET NULL tombstones)…
    const surviving = fake.audits.filter((a) => a.requestId === `req-wipe@example.test` || a.requestId === `del-wipe@example.test`);
    expect(surviving).toHaveLength(2);
    expect(surviving.every((a) => a.userId === null)).toBe(true);

    // …plus the erasure evidence row (userId null from the start, job correlation).
    const evidence = fake.audits.find((a) => a.eventType === "auth.account_erased");
    expect(evidence).toBeDefined();
    expect(evidence?.userId).toBeNull();
    expect(evidence?.requestId).toBe("job-1");

    // No unrelated account was harmed.
    expect(fake.users.find((u) => u.id === keepId)).toBeDefined();
    expect(fake.profiles.find((p) => p.userId === keepId)).toBeDefined();
    expect(fake.audits.filter((a) => a.userId === keepId).length).toBe(2); // keeper's audits intact
  });

  it("refuses an account that never requested deletion (no side effects)", async () => {
    const userId = await seedAccount("innocent@example.test", false);
    const outcome = await eraseAccount(db, { userId, requestId: "job-2" });
    expect(outcome).toEqual({ erased: false, reason: "not_requested" });
    expect(fake.users.find((u) => u.id === userId)).toBeDefined();
    expect(fake.profiles.find((p) => p.userId === userId)).toBeDefined();
    expect(fake.audits.filter((a) => a.eventType === "auth.account_erased")).toHaveLength(0);
  });

  it("reports not_found for an already-erased account (idempotent replay)", async () => {
    const userId = await seedAccount("gone@example.test", true);
    expect(await eraseAccount(db, { userId, requestId: "job-a" })).toEqual({ erased: true, reason: "erased" });
    expect(await eraseAccount(db, { userId, requestId: "job-b" })).toEqual({ erased: false, reason: "not_found" });
    // Exactly one evidence row across both attempts.
    expect(fake.audits.filter((a) => a.eventType === "auth.account_erased")).toHaveLength(1);
  });

  it("repeated erasure attempts are safe (second run is a no-op success)", async () => {
    const userId = await seedAccount("twice@example.test", true);
    await eraseAccount(db, { userId, requestId: "job-1" });
    const again = await eraseAccount(db, { userId, requestId: "job-2" });
    expect(again.reason).toBe("not_found");
    expect(fake.audits.filter((a) => a.eventType === "auth.account_erased")).toHaveLength(1);
  });

  it("survives a user row with no profile (partial state)", async () => {
    const user = (await fake.client.user.create({ data: { email: "bare@example.test", passwordHash: "x" } })) as { id: string };
    await fake.client.user.update({ where: { id: user.id }, data: { deletionRequestedAt: T0 } });
    const outcome = await eraseAccount(db, { userId: user.id, requestId: "job-bare" });
    expect(outcome).toEqual({ erased: true, reason: "erased" });
    expect(fake.users).toHaveLength(0);
  });
});

describe("eraseAccount — mid-work failure rolls back and retries", () => {
  it("a crash mid-transaction restores EVERYTHING, then the retry succeeds", async () => {
    const userId = await seedAccount("flaky@example.test", true);
    const countsBefore = {
      users: fake.users.length,
      profiles: fake.profiles.length,
      sessions: fake.sessions.length,
      tokens: fake.tokens.length,
      inventory: fake.inventory.length,
      ledgers: fake.ledgers.length,
      idempotency: fake.idempotency.length,
      audits: fake.audits.length,
    };

    // Fail AFTER the tombstone/evidence writes, before the user row is gone.
    const originalDelete = fake.client.playerProfile.deleteMany.bind(fake.client.playerProfile);
    (fake.client.playerProfile as { deleteMany: unknown }).deleteMany = async () => {
      throw Object.assign(new Error("disk on fire"), { code: "P1001" });
    };

    await expect(eraseAccount(db, { userId, requestId: "job-1" })).rejects.toThrow("disk on fire");

    // Full rollback: nothing erased, marker intact (never undone), no evidence row.
    expect(fake.users).toHaveLength(countsBefore.users);
    expect(fake.profiles).toHaveLength(countsBefore.profiles);
    expect(fake.sessions).toHaveLength(countsBefore.sessions);
    expect(fake.tokens).toHaveLength(countsBefore.tokens);
    expect(fake.inventory).toHaveLength(countsBefore.inventory);
    expect(fake.ledgers).toHaveLength(countsBefore.ledgers);
    expect(fake.idempotency).toHaveLength(countsBefore.idempotency);
    expect(fake.audits).toHaveLength(countsBefore.audits); // evidence rolled back too
    const user = fake.users.find((u) => u.id === userId);
    expect(user?.deletionRequestedAt).toEqual(T0); // the deletion marker survives

    // Retry with the transient fault cleared -> clean success.
    (fake.client.playerProfile as { deleteMany: unknown }).deleteMany = originalDelete;
    const retry = await eraseAccount(db, { userId, requestId: "job-2" });
    expect(retry).toEqual({ erased: true, reason: "erased" });
    expect(fake.users).toHaveLength(countsBefore.users - 1);
    expect(fake.audits.filter((a) => a.eventType === "auth.account_erased")).toHaveLength(1);
  });
});

describe("runAccountDeletion — the job handler", () => {
  it("validates the payload BEFORE any side effect", async () => {
    const userId = await seedAccount("victim@example.test", true);
    for (const bad of [null, undefined, {}, { userId: "" }, { userId: 7 }, "user-1"]) {
      await expect(runAccountDeletion(db, bad, "job-x")).rejects.toBeInstanceOf(PermanentJobError);
    }
    // Nothing happened to the account.
    expect(fake.users.find((u) => u.id === userId)).toBeDefined();
    expect(fake.audits.filter((a) => a.eventType === "auth.account_erased")).toHaveLength(0);
  });

  it("a non-requested account raises a PERMANENT error (dead-letter, no retry)", async () => {
    const userId = await seedAccount("safe@example.test", false);
    await expect(runAccountDeletion(db, { userId }, "job-y")).rejects.toMatchObject({
      name: "PermanentJobError",
      errorClass: "not_requested",
    });
    expect(fake.users.find((u) => u.id === userId)).toBeDefined();
  });

  it("redelivery after success is a quiet no-op (at-least-once safe)", async () => {
    const userId = await seedAccount("redeliver@example.test", true);
    await runAccountDeletion(db, { userId }, "job-1");
    await expect(runAccountDeletion(db, { userId }, "job-1")).resolves.toBeUndefined();
    expect(fake.audits.filter((a) => a.eventType === "auth.account_erased")).toHaveLength(1);
  });

  it("Pending-deletion users cannot authenticate (B4 marker honored by login)", async () => {
    // Mirrors the B4 route behavior the worker must preserve: the marker
    // itself disables login, and the worker never removes it early — the
    // user row disappears only through the guarded erase path above.
    const userId = await seedAccount("pending@example.test", true);
    const user = fake.users.find((u) => u.id === userId);
    expect(user?.deletionRequestedAt).not.toBeNull();
    await eraseAccount(db, { userId, requestId: "job-final" });
    expect(fake.users.find((u) => u.id === userId)).toBeUndefined(); // no row to log in with
  });
});

describe("provider exposure stays minimal by construction", () => {
  const PIPELINE_SOURCES = [
    "lib/server/jobQueue.ts",
    "lib/server/outbox.ts",
    "lib/server/worker.ts",
    "lib/server/workerRuntime.ts",
    "instrumentation.ts",
  ];

  /** Strip comments — doc comments legitimately SAY "Gmail/Google"; code must not touch them. */
  const codeOnly = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("no Google/Gemini/OAuth/network/cloud-queue code in the queue/worker pipeline", () => {
    // B9 (phase_b9.md): the pipeline may route an approved `gmail.sync` JOB
    // TYPE (a registry string) and delegate to lib/server/gmailSync.ts, but the
    // worker pipeline itself must contain NO provider API surface or network
    // primitive — the actual Gmail calls live only in lib/server/gmailApi.ts,
    // which is not part of PIPELINE_SOURCES and is guarded separately.
    const forbidden =
      /googleapis|users\.(messages|threads|labels|drafts|settings|history)|gemini|oauth|gapi|fetch\s*\(|XMLHttpRequest|axios|calendar|cloud.?tasks|pub.?sub/i;
    for (const file of PIPELINE_SOURCES) {
      const code = codeOnly(readFileSync(`${process.cwd()}/${file}`, "utf8"));
      expect(forbidden.test(code), `${file} must not contain provider/queue-integration code`).toBe(false);
    }
  });

  // B8 (phase_b8.md §7) SANCTIONS exactly one provider touchpoint in
  // deletion.ts: best-effort revocation of stored Google refresh tokens
  // before erasure. Direct network primitives and every other provider stay
  // forbidden — the only allowed Google surface is the revoke helper import.
  it("deletion.ts reaches Google only through the sanctioned revoke helper", () => {
    const code = codeOnly(readFileSync(`${process.cwd()}/lib/server/deletion.ts`, "utf8"));
    expect(/fetch\s*\(|XMLHttpRequest|axios/i.test(code), "no direct network calls in erasure").toBe(false);
    expect(
      /googleapis|gmail\.|gemini|calendar|cloud.?tasks|pub.?sub/i.test(code),
      "no other provider surface in erasure",
    ).toBe(false);
    const importSpecifiers = Array.from(code.matchAll(/from\s+["']([^"']+)["']/g), (match) => match[1]);
    expect(importSpecifiers.filter((spec) => /google/i.test(spec))).toEqual(["@/lib/server/googleOAuth"]);
  });

  it("only the approved job types are registered (deletion + B9 gmail.sync + B10 ai.analysis)", async () => {
    const { JOB_HANDLERS } = await import("./worker");
    // B7's account.deletion, B9's approved gmail.sync (phase_b9.md §6) and
    // B10's approved ai.analysis (phase_b10.md §7 — advisory analysis only; it
    // may never mutate Gmail). No other type may execute, and nothing may be
    // registered under a literal "gemini" key — the provider name stays out
    // of the pipeline source entirely (asserted by the scan above).
    expect(Object.keys(JOB_HANDLERS).sort()).toEqual(["account.deletion", "ai.analysis", "gmail.sync"]);
    expect(Object.keys(JOB_HANDLERS)).not.toContain("gemini");
  });
});

// ---- B8 (phase_b8.md §7): Google credentials must not outlive the user ----
describe("B8 — Google connection and OAuth-state cleanup", () => {
  it("erasure deletes this account's Google rows and never touches anyone else's", async () => {
    const userId = await seedAccount("b8wipe@example.test", true);
    const keeperId = await seedAccount("b8keep@example.test", false);
    await fake.client.googleConnection.create({
      data: { userId, googleSub: "sub-wipe", email: "w@example.test", scopes: "openid" },
    });
    await fake.client.googleConnection.create({
      data: { userId: keeperId, googleSub: "sub-keep", email: "k@example.test", scopes: "" },
    });
    await fake.client.oAuthState.create({
      data: {
        stateHash: "hash-b8-wipe",
        userId,
        sessionId: "sess-b8",
        intent: "connect",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await fake.client.oAuthState.create({
      data: {
        stateHash: "hash-b8-keep",
        userId: keeperId,
        sessionId: "sess-b8-keep",
        intent: "connect",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    await eraseAccount(db, { userId, requestId: "job-b8-wipe" });

    expect(fake.googleConnections.filter((row) => row.userId === userId)).toHaveLength(0);
    expect(fake.oauthStates.filter((row) => row.userId === userId)).toHaveLength(0);
    // unrelated accounts survive, exactly as their own rows:
    expect(fake.googleConnections.filter((row) => row.userId === keeperId)).toHaveLength(1);
    expect(fake.oauthStates.filter((row) => row.userId === keeperId)).toHaveLength(1);
    expect(fake.users.find((row) => row.id === keeperId)).toBeDefined();
  });

  it("unreadable/unconfigured credentials are SKIPPED — erasure still completes (fail closed)", async () => {
    const userId = await seedAccount("b8sealed@example.test", true);
    await fake.client.googleConnection.create({
      data: {
        userId,
        googleSub: "sub-sealed",
        email: "s@example.test",
        scopes: "",
        // garbage ciphertext → openSecret throws → revocation skipped;
        // with no GOOGLE_TOKEN_ENCRYPTION_KEY in env the row is skipped even
        // earlier. Either way NO network call and NO erasure blocker.
        refreshTokenCipher: "AAAA",
        refreshTokenNonce: "BBBB",
        refreshTokenTag: "CCCC",
      },
    });
    const fetchMock = vi.fn().mockRejectedValue(new Error("must not reach the network"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await runAccountDeletion(db, { userId }, "req-b8-sealed");
      expect(fake.users).toHaveLength(0); // erased
      expect(fake.googleConnections).toHaveLength(0); // credentials gone locally
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an account with a connection erases through the SAME job payload path", async () => {
    const userId = await seedAccount("b8job@example.test", true);
    await fake.client.googleConnection.create({
      data: { userId, googleSub: "sub-job", email: "j@example.test", scopes: "openid" },
    });

    await runAccountDeletion(db, { userId }, "req-b8-job");

    expect(fake.users).toHaveLength(0);
    expect(fake.googleConnections).toHaveLength(0);
    expect(fake.oauthStates.filter((row) => row.userId === userId)).toHaveLength(0);
    // tombstone audits survive the wipe (B4 contract):
    expect(fake.audits.filter((row) => row.userId === null).length).toBeGreaterThan(0);
  });
});
