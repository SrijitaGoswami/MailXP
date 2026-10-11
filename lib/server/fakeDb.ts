/**
 * TEST-ONLY in-memory stand-in for the Prisma client surface used by the B4
 * auth routes (Phase B4). NEVER imported by production code — only by the
 * route test suites under app/api/v1.
 *
 * It implements exactly the operations the routes perform (create / findUnique
 * / update / updateMany over users, sessions, tokens, profiles, audit rows,
 * plus a pass-through $transaction) with the same semantics a real PostgreSQL
 * run would show for these flows, including the P2002 unique-violation shape
 * on duplicate email. Real cryptography (bcryptjs, token hashing) still runs —
 * only the storage layer is faked, so these are MOCKED tests (the live
 * integration suite exercises the same flows against mailxp_dev).
 */

import type { PrismaClient } from "@prisma/client";

interface Row {
  [key: string]: unknown;
}

let autoId = 0;
function uuidish(prefix: string): string {
  autoId += 1;
  return `${prefix}-${String(autoId).padStart(6, "0")}`;
}

export interface FakeDb {
  users: Row[];
  profiles: Row[];
  sessions: Row[];
  tokens: Row[];
  audits: Row[];
  inventory: Row[];
  ledgers: Row[];
  idempotency: Row[];
  outboxEvents: Row[];
  jobs: Row[];
  googleConnections: Row[];
  oauthStates: Row[];
  gmailMessages: Row[];
  gmailSyncStates: Row[];
  emailAnalyses: Row[];
  aiDailyUsages: Row[];
  aiSettings: Row[];
  client: PrismaClient;
  reset(): void;
}

/** Supports top-level equality, OR groups, { lt/lte/gt/gte/in } and compound-key objects. */
function matchWhere(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR") {
      if (!Array.isArray(value) || !value.some((cond) => matchWhere(row, cond as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const cond = value as Record<string, unknown>;
      if ("lt" in cond) {
        if (!((row[key] as never) < (cond.lt as never))) return false;
        continue;
      }
      if ("lte" in cond) {
        if (!((row[key] as never) <= (cond.lte as never))) return false;
        continue;
      }
      if ("gt" in cond) {
        if (!((row[key] as never) > (cond.gt as never))) return false;
        continue;
      }
      if ("gte" in cond) {
        if (!((row[key] as never) >= (cond.gte as never))) return false;
        continue;
      }
      if ("in" in cond && Array.isArray(cond.in)) {
        if (!cond.in.includes(row[key])) return false;
        continue;
      }
      // Compound-key object (e.g. { profileId, endpoint, key } for
      // @@unique lookups): every inner entry must match the row. Dates
      // compare by instant (B10: AiDailyUsage's profileId_dayUtc key).
      if (!Object.values(cond).some((v) => v !== null && typeof v === "object" && !(v instanceof Date))) {
        const ok = Object.entries(cond).every(([k, v]) => {
          const cell = row[k];
          if (cell instanceof Date && v instanceof Date) return cell.getTime() === v.getTime();
          return cell === v;
        });
        if (!ok) return false;
        continue;
      }
    }
    if (row[key] instanceof Date && value instanceof Date) {
      if ((row[key] as Date).getTime() !== (value as Date).getTime()) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

/** Resolves Prisma atomic update forms ({ increment: n }, { decrement: n }). */
function resolveDataValue(current: unknown, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const op = value as { increment?: unknown; decrement?: unknown };
    const base = typeof current === "number" ? current : 0;
    if ("increment" in op) return base + Number(op.increment);
    if ("decrement" in op) return base - Number(op.decrement);
  }
  return value;
}

function applyUpdate(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    row[key] = resolveDataValue(row[key], value);
  }
  row.updatedAt = new Date();
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, string>>;
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, direction] = Object.entries(spec)[0] as [string, string];
      const av = a[key];
      const bv = b[key];
      if (av === bv) continue;
      const cmp = (av as never) < (bv as never) ? -1 : 1;
      return direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

/** Conditional deleteMany shared by B7 erasure and dependent-row cleanup. */
function deleteManyFrom(store: Row[], where: Record<string, unknown>): { count: number } {
  let count = 0;
  for (let i = store.length - 1; i >= 0; i -= 1) {
    if (matchWhere(store[i] as Row, where)) {
      store.splice(i, 1);
      count += 1;
    }
  }
  return { count };
}

/** Conditional updateMany that resolves atomic forms ({ increment: n }). */
function updateManyIn(store: Row[], where: Record<string, unknown>, data: Record<string, unknown>): { count: number } {
  let count = 0;
  for (const row of store) {
    if (matchWhere(row, where)) {
      applyUpdate(row, data);
      count += 1;
    }
  }
  return { count };
}

export function createFakeDb(): FakeDb {
  const fake: FakeDb = {
    users: [],
    profiles: [],
    sessions: [],
    tokens: [],
    audits: [],
    inventory: [],
    ledgers: [],
    idempotency: [],
    outboxEvents: [],
    jobs: [],
    googleConnections: [],
    oauthStates: [],
    gmailMessages: [],
    gmailSyncStates: [],
    emailAnalyses: [],
    aiDailyUsages: [],
    aiSettings: [],
    client: null as unknown as PrismaClient,
    reset() {
      fake.users.length = 0;
      fake.profiles.length = 0;
      fake.sessions.length = 0;
      fake.tokens.length = 0;
      fake.audits.length = 0;
      fake.inventory.length = 0;
      fake.ledgers.length = 0;
      fake.idempotency.length = 0;
      fake.outboxEvents.length = 0;
      fake.jobs.length = 0;
      fake.googleConnections.length = 0;
      fake.oauthStates.length = 0;
      fake.gmailMessages.length = 0;
      fake.gmailSyncStates.length = 0;
      fake.emailAnalyses.length = 0;
      fake.aiDailyUsages.length = 0;
      fake.aiSettings.length = 0;
    },
  };

  // Every mutable store — snapshotted before a $transaction runs and restored
  // if it throws, mirroring PostgreSQL's all-or-nothing rollback (B6 purchase
  // and reward flows depend on this being real; B7 erasure depends on it too).
  const allStores = () => [
    fake.users,
    fake.profiles,
    fake.sessions,
    fake.tokens,
    fake.audits,
    fake.inventory,
    fake.ledgers,
    fake.idempotency,
    fake.outboxEvents,
    fake.jobs,
    fake.googleConnections,
    fake.oauthStates,
    fake.gmailMessages,
    fake.gmailSyncStates,
    fake.emailAnalyses,
    fake.aiDailyUsages,
    fake.aiSettings,
  ];

  // Transactions are QUEUED, not interleaved: real PostgreSQL serializes
  // conflicting writers through row locks (the loser blocks until the winner
  // commits, then fails its conditional guard and rolls back ONLY its own
  // writes). Interleaving microtasks here would let a loser's snapshot-restore
  // wipe a winner's committed rows — the queue reproduces lock semantics.
  let txQueue: Promise<unknown> = Promise.resolve();

  const client = {
    async $transaction(fn: (tx: unknown) => Promise<unknown>): Promise<unknown> {
      const run = txQueue.then(async () => {
        const snapshot = allStores().map((store) => store.map((row) => ({ ...row })));
        try {
          return await fn(client);
        } catch (error) {
          for (const [index, store] of allStores().entries()) {
            store.length = 0;
            store.push(...snapshot[index].map((row) => ({ ...row })));
          }
          throw error;
        }
      });
      // A failed transaction must not poison the queue for the next one.
      txQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    user: {
      async create({ data }: { data: Row }) {
        if (fake.users.some((u) => u.email === data.email)) {
          throw { code: "P2002" }; // Prisma unique-violation shape
        }
        const now = new Date();
        const row: Row = {
          id: uuidish("user"),
          emailVerifiedAt: null,
          deletionRequestedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        fake.users.push(row);
        return row;
      },
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return fake.users.find((u) => matchWhere(u, where)) ?? null;
      },
      async update({ where, data }: { where: Record<string, unknown>; data: Row }) {
        const row = fake.users.find((u) => matchWhere(u, where));
        if (!row) throw { code: "P2025" };
        applyUpdate(row, data);
        return row;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        let count = 0;
        for (const row of fake.users) {
          if (matchWhere(row, where)) {
            Object.assign(row, data, { updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      },
      // B7 erasure: the user row goes last; P2025 if absent (real Prisma).
      async delete({ where }: { where: Record<string, unknown> }) {
        const index = fake.users.findIndex((u) => matchWhere(u, where));
        if (index === -1) throw { code: "P2025" };
        return fake.users.splice(index, 1)[0];
      },
    },

    playerProfile: {
      async create({ data }: { data: Row }) {
        const now = new Date();
        const row: Row = {
          id: uuidish("profile"),
          draftCoin: 0,
          xp: 0,
          level: 1,
          stats: { mailCount: 0 },
          equippedOutfit: "worker",
          placedDecor: "[]",
          version: 1,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        fake.profiles.push(row);
        return row;
      },
      async findUnique({
        where,
        include,
        select,
      }: {
        where: Record<string, unknown>;
        include?: { inventoryItems?: boolean };
        select?: Record<string, boolean>;
      }) {
        const row = fake.profiles.find((p) => matchWhere(p, where)) ?? null;
        if (!row) return null;
        if (select) {
          const picked: Row = {};
          for (const [key, on] of Object.entries(select)) if (on) picked[key] = row[key];
          return picked;
        }
        if (include?.inventoryItems) {
          return {
            ...row,
            inventoryItems: fake.inventory
              .filter((item) => item.profileId === row.id)
              .sort((a, b) => {
                const at = (a.ownedSince as Date).getTime();
                const bt = (b.ownedSince as Date).getTime();
                return at - bt;
              }),
          };
        }
        return row;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        let count = 0;
        for (const row of fake.profiles) {
          if (matchWhere(row, where)) {
            applyUpdate(row, data);
            count += 1;
          }
        }
        return { count };
      },
      // B7 erasure: dependent rows are deleted by the service first (explicit
      // order stands in for PostgreSQL cascade behavior).
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.profiles, where);
      },
    },

    inventoryItem: {
      async create({ data }: { data: Row }) {
        // Composite PK [profileId, itemId] — a duplicate grant is impossible.
        if (
          fake.inventory.some(
            (item) => item.profileId === data.profileId && item.itemId === data.itemId,
          )
        ) {
          throw { code: "P2002" };
        }
        const row: Row = { ownedSince: new Date(), ...data };
        fake.inventory.push(row);
        return row;
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.inventory, where);
      },
    },

    ledgerEntry: {
      async create({ data }: { data: Row }) {
        const row: Row = { id: uuidish("led"), sourceRef: null, createdAt: new Date(), ...data };
        fake.ledgers.push(row);
        return row;
      },
      async findMany({
        where,
        orderBy,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) {
        let rows = fake.ledgers.filter((row) => (where ? matchWhere(row, where) : true));
        rows = sortRows(rows, orderBy);
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      // Daily-cap aggregation (B6 economy): _sum over a filtered set.
      async aggregate({
        where,
      }: {
        where?: Record<string, unknown>;
        _sum?: { amount?: boolean };
      }) {
        const rows = fake.ledgers.filter((row) => (where ? matchWhere(row, where) : true));
        const amount = rows.reduce(
          (sum, row) => sum + (typeof row.amount === "number" ? row.amount : 0),
          0,
        );
        // Prisma shape: null when no rows matched.
        return { _sum: { amount: rows.length > 0 ? amount : null } };
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.ledgers, where);
      },
    },

    session: {
      async create({ data }: { data: Row }) {
        const now = new Date();
        const row: Row = { id: uuidish("sess"), revokedAt: null, createdAt: now, ...data };
        fake.sessions.push(row);
        return row;
      },
      async findUnique({ where, include }: { where: Record<string, unknown>; include?: { user?: boolean } }) {
        const row = fake.sessions.find((s) => matchWhere(s, where)) ?? null;
        if (!row) return null;
        if (include?.user) {
          return { ...row, user: fake.users.find((u) => u.id === row.userId) ?? null };
        }
        return row;
      },
      async update({ where, data, include }: { where: Record<string, unknown>; data: Row; include?: unknown }) {
        const row = fake.sessions.find((s) => matchWhere(s, where));
        if (!row) throw { code: "P2025" };
        applyUpdate(row, data);
        if (include) {
          const user = fake.users.find((u) => u.id === row.userId) ?? null;
          return { ...row, user };
        }
        return row;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        let count = 0;
        for (const row of fake.sessions) {
          if (matchWhere(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.sessions, where);
      },
    },

    authToken: {
      async create({ data }: { data: Row }) {
        const now = new Date();
        const row: Row = { id: uuidish("tok"), consumedAt: null, createdAt: now, ...data };
        fake.tokens.push(row);
        return row;
      },
      async findUnique({ where, include }: { where: Record<string, unknown>; include?: { user?: boolean } }) {
        const row = fake.tokens.find((t) => matchWhere(t, where)) ?? null;
        if (!row) return null;
        if (include?.user) {
          return { ...row, user: fake.users.find((u) => u.id === row.userId) ?? null };
        }
        return row;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        let count = 0;
        for (const row of fake.tokens) {
          if (matchWhere(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.tokens, where);
      },
    },

    auditEvent: {
      async create({ data }: { data: Row }) {
        const row: Row = { id: uuidish("aud"), meta: null, createdAt: new Date(), ...data };
        fake.audits.push(row);
        return row;
      },
      // B7: explicit tombstoning (mirrors AuditEvent ON DELETE SET NULL so the
      // fake matches real PostgreSQL after account erasure).
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        let count = 0;
        for (const row of fake.audits) {
          if (matchWhere(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },

    // B6: durable idempotency (contract §1.6). @@unique([profileId, endpoint,
    // key]) is enforced here as a P2002 on create — the same database-level
    // duplicate guard the real table provides.
    idempotencyRecord: {
      async create({ data }: { data: Row }) {
        const dup = fake.idempotency.some(
          (rec) =>
            rec.profileId === data.profileId &&
            rec.endpoint === data.endpoint &&
            rec.key === data.key,
        );
        if (dup) throw { code: "P2002" };
        const row: Row = {
          id: uuidish("idem"),
          httpStatus: null,
          summary: null,
          createdAt: new Date(),
          ...data,
        };
        fake.idempotency.push(row);
        return row;
      },
      async findUnique({
        where,
      }: {
        where: { profileId_endpoint_key?: Record<string, unknown> } & Record<string, unknown>;
      }) {
        // Compound-key where shape resolves through the shared matcher.
        return fake.idempotency.find((rec) => matchWhere(rec, where)) ?? null;
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Row;
      }) {
        let count = 0;
        for (const row of fake.idempotency) {
          if (matchWhere(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        let count = 0;
        for (let i = fake.idempotency.length - 1; i >= 0; i -= 1) {
          if (matchWhere(fake.idempotency[i], where)) {
            fake.idempotency.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      },
    },

    // ---- Phase B7: transactional outbox (phase_b7.md §4) --------------------
    outboxEvent: {
      async create({ data }: { data: Row }) {
        const now = new Date();
        const row: Row = {
          id: uuidish("obx"),
          payload: null,
          eventVersion: 1,
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
          lastErrorClass: null,
          createdAt: now,
          publishedAt: null,
          ...data,
        };
        fake.outboxEvents.push(row);
        return row;
      },
      async findMany({
        where,
        orderBy,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) {
        let rows = fake.outboxEvents.filter((row) => (where ? matchWhere(row, where) : true));
        rows = sortRows(rows, orderBy);
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      async update({ where, data }: { where: Record<string, unknown>; data: Row }) {
        const row = fake.outboxEvents.find((ev) => matchWhere(ev, where));
        if (!row) throw { code: "P2025" };
        Object.assign(row, data); // outbox has no @updatedAt column in schema
        return row;
      },
    },

    // ---- Phase B7: database-backed job queue (phase_b7.md §5) ---------------
    // Unique indexes: dedupeKey and outboxEventId both collide as P2002 — the
    // same database-level guard the real tables provide, so concurrent
    // enqueues and outbox relays can never create duplicate jobs.
    job: {
      async create({ data }: { data: Row }) {
        if (
          data.dedupeKey !== null &&
          data.dedupeKey !== undefined &&
          fake.jobs.some((j) => j.dedupeKey === data.dedupeKey)
        ) {
          throw { code: "P2002" };
        }
        if (
          data.outboxEventId !== null &&
          data.outboxEventId !== undefined &&
          fake.jobs.some((j) => j.outboxEventId === data.outboxEventId)
        ) {
          throw { code: "P2002" };
        }
        const now = new Date();
        const row: Row = {
          id: uuidish("job"),
          payload: null,
          status: "pending",
          dedupeKey: null,
          outboxEventId: null,
          attempts: 0,
          maxAttempts: 5,
          availableAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          startedAt: null,
          finishedAt: null,
          lastErrorClass: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        fake.jobs.push(row);
        return row;
      },
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return fake.jobs.find((job) => matchWhere(job, where)) ?? null;
      },
      async findMany({
        where,
        orderBy,
        take,
        select,
      }: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
        select?: Record<string, boolean>;
      }) {
        let rows = fake.jobs.filter((job) => matchWhere(job, where));
        rows = sortRows(rows, orderBy);
        if (typeof take === "number") rows = rows.slice(0, take);
        if (select) {
          return rows.map((row) => {
            const picked: Row = {};
            for (const [key, on] of Object.entries(select)) if (on) picked[key] = row[key];
            return picked;
          });
        }
        return rows.map((row) => ({ ...row }));
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        return updateManyIn(fake.jobs, where, data);
      },
    },

    // ---- Phase B8: Google connection + OAuth state --------------------------
    // googleSub unique is enforced as P2002 on create — the same database
    // guard the real table provides (one identity can never link twice).
    googleConnection: {
      async create({ data }: { data: Row }) {
        if (fake.googleConnections.some((row) => row.googleSub === data.googleSub)) {
          throw { code: "P2002" };
        }
        // B8b partial unique index: at most ONE connected row per user
        // (mirrors GoogleConnection_userId_connected_key ... WHERE status='connected').
        if (
          (data.status ?? "connected") === "connected" &&
          fake.googleConnections.some(
            (row) => row.userId === data.userId && row.status === "connected",
          )
        ) {
          throw { code: "P2002" };
        }
        const now = new Date();
        const row: Row = {
          id: uuidish("gcon"),
          status: "connected",
          scopes: "",
          refreshTokenCipher: null,
          refreshTokenNonce: null,
          refreshTokenTag: null,
          refreshTokenKeyVersion: 1,
          connectedAt: now,
          updatedAt: now,
          ...data,
        };
        fake.googleConnections.push(row);
        return row;
      },
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return fake.googleConnections.find((row) => matchWhere(row, where)) ?? null;
      },
      async findFirst({ where }: { where?: Record<string, unknown> }) {
        return fake.googleConnections.find((row) => (where ? matchWhere(row, where) : true)) ?? null;
      },
      async findMany({
        where,
        orderBy,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) {
        const rows = fake.googleConnections.filter((row) => (where ? matchWhere(row, where) : true));
        const sorted = sortRows(rows, orderBy);
        const list = typeof take === "number" ? sorted.slice(0, take) : sorted;
        return list.map((row) => ({ ...row }));
      },
      async update({ where, data }: { where: Record<string, unknown>; data: Row }) {
        const row = fake.googleConnections.find((r) => matchWhere(r, where));
        if (!row) throw { code: "P2025" };
        applyUpdate(row, data);
        return row;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        return updateManyIn(fake.googleConnections, where, data);
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.googleConnections, where);
      },
    },

    // Prisma exposes model OAuthState as `oAuthState` (first letter lowered).
    oAuthState: {
      async create({ data }: { data: Row }) {
        if (fake.oauthStates.some((row) => row.stateHash === data.stateHash)) {
          throw { code: "P2002" };
        }
        const row: Row = { id: uuidish("ostate"), consumedAt: null, createdAt: new Date(), ...data };
        fake.oauthStates.push(row);
        return row;
      },
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return fake.oauthStates.find((row) => matchWhere(row, where)) ?? null;
      },
      async findMany({
        where,
        orderBy,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) {
        let rows = fake.oauthStates.filter((row) => (where ? matchWhere(row, where) : true));
        rows = sortRows(rows, orderBy);
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        return updateManyIn(fake.oauthStates, where, data);
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.oauthStates, where);
      },
    },

    // ---- B9 Gmail sync ------------------------------------------------------
    gmailMessage: {
      async create({ data }: { data: Row }) {
        const row: Row = {
          id: uuidish("gmsg"),
          syncedAt: new Date(),
          labels: [],
          attachments: [],
          isUnread: true,
          ...data,
        };
        fake.gmailMessages.push(row);
        return row;
      },
      async upsert({
        where,
        create,
        update,
      }: {
        where: { googleConnectionId_gmailMessageId: { googleConnectionId: string; gmailMessageId: string } };
        create: Row;
        update: Row;
      }) {
        const key = where.googleConnectionId_gmailMessageId;
        const existing = fake.gmailMessages.find(
          (row) => row.googleConnectionId === key.googleConnectionId && row.gmailMessageId === key.gmailMessageId,
        );
        if (existing) {
          applyUpdate(existing, update);
          existing.syncedAt = new Date();
          return existing;
        }
        const row: Row = { id: uuidish("gmsg"), syncedAt: new Date(), labels: [], attachments: [], isUnread: true, ...create };
        fake.gmailMessages.push(row);
        return row;
      },
      async findUnique({
        where,
        include,
      }: {
        where: Record<string, unknown>;
        include?: { googleConnection?: { select?: { id?: boolean; userId?: boolean; status?: boolean } } };
      }) {
        const row = fake.gmailMessages.find((r) => matchWhere(r, where));
        if (!row) return null;
        if (!include?.googleConnection) return row;
        const conn = fake.googleConnections.find((c) => c.id === row.googleConnectionId) ?? null;
        const select = include.googleConnection.select;
        const picked =
          conn && select
            ? {
                ...(select.id ? { id: conn.id } : {}),
                ...(select.userId ? { userId: conn.userId } : {}),
                ...(select.status ? { status: conn.status } : {}),
              }
            : conn;
        return { ...row, googleConnection: picked };
      },
      async findFirst({ where }: { where?: Record<string, unknown> }) {
        return fake.gmailMessages.find((row) => (where ? matchWhere(row, where) : true)) ?? null;
      },
      async findMany({
        where,
        orderBy,
        take,
        skip,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
        skip?: number;
      }) {
        let rows = fake.gmailMessages.filter((row) => (where ? matchWhere(row, where) : true));
        rows = sortRows(rows, orderBy);
        if (typeof skip === "number") rows = rows.slice(skip);
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      async count({ where }: { where?: Record<string, unknown> }) {
        return fake.gmailMessages.filter((row) => (where ? matchWhere(row, where) : true)).length;
      },
      async update({ where, data }: { where: Record<string, unknown>; data: Row }) {
        const row = fake.gmailMessages.find((r) => matchWhere(r, where));
        if (!row) throw { code: "P2025" };
        applyUpdate(row, data);
        return row;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        return updateManyIn(fake.gmailMessages, where, data);
      },
      async delete({ where }: { where: Record<string, unknown> }) {
        const index = fake.gmailMessages.findIndex((r) => matchWhere(r, where));
        if (index === -1) throw { code: "P2025" };
        const [row] = fake.gmailMessages.splice(index, 1);
        return row;
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.gmailMessages, where);
      },
    },

    gmailSyncState: {
      async create({ data }: { data: Row }) {
        const now = new Date();
        const row: Row = {
          id: uuidish("gsync"),
          status: "pending",
          historyId: null,
          historyWindowDays: 30,
          lastSyncedAt: null,
          lastSuccessAt: null,
          nextReconcileAt: null,
          lastErrorClass: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        fake.gmailSyncStates.push(row);
        return row;
      },
      async upsert({
        where,
        create,
        update,
      }: {
        where: { googleConnectionId: string };
        create: Row;
        update: Row;
      }) {
        const existing = fake.gmailSyncStates.find((row) => row.googleConnectionId === where.googleConnectionId);
        if (existing) {
          applyUpdate(existing, update);
          existing.updatedAt = new Date();
          return existing;
        }
        const now = new Date();
        const row: Row = {
          id: uuidish("gsync"),
          status: "pending",
          historyId: null,
          historyWindowDays: 30,
          lastSyncedAt: null,
          lastSuccessAt: null,
          nextReconcileAt: null,
          lastErrorClass: null,
          createdAt: now,
          updatedAt: now,
          googleConnectionId: where.googleConnectionId,
          ...create,
        };
        fake.gmailSyncStates.push(row);
        return row;
      },
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return fake.gmailSyncStates.find((row) => matchWhere(row, where)) ?? null;
      },
      async findFirst({ where }: { where?: Record<string, unknown> }) {
        return fake.gmailSyncStates.find((row) => (where ? matchWhere(row, where) : true)) ?? null;
      },
      async findMany({
        where,
        orderBy,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) {
        let rows = fake.gmailSyncStates.filter((row) => (where ? matchWhere(row, where) : true));
        rows = sortRows(rows, orderBy);
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      async update({ where, data }: { where: Record<string, unknown>; data: Row }) {
        const row = fake.gmailSyncStates.find((r) => matchWhere(r, where));
        if (!row) throw { code: "P2025" };
        applyUpdate(row, data);
        row.updatedAt = new Date();
        return row;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        return updateManyIn(fake.gmailSyncStates, where, data);
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.gmailSyncStates, where);
      },
    },

    // ---- Phase B10: AI analysis / daily usage / pause settings ---------------

    emailAnalysis: {
      async create({ data }: { data: Row }) {
        const now = new Date();
        const row: Row = {
          id: uuidish("ana"),
          status: "queued",
          category: null,
          priority: null,
          summary: null,
          result: null,
          limited: false,
          usageConsumed: false,
          errorClass: null,
          queuedAt: now,
          analyzedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        if (fake.emailAnalyses.some((r) => r.gmailMessageId === row.gmailMessageId)) {
          throw { code: "P2002" };
        }
        fake.emailAnalyses.push(row);
        return row;
      },
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return fake.emailAnalyses.find((row) => matchWhere(row, where)) ?? null;
      },
      async findFirst({ where }: { where: Record<string, unknown> }) {
        return fake.emailAnalyses.find((row) => matchWhere(row, where)) ?? null;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        return updateManyIn(fake.emailAnalyses, where, data);
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.emailAnalyses, where);
      },
    },

    aiDailyUsage: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return fake.aiDailyUsages.find((row) => matchWhere(row, where)) ?? null;
      },
      async upsert({
        where,
        create,
        update,
      }: {
        where: { profileId_dayUtc: { profileId: string; dayUtc: Date } };
        create: Row;
        update: Row;
      }) {
        const key = where.profileId_dayUtc;
        const existing = fake.aiDailyUsages.find(
          (row) =>
            row.profileId === key.profileId &&
            row.dayUtc instanceof Date &&
            key.dayUtc instanceof Date &&
            row.dayUtc.getTime() === key.dayUtc.getTime(),
        );
        if (existing) {
          applyUpdate(existing, update);
          existing.updatedAt = new Date();
          return existing;
        }
        const now = new Date();
        const row: Row = { id: uuidish("usage"), units: 0, createdAt: now, updatedAt: now, ...create };
        fake.aiDailyUsages.push(row);
        return row;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        return updateManyIn(fake.aiDailyUsages, where, data);
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.aiDailyUsages, where);
      },
    },

    aiSettings: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return fake.aiSettings.find((row) => matchWhere(row, where)) ?? null;
      },
      async upsert({
        where,
        create,
        update,
      }: {
        where: { profileId: string };
        create: Row;
        update: Row;
      }) {
        const existing = fake.aiSettings.find((row) => row.profileId === where.profileId);
        if (existing) {
          applyUpdate(existing, update);
          existing.updatedAt = new Date();
          return existing;
        }
        const now = new Date();
        const row: Row = { id: uuidish("aiset"), paused: false, createdAt: now, updatedAt: now, ...create };
        fake.aiSettings.push(row);
        return row;
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        return deleteManyFrom(fake.aiSettings, where);
      },
    },
  };

  fake.client = client as unknown as PrismaClient;
  return fake;
}
