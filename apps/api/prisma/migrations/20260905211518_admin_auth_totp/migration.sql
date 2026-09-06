/*
  Warnings:

  - The `role` column on the `AdminUser` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `updatedAt` to the `AdminUser` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('COMMISSIONER', 'AUDITOR');

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "failedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "lastTotpStep" BIGINT,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "totpConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
DROP COLUMN "role",
ADD COLUMN     "role" "AdminRole" NOT NULL DEFAULT 'COMMISSIONER';

-- CreateTable
CREATE TABLE "TallyApproval" (
    "id" TEXT NOT NULL,
    "electionId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TallyApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TallyApproval_electionId_idx" ON "TallyApproval"("electionId");

-- CreateIndex
CREATE UNIQUE INDEX "TallyApproval_electionId_adminId_key" ON "TallyApproval"("electionId", "adminId");

-- AddForeignKey
ALTER TABLE "TallyApproval" ADD CONSTRAINT "TallyApproval_electionId_fkey" FOREIGN KEY ("electionId") REFERENCES "Election"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallyApproval" ADD CONSTRAINT "TallyApproval_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
