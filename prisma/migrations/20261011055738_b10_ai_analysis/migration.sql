-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('queued', 'analyzing', 'ready', 'stale', 'limited', 'failed');

-- CreateEnum
CREATE TYPE "AiCategory" AS ENUM ('work', 'personal', 'finance', 'shopping', 'travel', 'notification', 'promotion', 'social', 'other');

-- CreateEnum
CREATE TYPE "AiPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateTable
CREATE TABLE "EmailAnalysis" (
    "id" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "googleConnectionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'queued',
    "contentFingerprint" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "modelId" TEXT NOT NULL DEFAULT '',
    "category" "AiCategory",
    "priority" "AiPriority",
    "summary" TEXT,
    "result" JSONB,
    "limited" BOOLEAN NOT NULL DEFAULT false,
    "usageConsumed" BOOLEAN NOT NULL DEFAULT false,
    "errorClass" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDailyUsage" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "dayUtc" TIMESTAMP(3) NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiDailyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailAnalysis_gmailMessageId_key" ON "EmailAnalysis"("gmailMessageId");

-- CreateIndex
CREATE INDEX "EmailAnalysis_googleConnectionId_idx" ON "EmailAnalysis"("googleConnectionId");

-- CreateIndex
CREATE INDEX "EmailAnalysis_profileId_status_idx" ON "EmailAnalysis"("profileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AiDailyUsage_profileId_dayUtc_key" ON "AiDailyUsage"("profileId", "dayUtc");

-- CreateIndex
CREATE UNIQUE INDEX "AiSettings_profileId_key" ON "AiSettings"("profileId");

-- AddForeignKey
ALTER TABLE "EmailAnalysis" ADD CONSTRAINT "EmailAnalysis_gmailMessageId_fkey" FOREIGN KEY ("gmailMessageId") REFERENCES "GmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAnalysis" ADD CONSTRAINT "EmailAnalysis_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PlayerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDailyUsage" ADD CONSTRAINT "AiDailyUsage_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PlayerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PlayerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
