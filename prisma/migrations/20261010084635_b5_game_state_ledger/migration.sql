-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('quest_reward', 'purchase', 'adjustment');

-- AlterTable
ALTER TABLE "PlayerProfile" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "stats" JSONB NOT NULL DEFAULT '{"mailCount":0}',
ADD COLUMN     "xp" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerEntry_profileId_createdAt_id_idx" ON "LedgerEntry"("profileId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PlayerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
