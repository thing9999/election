/**
 * 앱 DB 계정의 권한이 실제로 깎여 있는지 확인한다.
 *
 *   npm run privilege:check --workspace=apps/api
 *
 * "권한을 뺐다"고 적어두는 것만으로는 아무것도 증명되지 않는다. 실제로 그 계정으로
 * 붙어서 **금지된 작업이 거부되는지**를 확인한다.
 *
 * 데이터를 건드리지 않는다 — 모든 시도가 존재할 수 없는 id 를 대상으로 하므로,
 * 설령 권한이 잘못 열려 있어도 지워지는 행이 없다.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const NOWHERE = "'00000000-0000-0000-0000-000000000000'";
let pass = 0, fail = 0;

const ok = (label: string, detail = '') => {
  pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ''}`);
};
const bad = (label: string, detail: string) => {
  fail++; console.log(`  \x1b[31m✗\x1b[0m ${label} \x1b[31m${detail}\x1b[0m`);
};

const isDenied = (e: unknown) =>
  /permission denied|42501|insufficient/i.test(JSON.stringify((e as any)?.meta ?? '') + String((e as Error).message));

async function main() {
  const appUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.DIRECT_URL;
  if (!appUrl) throw new Error('DATABASE_URL 이 없습니다.');

  console.log('\n\x1b[1mDB 권한 분리 검증\x1b[0m\n');

  if (appUrl === ownerUrl) {
    console.log('  \x1b[33m!\x1b[0m DATABASE_URL 과 DIRECT_URL 이 같습니다 — 아직 계정이 분리되지 않았습니다.');
    console.log('    npm run db:privileges --workspace=apps/api 를 먼저 실행하세요.\n');
    process.exit(1);
  }

  const db = new PrismaClient({ datasourceUrl: appUrl });
  const user: { current_user: string }[] = await db.$queryRawUnsafe('select current_user');
  console.log(`  접속 계정: \x1b[1m${user[0].current_user}\x1b[0m\n`);

  const allowed = async (label: string, sql: string, expectFk = false) => {
    try {
      await db.$executeRawUnsafe(sql);
      ok(label);
    } catch (e) {
      if (isDenied(e)) bad(label, '거부됨 — 앱이 동작하지 않습니다');
      else if (expectFk) ok(label, '권한 통과 (FK 제약에서 멈춤)');
      else bad(label, String((e as Error).message).slice(0, 90));
    }
  };

  const denied = async (label: string, sql: string) => {
    try {
      await db.$executeRawUnsafe(sql);
      bad(label, '허용됨 — 권한이 열려 있습니다');
    } catch (e) {
      if (isDenied(e)) ok(label);
      else bad(label, `다른 이유로 실패: ${String((e as Error).message).slice(0, 70)}`);
    }
  };

  console.log('\x1b[1m앱이 반드시 할 수 있어야 하는 것\x1b[0m');
  await allowed('표 조회', 'SELECT count(*) FROM "Ballot"');
  await allowed('명부 조회', 'SELECT count(*) FROM "Voter"');
  await allowed(
    '표 추가',
    `INSERT INTO "Ballot" (id, "electionId", "sealedVote", "castAtHour")
     VALUES (${NOWHERE}, ${NOWHERE}, '\x00'::bytea, now())`,
    true,
  );
  await allowed('투표 여부 갱신', `UPDATE "Voter" SET "hasVoted" = true WHERE id = ${NOWHERE}`);
  await allowed('감사 로그 기록',
    `INSERT INTO "AuditLog" ("action", "actorType") VALUES ('PRIV_CHECK', 'SYSTEM')`);

  console.log('\n\x1b[1m막혀 있어야 하는 것 — 표\x1b[0m');
  await denied('표 수정', `UPDATE "Ballot" SET "castAtHour" = now() WHERE id = ${NOWHERE}`);
  await denied('표 삭제', `DELETE FROM "Ballot" WHERE id = ${NOWHERE}`);

  console.log('\n\x1b[1m막혀 있어야 하는 것 — 흔적\x1b[0m');
  await denied('감사 로그 수정', `UPDATE "AuditLog" SET "action" = 'x' WHERE id = -1`);
  await denied('감사 로그 삭제', `DELETE FROM "AuditLog" WHERE id = -1`);
  await denied('체크포인트 수정', `UPDATE "Checkpoint" SET "hash" = 'x' WHERE id = ${NOWHERE}`);
  await denied('체크포인트 삭제', `DELETE FROM "Checkpoint" WHERE id = ${NOWHERE}`);
  await denied('외부 고정 기록 삭제', `DELETE FROM "Anchor" WHERE id = ${NOWHERE}`);

  console.log('\n\x1b[1m막혀 있어야 하는 것 — 그 외\x1b[0m');
  await denied('개표 결과 삭제', `DELETE FROM "TallyResult" WHERE id = ${NOWHERE}`);
  await denied('개표 승인 취소', `DELETE FROM "TallyApproval" WHERE id = ${NOWHERE}`);
  await denied('유권자 삭제', `DELETE FROM "Voter" WHERE id = ${NOWHERE}`);
  await denied('선거 삭제', `DELETE FROM "Election" WHERE id = ${NOWHERE}`);
  await denied('관리자 계정 생성',
    `INSERT INTO "AdminUser" (id, "loginId", "passwordHash", "name", "updatedAt")
     VALUES (${NOWHERE}, 'x', 'x', 'x', now())`);
  await denied('마이그레이션 기록 조회', 'SELECT count(*) FROM "_prisma_migrations"');

  // 테이블을 만들 수 있으면 트리거로 위 제약을 전부 우회할 수 있다.
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TABLE public.__privcheck_tmp (x int)');
      throw new Error('__rollback__');
    });
    bad('테이블 생성', '허용됨 — 트리거로 우회 가능합니다');
  } catch (e) {
    if (isDenied(e)) ok('테이블 생성');
    else if (String((e as Error).message).includes('__rollback__')) {
      bad('테이블 생성', '허용됨 — 트리거로 우회 가능합니다 (되돌림)');
    } else bad('테이블 생성', String((e as Error).message).slice(0, 70));
  }

  await db.$disconnect();
  console.log(`\n\x1b[1m${pass} 통과${fail ? `, \x1b[31m${fail} 실패` : ''}\x1b[0m\n`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
