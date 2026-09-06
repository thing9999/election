-- 생년월일 확인 추가.
--
-- 기존 행에는 채울 값이 없다(해시라 역산 불가). 빈 문자열을 넣으면 어떤 입력과도
-- 일치하지 않으므로 그 유권자는 로그인할 수 없게 된다 — 조용히 통과시키는 것보다
-- 안전한 실패다. 명부를 다시 등록해야 한다.
ALTER TABLE "Voter" ADD COLUMN "birthDateHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Voter" ALTER COLUMN "birthDateHash" DROP DEFAULT;
