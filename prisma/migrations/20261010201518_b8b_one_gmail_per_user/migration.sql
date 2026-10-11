-- B8b: one connected Google mailbox per MailXP user (phase_b8b.md §5).
--
-- Reviewed raw SQL (Prisma cannot express a partial unique index in the
-- datamodel; this is the documented, reviewed exception the spec allows).
-- Purely additive: one CREATE INDEX CONCURRENTLY — no ALTER/DROP/DELETE on
-- any existing object; all prior tables/indexes stay byte-identical.
--
-- The invariant: a user may have ANY number of released (historical) rows,
-- but at most ONE row with status='connected'. Together with the existing
-- UNIQUE(googleSub) (one Google identity -> one user, ever) this yields:
--   connected mailbox graph is a partial injective mapping.
--
-- A plain (transactional) CREATE UNIQUE INDEX is used rather than
-- CONCURRENTLY: the GoogleConnection table is empty at apply time (all rows
-- were released in the approved B8b cleanup), so there is nothing to lock,
-- and it keeps the migration inside Prisma's normal transaction.

-- CreateIndex
CREATE UNIQUE INDEX "GoogleConnection_userId_connected_key"
  ON "GoogleConnection"("userId")
  WHERE status = 'connected';
