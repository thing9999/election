-- 휴대폰은 로그인 키다. 한 번호에 두 회원이 걸리면 그 폰을 쥔 사람이
-- 두 명 몫을 투표할 수 있으므로 회원마다 고유해야 한다.
CREATE UNIQUE INDEX "Voter_electionId_phoneHash_key" ON "Voter"("electionId", "phoneHash");
