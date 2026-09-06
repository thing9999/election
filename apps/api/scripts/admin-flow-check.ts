/**
 * 관리자 화면이 실제로 쓰는 API 경로를 그대로 밟아본다.
 *   npm run admin:check --workspace=apps/api
 *
 * 선거 생성 → 명부 등록 → 개시 → 마감 → 2인 승인 개표 → 결과.
 * 화면 없이 API 만으로 전 과정이 도는지 확인하는 용도다.
 */
import 'dotenv/config';
import { ownerPrisma } from './owner-db';
import { generateSync as totpGenerate, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';

const BASE = process.env.E2E_BASE ?? 'http://localhost:4000/api';
const TOTP = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
const prisma = ownerPrisma();

const PW: Record<string, string> = {
  wi1: 'e2e-commissioner-1-pw',
  wi2: 'e2e-commissioner-2-pw',
  gam1: 'e2e-auditor-1-pw',
};

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label} \x1b[31m${detail}\x1b[0m`); }
};

async function call(path: string, init: RequestInit = {}, bearer?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/**
 * TOTP 는 같은 30초 슬롯의 코드를 두 번 받지 않는다(재사용 방지, 의도된 동작).
 * 스크립트를 연달아 돌리면 여기 걸리므로, 걸리면 다음 슬롯까지 기다렸다 한 번 재시도한다.
 */
async function waitForNextTotpStep(): Promise<void> {
  const ms = 30_000 - (Date.now() % 30_000) + 1_000;
  console.log(`  다음 인증번호가 생성될 때까지 ${Math.ceil(ms / 1000)}초 대기…`);
  await new Promise((r) => setTimeout(r, ms));
}

async function login(loginId: string): Promise<string> {
  const s1 = await call('/admin/auth/login', {
    method: 'POST', body: JSON.stringify({ loginId, password: PW[loginId] }),
  });
  if (!s1.body?.pendingToken) throw new Error(`로그인 실패(${s1.status}): ${JSON.stringify(s1.body)}`);

  let secret = (await prisma.adminUser.findUnique({ where: { loginId } }))?.totpSecret;
  if (!s1.body.totpRegistered) {
    secret = (await call('/admin/auth/totp/enroll', { method: 'POST' }, s1.body.pendingToken)).body.secret;
  }
  const verify = () => call('/admin/auth/totp/verify', {
    method: 'POST', body: JSON.stringify({ code: totpGenerate({ ...TOTP, secret: secret! }) }),
  }, s1.body.pendingToken);

  let s2 = await verify();
  if (!s2.body?.accessToken) {
    await waitForNextTotpStep();
    s2 = await verify();
  }
  if (!s2.body?.accessToken) throw new Error(`TOTP 실패(${s2.status}): ${JSON.stringify(s2.body)}`);
  return s2.body.accessToken;
}

async function main() {
  console.log('\n\x1b[1m관리자 화면 API 흐름 검증\x1b[0m\n');

  console.log('\x1b[1m1. 로그인\x1b[0m');
  const wi1 = await login('wi1');
  check('선관위원 로그인', typeof wi1 === 'string');
  const gam1 = await login('gam1');
  check('참관인 로그인', typeof gam1 === 'string');

  console.log('\n\x1b[1m2. 선거 목록\x1b[0m');
  const list = await call('/admin/elections', {}, wi1);
  check('선관위원 목록 조회', list.status === 200, `${list.body.length}건`);
  const listAud = await call('/admin/elections', {}, gam1);
  check('참관인도 목록 조회 가능', listAud.status === 200);
  const noAuth = await call('/admin/elections');
  check('토큰 없이는 거부', noAuth.status === 401);

  console.log('\n\x1b[1m3. 선거 생성\x1b[0m');
  const audCreate = await call('/admin/elections', {
    method: 'POST',
    body: JSON.stringify({
      title: '참관인이 만들려는 선거', startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 864e5).toISOString(),
      candidates: [{ ballotNumber: 1, name: '아무개' }],
    }),
  }, gam1);
  check('참관인의 선거 생성 거부', audCreate.status === 403, `HTTP ${audCreate.status}`);

  const dupNo = await call('/admin/elections', {
    method: 'POST',
    body: JSON.stringify({
      title: '[검증] 기호중복', startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 864e5).toISOString(),
      candidates: [{ ballotNumber: 1, name: '가' }, { ballotNumber: 1, name: '나' }],
    }),
  }, wi1);
  check('기호 중복 거부', dupNo.status === 400, `HTTP ${dupNo.status}`);

  const badRange = await call('/admin/elections', {
    method: 'POST',
    body: JSON.stringify({
      title: '[검증] 기간역전', startsAt: new Date(Date.now() + 864e5).toISOString(),
      endsAt: new Date().toISOString(),
      candidates: [{ ballotNumber: 1, name: '가' }],
    }),
  }, wi1);
  check('종료가 시작보다 앞서면 거부', badRange.status === 400);

  const created = await call('/admin/elections', {
    method: 'POST',
    body: JSON.stringify({
      title: '[검증] 관리자 화면 흐름',
      description: 'admin:check 가 만든 선거',
      startsAt: new Date(Date.now() - 3600e3).toISOString(),
      endsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      candidates: [
        { ballotNumber: 1, name: '가후보', affiliation: '前 이사' },
        { ballotNumber: 2, name: '나후보', affiliation: '前 감사' },
      ],
    }),
  }, wi1);
  check('선거 생성', created.status === 201 || created.status === 200);
  const eid: string = created.body.election.id;
  const key: string = created.body.privateKey;
  check('개표키를 응답에서 한 번 돌려줌', typeof key === 'string' && key.length > 100,
    `${key?.length}자`);

  const stored = await prisma.election.findUnique({
    where: { id: eid }, select: { ballotPublicKey: true },
  });
  check('공개키만 저장되고 개인키는 DB에 없음',
    !!stored?.ballotPublicKey && stored.ballotPublicKey !== key);

  console.log('\n\x1b[1m4. 명부 등록\x1b[0m');
  const dupPhone = await call(`/admin/elections/${eid}/roster`, {
    method: 'POST',
    body: JSON.stringify({
      csv: 'memberNo,name,phone,birthDate\nA1,김하나,010-5555-0001,19700101\nA2,이두울,010-5555-0001,19800202',
    }),
  }, wi1);
  check('휴대폰 중복 명부 거부', dupPhone.status === 400);

  const rows = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return `A${n},검증${n},010-5555-${String(n).padStart(4, '0')},${1960 + n}0101`;
  });
  const roster = await call(`/admin/elections/${eid}/roster`, {
    method: 'POST',
    body: JSON.stringify({ csv: ['memberNo,name,phone,birthDate', ...rows].join('\n') }),
  }, wi1);
  check('명부 등록', roster.body?.inserted === 20, `${roster.body?.inserted}명`);

  console.log('\n\x1b[1m5. 현황 조회\x1b[0m');
  const ov = await call(`/admin/elections/${eid}/overview`, {}, wi1);
  check('현황 조회', ov.status === 200,
    `선거인 ${ov.body.turnout?.eligible} · 후보 ${ov.body.candidates?.length}`);
  check('현황에 봉인 공개키를 담지 않음', ov.body.ballotPublicKey === undefined);
  check('현황에 후보별 득표가 없음', !JSON.stringify(ov.body).includes('"votes"'));
  check('개표키 보유 여부는 알려줌', ov.body.hasKey === true);

  console.log('\n\x1b[1m6. 개시 · 마감\x1b[0m');
  const opened = await call(`/admin/elections/${eid}/open`, { method: 'POST' }, wi1);
  check('투표 개시', opened.status === 201 || opened.status === 200,
    `선거인 ${opened.body?.voterCount}`);

  const lateRoster = await call(`/admin/elections/${eid}/roster`, {
    method: 'POST',
    body: JSON.stringify({ csv: 'memberNo,name,phone,birthDate\nZ1,늦은이,010-5555-9999,19900101' }),
  }, wi1);
  check('개시 후 명부 추가 거부', lateRoster.status === 409, `HTTP ${lateRoster.status}`);

  const lateCand = await call(`/admin/elections/${eid}/candidates`, {
    method: 'POST',
    body: JSON.stringify({ candidates: [{ ballotNumber: 1, name: '바꾼후보' }] }),
  }, wi1);
  check('개시 후 후보 변경 거부', lateCand.status === 409, `HTTP ${lateCand.status}`);

  const closed = await call(`/admin/elections/${eid}/close`, { method: 'POST' }, wi1);
  check('투표 마감', closed.status === 201 || closed.status === 200);

  console.log('\n\x1b[1m7. 개표 (2인 승인)\x1b[0m');
  const first = await call(`/admin/elections/${eid}/tally`, {
    method: 'POST', body: JSON.stringify({ privateKey: key }),
  }, wi1);
  check('1차 승인은 개표하지 않음', first.body?.tallied === false,
    `승인 ${first.body?.approvals}/${first.body?.required}`);

  const wi2 = await login('wi2');
  const second = await call(`/admin/elections/${eid}/tally`, {
    method: 'POST', body: JSON.stringify({ privateKey: key }),
  }, wi2);
  check('2차 승인으로 개표 실행', second.body?.tallied === true,
    `승인자 ${second.body?.approvedBy?.join(', ')}`);

  const results = await call(`/elections/${eid}/results`);
  check('결과 공개', results.status === 200,
    `투표 ${results.body?.totalBallots} · 무효 ${results.body?.invalid}`);

  // 정리
  await prisma.election.delete({ where: { id: eid } });
  await prisma.election.deleteMany({ where: { title: { startsWith: '[검증]' } } });

  console.log(`\n\x1b[1m${pass} 통과${fail ? `, \x1b[31m${fail} 실패` : ''}\x1b[0m\n`);
  if (fail) process.exit(1);
}

main()
  .catch((e) => { console.error('\n\x1b[31m실패:\x1b[0m', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
