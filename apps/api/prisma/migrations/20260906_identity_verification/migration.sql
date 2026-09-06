-- 본인확인 서비스 연동
--   nameHash            : 통신사 명의와 대조하기 위한 이름 해시
--   ciHash              : 연계정보 해시. 같은 사람의 중복 등록을 잡는다
--   identityVerifiedAt  : 본인확인을 통과한 시각
--
-- 전부 nullable 이다. 본인확인을 쓰지 않는 선거도 있고,
-- 기존 명부에는 이 값이 없기 때문이다.
ALTER TABLE "Voter" ADD COLUMN "nameHash" TEXT;
ALTER TABLE "Voter" ADD COLUMN "ciHash" TEXT;
ALTER TABLE "Voter" ADD COLUMN "identityVerifiedAt" TIMESTAMP(3);

-- NULL 은 서로 다른 값으로 취급되므로, 본인확인을 안 한 유권자끼리는 충돌하지 않는다.
CREATE UNIQUE INDEX "Voter_electionId_ciHash_key" ON "Voter"("electionId", "ciHash");
