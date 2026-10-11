/**
 * Server-only Prisma client (Phase B3).
 *
 * - Prisma 7.10 + @prisma/adapter-pg: the adapter factory takes a pg pool
 *   config; PrismaClient receives it via `new PrismaClient({ adapter })`.
 * - LAZY construction on first use (getDb): environment is validated at the
 *   moment of first server use, so `next build` never fails on absent runtime
 *   secrets (phase_b3.md §4B).
 * - Single client reused across Next.js dev hot reloads via globalThis, so we
 *   never create a connection pool per request or per import.
 * - This module must never be imported by client components, React UI, game/
 *   or Phaser scenes (verified by a static-scan test and by bundling checks).
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadServerEnv } from "./env";

const globalForPrisma = globalThis as unknown as { __mailxpDb?: PrismaClient };

/** The shared application database client (constructed on first call). */
export function getDb(): PrismaClient {
  if (!globalForPrisma.__mailxpDb) {
    const { databaseUrl } = loadServerEnv(); // validates here, at first server use
    const adapter = new PrismaPg({ connectionString: databaseUrl });
    globalForPrisma.__mailxpDb = new PrismaClient({ adapter });
  }
  return globalForPrisma.__mailxpDb;
}
