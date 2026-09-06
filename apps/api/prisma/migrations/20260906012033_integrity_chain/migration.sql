-- 무결성 체크포인트 사슬.
-- DB 쓰기 권한만으로 표·결과·명부를 고칠 수 있다는 문제를 막기 위해,
-- 각 단계의 상태를 해시로 굳히고 체크포인트끼리 이전 해시를 물린다.

CREATE TYPE "CheckpointKind" AS ENUM ('ROSTER_SEALED', 'BALLOTS', 'FINAL', 'RESULTS');

CREATE TABLE "Checkpoint" (
    "id" TEXT NOT NULL,
    "electionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "CheckpointKind" NOT NULL,
    "ballotCount" INTEGER NOT NULL,
    "merkleRoot" TEXT NOT NULL,
    "rosterHash" TEXT,
    "resultsHash" TEXT,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Checkpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Anchor" (
    "id" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "detail" JSONB,
    "anchoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Anchor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Checkpoint_electionId_seq_key" ON "Checkpoint"("electionId", "seq");
CREATE INDEX "Checkpoint_electionId_createdAt_idx" ON "Checkpoint"("electionId", "createdAt");
CREATE INDEX "Anchor_checkpointId_idx" ON "Anchor"("checkpointId");

ALTER TABLE "Checkpoint" ADD CONSTRAINT "Checkpoint_electionId_fkey"
    FOREIGN KEY ("electionId") REFERENCES "Election"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Anchor" ADD CONSTRAINT "Anchor_checkpointId_fkey"
    FOREIGN KEY ("checkpointId") REFERENCES "Checkpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
