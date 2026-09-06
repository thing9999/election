import { PrismaClient } from '@prisma/client';

/**
 * 운영자 도구용 DB 연결.
 *
 * 서버(NestJS)는 권한을 깎은 계정(DATABASE_URL)으로 돈다 — 표를 넣을 수는 있어도
 * 고치거나 지울 수는 없다. 반면 여기 스크립트들은 명부 시딩, 관리자 계정 생성,
 * 공격자 흉내내기처럼 **그 제약 밖의 일**을 하는 도구다.
 *
 * 그래서 소유자 계정(DIRECT_URL)으로 붙는다. 이건 권한 분리를 우회하는 게 아니라
 * 모델링하는 것이다 — 실제로도 이 스크립트들은 서버 접근 권한이 있는 사람만 돌린다.
 */
export function ownerPrisma(): PrismaClient {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DIRECT_URL(또는 DATABASE_URL)이 .env 에 없습니다.');
  }
  return new PrismaClient({ datasourceUrl: url });
}
