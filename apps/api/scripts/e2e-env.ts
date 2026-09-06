/**
 * 검증 환경을 통째로 잡고 돌린다.
 *
 *   npm run test:e2e     E2E 만
 *   npm run check        검증 5종 전부
 *
 * 하는 일:  사전 점검 → API 빌드·기동 → 시드 → 검증 → 정리
 * DB(`npm run db`) 말고는 아무것도 미리 띄워둘 필요가 없다.
 *
 * ── 왜 스크립트로 만드나 ──
 * 1) E2E 는 유권자 40명을 연속으로 인증한다. 운영 쓰로틀(IP 당 분당 30회)에서는
 *    반드시 429 가 난다. 그때마다 손으로 환경변수를 붙이면 언젠가 그 값이
 *    운영으로 새어 들어간다. 여기서만, 표시를 달고 완화한다.
 * 2) `nest start --watch` 는 자식 프로세스를 하나 더 띄워서, 부모만 죽이면
 *    포트 4000 을 잡은 좀비가 남는다. 그래서 빌드 후 단일 프로세스로 띄운다.
 * 3) 시드를 안 하고 돌리면 "유권자를 찾을 수 없다"로 죽는데, 원인이
 *    한눈에 안 보인다. 매번 새로 시드한다.
 */
import 'dotenv/config';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createConnection } from 'net';
import { existsSync, createWriteStream } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const PORT = Number(process.env.PORT ?? 4000);
const API_LOG = join(process.cwd(), '.e2e-api.log');
const SKIP_BUILD = process.argv.includes('--no-build');
const ALL = process.argv.includes('--all');

/** API 가 떠 있어야 도는 것들까지 포함한 전체 순서 */
const SUITE: { label: string; script: string }[] = [
  { label: 'DB 권한 분리', script: 'scripts/privilege-check.ts' },
  { label: '봉인 · 개표키 분산', script: 'scripts/crypto-check.ts' },
  { label: '변조 탐지', script: 'scripts/tamper-check.ts' },
  { label: '본인확인 · 완료문자 · 명부확정', script: 'scripts/identity-check.ts' },
  { label: '전 과정 E2E', script: 'scripts/e2e.ts' },
  { label: '관리자 화면 API', script: 'scripts/admin-flow-check.ts' },
  { label: '감사 로그 반출', script: 'scripts/audit-check.ts' },
  { label: '블록체인 고정', script: 'scripts/chain-check.ts' },
];

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  no: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const step = (n: string) => console.log(`\n${c.b(n)}`);
const die = (msg: string, hint?: string): never => {
  console.error(`\n${c.no('✗ ' + msg)}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
};

/** 포트가 이미 쓰이는지 */
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' })
      .on('connect', () => { s.destroy(); resolve(true); })
      .on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

/** 포트를 잡고 있는 프로세스를 트리째 죽인다 (좀비 방지) */
function killPort(port: number) {
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue |` +
      ` ForEach-Object { taskkill /PID $($_.OwningProcess) /T /F 2>$null }`,
    ], { stdio: 'ignore' });
  } else {
    spawnSync('sh', ['-c', `lsof -ti tcp:${port} | xargs -r kill -9`], { stdio: 'ignore' });
  }
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } });

async function waitForApi(timeoutMs = 90_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/elections/current`);
      if (r.status < 500) return true;
    } catch { /* 아직 안 떴다 */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

let api: ChildProcess | undefined;
function teardown() {
  if (api?.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(api.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-api.pid, 'SIGKILL'); } catch { try { api.kill('SIGKILL'); } catch {} }
    }
    api = undefined;
  }
  killPort(PORT); // 혹시 남았으면
}

async function main() {
  console.log(`\n${c.b('E2E 환경 준비')}`);

  // ── 1. 사전 점검 ──
  step('1. 사전 점검');

  if (!existsSync('.env')) {
    die('.env 가 없습니다.', 'cp apps/api/.env.example apps/api/.env 로 만들고 값을 채우세요.');
  }
  for (const k of ['VOTER_ID_PEPPER', 'JWT_SECRET']) {
    if (!process.env[k] || process.env[k]!.includes('생성한 값')) {
      die(`${k} 가 비어 있습니다.`, 'openssl rand -hex 32 로 만들어 .env 에 넣으세요.');
    }
  }
  if (!process.env.DIRECT_URL) die('DIRECT_URL 이 없습니다.', 'npm run db 가 출력한 값을 .env 에 넣으세요.');
  console.log(`  ${c.ok('✓')} .env`);

  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  try {
    await db.$queryRawUnsafe('select 1');
  } catch {
    die('DB 에 연결할 수 없습니다.',
      '다른 터미널에서 `npm run db` 를 먼저 띄우세요 (127.0.0.1:5433).');
  }
  console.log(`  ${c.ok('✓')} DB 연결`);

  const tables: { c: bigint }[] = await db.$queryRawUnsafe(
    `select count(*)::bigint as c from information_schema.tables
      where table_schema='public' and table_name='Ballot'`);
  if (Number(tables[0].c) === 0) {
    die('스키마가 적용되지 않았습니다.', 'npm run prisma:deploy --workspace=apps/api');
  }
  console.log(`  ${c.ok('✓')} 스키마`);
  await db.$disconnect();

  if (process.env.DATABASE_URL === process.env.DIRECT_URL) {
    console.log(`  ${c.warn('!')} DATABASE_URL 과 DIRECT_URL 이 같습니다 — DB 권한 분리가 안 된 상태입니다.`);
    console.log(`    ${c.dim('npm run db:privileges --workspace=apps/api (E2E 자체는 이대로도 돕니다)')}`);
  } else {
    console.log(`  ${c.ok('✓')} DB 계정 분리`);
  }

  if (await portBusy(PORT)) {
    console.log(`  ${c.warn('!')} 포트 ${PORT} 가 이미 사용 중 — 정리합니다.`);
    killPort(PORT);
    await new Promise((r) => setTimeout(r, 1500));
    if (await portBusy(PORT)) die(`포트 ${PORT} 를 비우지 못했습니다.`, '해당 프로세스를 직접 종료하세요.');
  }
  console.log(`  ${c.ok('✓')} 포트 ${PORT}`);

  // ── 2. 빌드 ──
  if (!SKIP_BUILD) {
    step('2. API 빌드');
    console.log(c.dim('  (--no-build 로 건너뛸 수 있습니다)'));
    if (run('npx', ['nest', 'build']).status !== 0) die('빌드 실패');
  } else {
    step('2. API 빌드 — 건너뜀');
    if (!existsSync(join('dist', 'main.js'))) die('dist/main.js 가 없습니다.', '--no-build 를 빼고 다시 실행하세요.');
  }

  // ── 3. 기동 ──
  step('3. API 기동');
  console.log(c.dim(`  로그: ${API_LOG}`));
  const log = createWriteStream(API_LOG, { flags: 'w' });
  api = spawn(process.execPath, [join('dist', 'main.js')], {
    env: {
      ...process.env,
      // 검증 전용. main.ts 가 이 값을 보고 경고를 띄운다.
      E2E_RELAXED_THROTTLE: '1',
      THROTTLE_GLOBAL: '1000000',
      THROTTLE_OTP_REQUEST: '1000000',
      THROTTLE_OTP_VERIFY: '1000000',
      THROTTLE_ADMIN_LOGIN: '1000000',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.pipe(log);
  api.stderr?.pipe(log);
  api.on('exit', (code) => {
    if (code !== null && code !== 0 && api) {
      console.error(c.no(`\nAPI 가 종료되었습니다 (code ${code}). 로그: ${API_LOG}`));
    }
  });

  if (!(await waitForApi())) {
    teardown();
    die('API 가 기동하지 않았습니다.', `로그를 확인하세요: ${API_LOG}`);
  }
  console.log(`  ${c.ok('✓')} http://localhost:${PORT}/api`);
  console.log(`  ${c.warn('!')} 쓰로틀이 검증용으로 완화되어 있습니다 (이 프로세스에서만)`);

  // ── 4. 시드 ──
  step('4. 시드 데이터');
  if (run('npx', ['ts-node', 'prisma/seed.ts']).status !== 0) {
    teardown();
    die('시드 실패');
  }

  // ── 5. 검증 ──
  const suite = ALL ? SUITE : SUITE.filter((x) => x.script.endsWith('e2e.ts'));
  step(`5. 검증 (${suite.length}종)`);

  const failed: string[] = [];
  for (const { label, script } of suite) {
    console.log(`\n${c.dim('──')} ${c.b(label)} ${c.dim('─'.repeat(Math.max(0, 40 - label.length)))}`);
    // 하나가 실패해도 나머지를 계속 돌린다 — 한 번에 전체 상태를 보는 게 낫다.
    if (run('npx', ['ts-node', script]).status !== 0) failed.push(label);
  }

  teardown();
  if (failed.length === 0) {
    console.log(`\n${c.ok(`전부 통과 (${suite.length}종)`)} ${c.dim('— API 는 정리되었습니다')}\n`);
    process.exit(0);
  }
  console.log(`\n${c.no(`실패: ${failed.join(', ')}`)} ${c.dim(`— API 로그: ${API_LOG}`)}\n`);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { console.log('\n중단 — 정리 중…'); teardown(); process.exit(130); });
}

main().catch((e) => { teardown(); console.error(e); process.exit(1); });
