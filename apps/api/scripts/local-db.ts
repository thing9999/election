/**
 * 로컬 개발용 PostgreSQL. 시스템에 설치하지 않고 node_modules 의 바이너리를 그대로 띄운다.
 *
 *   npm run db:local --workspace=apps/api
 *
 * 데이터는 apps/api/.pgdata 에만 쌓이므로, 지우고 싶으면 그 폴더만 삭제하면 된다.
 * 운영에는 절대 쓰지 않는다 — 백업도 이중화도 없다.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), '.pgdata');
const PORT = Number(process.env.LOCAL_DB_PORT ?? 5433); // 5432 는 기존 설치와 부딪힐 수 있어 피한다
const DB_NAME = 'kma_election';
const RESET = process.argv.includes('--reset');

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: true,
});

async function main() {
  if (RESET && existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log('기존 데이터 삭제');
  }

  if (!existsSync(DATA_DIR)) {
    console.log('데이터 디렉터리 초기화 중…');
    await pg.initialise();
  }

  await pg.start();
  console.log(`PostgreSQL 기동 (127.0.0.1:${PORT})`);

  try {
    await pg.createDatabase(DB_NAME);
    console.log(`데이터베이스 '${DB_NAME}' 생성`);
  } catch {
    console.log(`데이터베이스 '${DB_NAME}' 이미 존재`);
  }

  const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
  console.log('\n─────────────────────────────────────────────');
  console.log('.env 에 소유자 연결을 넣으세요 (로컬은 풀러가 없어 둘이 같습니다):');
  console.log(`DATABASE_URL="${url}"`);
  console.log(`DIRECT_URL="${url}"`);
  console.log('');
  console.log('그다음 앱 전용 계정을 만드세요 — 서버는 이 계정으로 돕니다:');
  console.log('  npm run prisma:deploy   --workspace=apps/api   (스키마 + 권한)');
  console.log('  ↳ 출력된 DATABASE_URL 로 .env 의 DATABASE_URL 만 교체합니다 (DIRECT_URL 은 그대로)');
  console.log('  npm run privilege:check --workspace=apps/api   (실제로 막혔는지 확인)');
  console.log('─────────────────────────────────────────────\n');
  console.log('Ctrl+C 로 종료합니다.');

  const stop = async () => {
    console.log('\n종료 중…');
    await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(async (e) => {
  console.error(e);
  await pg.stop().catch(() => {});
  process.exit(1);
});
