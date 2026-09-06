/**
 * 앱 전용 DB 계정을 만들고 권한을 깎는다.
 *
 *   npm run db:privileges --workspace=apps/api
 *
 * ── 왜 필요한가 ──
 * 인증은 **밖에서 들어오는 사람**을 막는다. 이미 안에 있는 사람은 막지 않는다.
 * DB 쓰기 권한만 있으면 인증을 한 번도 통과하지 않고 표를 밀어넣거나, 감사 로그를
 * 지우거나, 체크포인트를 고쳐 덮을 수 있다. API 를 거치지 않으니 그 어떤 검증도
 * 실행되지 않는다.
 *
 * 그래서 서버가 쓰는 계정에서 **애초에 그 권한을 뺀다.** 투표는 INSERT 만 하면 되고
 * 개표는 SELECT 만 하면 된다. 앱 계정이 통째로 털려도 표를 고치거나 지울 수 없다.
 *
 * ── 한계 ──
 * 소유자 계정(DIRECT_URL)을 쥔 사람은 여전히 무엇이든 할 수 있다. 이건 공격 경로를
 * "DB 접근"에서 "소유자 계정 접근"으로 좁히는 것이지 없애는 게 아니다.
 * 소유자 자격증명은 앱 서버에 두지 말고 마이그레이션할 때만 꺼내 쓸 것.
 *
 * 스키마를 바꾼 뒤에는 **반드시 다시 실행**한다. 새로 만든 테이블에는 아무 권한도
 * 없는 상태로 시작하므로(fail closed), 실행하지 않으면 앱이 그 테이블을 못 읽는다.
 */
import 'dotenv/config';
import { randomBytes } from 'crypto';
import { ownerPrisma } from './owner-db';

const ROLE = process.env.APP_DB_ROLE ?? 'kma_app';

/**
 * 앱이 **실제로 하는** 쓰기만 열어준다.
 * 근거는 코드다 — 여기 없는 권한은 앱 어디에서도 쓰지 않는다는 뜻이다.
 */
const MATRIX: Record<string, { privs: string[]; why: string }> = {
  Election:      { privs: ['SELECT', 'INSERT', 'UPDATE'], why: '상태 전이(DRAFT→OPEN→CLOSED→TALLIED)' },
  Candidate:     { privs: ['SELECT', 'INSERT', 'DELETE'], why: 'DRAFT 에서 후보 명단 교체' },
  Voter:         { privs: ['SELECT', 'INSERT', 'UPDATE'], why: '명부 등록, OTP 상태, hasVoted' },
  Ballot:        { privs: ['SELECT', 'INSERT'],           why: '표는 넣기만 한다. 고치거나 지울 일이 없다' },
  TallyResult:   { privs: ['SELECT', 'INSERT'],           why: '개표는 한 번만 실행된다' },
  TallyApproval: { privs: ['SELECT', 'INSERT'],           why: '승인은 취소되지 않는다' },
  AuditLog:      { privs: ['SELECT', 'INSERT'],           why: '지울 수 있으면 감사 로그가 아니다' },
  Checkpoint:    { privs: ['SELECT', 'INSERT'],           why: '고칠 수 있으면 무결성 사슬이 아니다' },
  Anchor:        { privs: ['SELECT', 'INSERT'],           why: '외부 고정 기록도 append-only' },
  AdminUser:     { privs: ['SELECT', 'UPDATE'],           why: '로그인 상태만 갱신. 계정 생성은 CLI(소유자)' },
};

/** 앱이 건드릴 일이 없는 테이블 */
const NOT_FOR_APP = new Set(['_prisma_migrations']);

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

async function main() {
  const db = ownerPrisma();
  const password = process.env.APP_DB_PASSWORD ?? randomBytes(18).toString('base64url');
  const generated = !process.env.APP_DB_PASSWORD;

  // ── 스키마와 대조 — 빠뜨린 테이블이 있으면 여기서 멈춘다 ──
  const rows: { table_name: string }[] = await db.$queryRawUnsafe(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const actual = rows.map((r) => r.table_name).filter((t) => !NOT_FOR_APP.has(t));
  const unknown = actual.filter((t) => !(t in MATRIX));
  const missing = Object.keys(MATRIX).filter((t) => !actual.includes(t));

  if (unknown.length) {
    throw new Error(
      `권한을 정하지 않은 테이블이 있습니다: ${unknown.join(', ')}\n` +
        'scripts/db-privileges.ts 의 MATRIX 에 무슨 권한이 필요한지 적어주세요. ' +
        '모르는 채로 열어주지 않습니다.',
    );
  }
  if (missing.length) {
    throw new Error(
      `MATRIX 에는 있는데 DB 에 없는 테이블: ${missing.join(', ')}\n` +
        '먼저 마이그레이션을 적용하세요 (npm run prisma:deploy).',
    );
  }

  // ── 역할 ──
  const exists: { c: bigint }[] = await db.$queryRawUnsafe(
    `select count(*)::bigint as c from pg_roles where rolname = '${ROLE}'`,
  );
  const isNew = Number(exists[0].c) === 0;

  if (isNew) {
    await db.$executeRawUnsafe(`CREATE ROLE ${q(ROLE)} LOGIN PASSWORD '${password}'`);
    console.log(`역할 ${ROLE} 생성`);
  } else if (process.env.APP_DB_PASSWORD) {
    await db.$executeRawUnsafe(`ALTER ROLE ${q(ROLE)} PASSWORD '${password}'`);
    console.log(`역할 ${ROLE} 비밀번호 갱신`);
  } else {
    console.log(`역할 ${ROLE} 이미 존재 (비밀번호 유지)`);
  }

  // ── 스키마 ──
  // USAGE 는 주되 CREATE 는 주지 않는다. 앱이 테이블·함수를 만들 이유가 없고,
  // 만들 수 있으면 트리거로 우회할 수 있다.
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${q(ROLE)}`);
  await db.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM ${q(ROLE)}`);

  // ── 테이블 ──
  console.log('');
  for (const [table, { privs, why }] of Object.entries(MATRIX)) {
    await db.$executeRawUnsafe(`REVOKE ALL ON TABLE public.${q(table)} FROM ${q(ROLE)}`);
    await db.$executeRawUnsafe(
      `GRANT ${privs.join(', ')} ON TABLE public.${q(table)} TO ${q(ROLE)}`,
    );
    const denied = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].filter((p) => !privs.includes(p));
    const mark = denied.length ? `\x1b[31m-${denied.join(' -')}\x1b[0m` : '';
    console.log(
      `  ${table.padEnd(14)} ${privs.join(' ').padEnd(24)} ${mark.padEnd(30)} \x1b[2m${why}\x1b[0m`,
    );
  }
  for (const t of NOT_FOR_APP) {
    await db.$executeRawUnsafe(`REVOKE ALL ON TABLE public.${q(t)} FROM ${q(ROLE)}`);
  }

  // 시퀀스는 숫자만 내놓는다. INSERT 하려면 필요하다.
  await db.$executeRawUnsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${q(ROLE)}`);

  const host = (process.env.DIRECT_URL ?? '').replace(/^postgresql:\/\/[^@]*@/, '');
  console.log(`\n\x1b[1mDATABASE_URL 을 이 계정으로 바꾸세요\x1b[0m (DIRECT_URL 은 소유자 그대로 둡니다):`);
  console.log(`DATABASE_URL="postgresql://${ROLE}:${generated && !isNew ? '<기존 비밀번호>' : password}@${host}"`);
  if (generated && isNew) {
    console.log('\n\x1b[33m이 비밀번호는 다시 표시되지 않습니다.\x1b[0m ' +
      '고정하려면 APP_DB_PASSWORD 를 넣고 다시 실행하세요.');
  }
  console.log('\n확인:  npm run privilege:check --workspace=apps/api');

  await db.$disconnect();
}

main().catch((e) => {
  console.error(`\n\x1b[31m${(e as Error).message}\x1b[0m\n`);
  process.exit(1);
});
