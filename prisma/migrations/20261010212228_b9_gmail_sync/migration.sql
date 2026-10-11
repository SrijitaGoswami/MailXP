-- CreateEnum
CREATE TYPE "GmailSyncStatus" AS ENUM ('pending', 'running', 'synced', 'delayed', 'reconnect_required', 'error');

-- CreateTable
CREATE TABLE "GmailMessage" (
    "id" TEXT NOT NULL,
    "googleConnectionId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "gmailThreadId" TEXT,
    "internalDate" TIMESTAMP(3) NOT NULL,
    "sender" TEXT NOT NULL,
    "subject" TEXT,
    "snippet" TEXT,
    "bodyText" TEXT,
    "isUnread" BOOLEAN NOT NULL DEFAULT true,
    "labels" JSONB NOT NULL DEFAULT '[]',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GmailSyncState" (
    "id" TEXT NOT NULL,
    "googleConnectionId" TEXT NOT NULL,
    "status" "GmailSyncStatus" NOT NULL DEFAULT 'pending',
    "historyId" TEXT,
    "historyWindowDays" INTEGER NOT NULL DEFAULT 30,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "nextReconcileAt" TIMESTAMP(3),
    "lastErrorClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GmailSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GmailMessage_googleConnectionId_internalDate_idx" ON "GmailMessage"("googleConnectionId", "internalDate" DESC);

-- CreateIndex
CREATE INDEX "GmailMessage_googleConnectionId_isUnread_idx" ON "GmailMessage"("googleConnectionId", "isUnread");

-- CreateIndex
CREATE INDEX "GmailMessage_gmailThreadId_idx" ON "GmailMessage"("gmailThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "GmailMessage_googleConnectionId_gmailMessageId_key" ON "GmailMessage"("googleConnectionId", "gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "GmailSyncState_googleConnectionId_key" ON "GmailSyncState"("googleConnectionId");

-- AddForeignKey
ALTER TABLE "GmailMessage" ADD CONSTRAINT "GmailMessage_googleConnectionId_fkey" FOREIGN KEY ("googleConnectionId") REFERENCES "GoogleConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GmailSyncState" ADD CONSTRAINT "GmailSyncState_googleConnectionId_fkey" FOREIGN KEY ("googleConnectionId") REFERENCES "GoogleConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
