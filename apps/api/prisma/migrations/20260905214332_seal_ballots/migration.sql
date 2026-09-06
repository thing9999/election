/*
  Warnings:

  - You are about to drop the column `candidateId` on the `Ballot` table. All the data in the column will be lost.
  - Added the required column `sealedVote` to the `Ballot` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Ballot" DROP CONSTRAINT "Ballot_candidateId_fkey";

-- DropIndex
DROP INDEX "Ballot_electionId_candidateId_idx";

-- AlterTable
ALTER TABLE "Ballot" DROP COLUMN "candidateId",
ADD COLUMN     "sealedVote" BYTEA NOT NULL;

-- AlterTable
ALTER TABLE "Election" ADD COLUMN     "ballotPublicKey" TEXT;

-- CreateTable
CREATE TABLE "TallyResult" (
    "id" TEXT NOT NULL,
    "electionId" TEXT NOT NULL,
    "candidateId" TEXT,
    "votes" INTEGER NOT NULL,

    CONSTRAINT "TallyResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TallyResult_electionId_idx" ON "TallyResult"("electionId");

-- CreateIndex
CREATE UNIQUE INDEX "TallyResult_electionId_candidateId_key" ON "TallyResult"("electionId", "candidateId");

-- CreateIndex
CREATE INDEX "Ballot_electionId_idx" ON "Ballot"("electionId");

-- AddForeignKey
ALTER TABLE "TallyResult" ADD CONSTRAINT "TallyResult_electionId_fkey" FOREIGN KEY ("electionId") REFERENCES "Election"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallyResult" ADD CONSTRAINT "TallyResult_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
