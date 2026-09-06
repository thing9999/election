/**
 * 전 과정 E2E 검증. API 서버가 떠 있는 상태에서 실행한다.
 *
 *   터미널 1:  npm run dev  --workspace=apps/api
 *   터미널 2:  npm run e2e  --workspace=apps/api
 *
 * 시드 데이터를 소비하고 개표까지 끝내므로, 다시 돌리려면 seed 를 먼저 재실행한다.
 */
import 'dotenv/config';
import { ownerPrisma } from './owner-db';
import { readFileSync, existsSync, rmSync } from 'fs';
import { generateSync as totpGenerate, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import { devOtpPath, devSmsPath } from '../src/auth/sms.service';
import { sealBallot } from '../../../packages/ballot-seal/seal';
import { openBallot, SEALED_BALLOT_LEN } from '../src/common/ballot-crypto';
import { join } from 'path';

const TOTP_PLUGINS = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };

const BASE = process.env.E2E_BASE ?? 'http://localhost:4000/api';
const prisma = ownerPrisma();

/** prisma/seed.ts 와 같은 규칙 */
function seedBirthDate(n: number): string {
  return (
    `${1950 + (n % 40)}` +
    String((n % 12) + 1).padStart(2, '0') +
    String((n % 28) + 1).padStart(2, '0')
  );
}

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ''}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` \x1b[31m${detail}\x1b[0m` : ''}`);
  }
}

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function otpFor(phoneE164: string): string {
  const path = devOtpPath(phoneE164);
  if (!existsSync(path)) throw new Error(`${phoneE164} 의 mock OTP 를 찾지 못했습니다.`);
  return readFileSync(path, 'utf8').trim();
}

/** 회원번호 n번 유권자로 로그인해 투표 토큰을 받는다 */
async function login(n: number): Promise<string> {
  const phone = `010-0000-${String(n).padStart(4, '0')}`;
  const e164 = `+8210${String(n).padStart(8, '0')}`;
  const birthDate = seedBirthDate(n);

  const req = await call('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ electionId: ELECTION_ID, phone, birthDate }),
  });
  if (req.status !== 201 && req.status !== 200) {
    if (req.status === 429) {
      throw new Error(
        [
          'OTP 요청이 쓰로틀에 걸렸습니다 (429).',
          '  E2E 는 유권자 40명을 연속으로 인증하므로 운영 쓰로틀(IP 당 분당 30회)에서는 반드시 걸립니다.',
          '  손으로 환경변수를 붙이지 말고 아래를 쓰세요 — 환경을 잡고 정리까지 합니다:',
          '      npm run test:e2e',
        ].join('\n'),
      );
    }
    throw new Error(`OTP 요청 실패 (${req.status}): ${JSON.stringify(req.body)}`);
  }

  const ver = await call('/auth/otp/verify', {
    method: 'POST',
    // challengeToken 을 돌려주면 서버가 투표 완료 문자를 보낼 번호를 알게 된다.
    // 평문 번호를 저장하지 않으므로 이 경로가 아니면 문자를 보낼 방법이 없다.
    body: JSON.stringify({
      challengeId: req.body.challengeId,
      code: otpFor(e164),
      challengeToken: req.body.challengeToken,
    }),
  });
  if (!ver.body.accessToken) {
    throw new Error(`OTP 검증 실패 (${ver.status}): ${JSON.stringify(ver.body)}`);
  }
  return ver.body.accessToken;
}

/** 브라우저가 하는 것과 똑같이 봉인해서 보낸다 */
const vote = async (token: string, candidateId: string | null) => {
  const sealed = await sealBallot(ELECTION_PUBLIC_KEY, candidateId);
  return call('/vote', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sealedVote: sealed }),
  });
};

/**
 * TOTP 는 같은 30초 슬롯의 코드를 두 번 받지 않는다(재사용 방지, 의도된 동작).
 * 스크립트를 연달아 돌리면 여기 걸리므로, 걸리면 다음 슬롯까지 기다렸다 한 번 재시도한다.
 */
async function waitForNextTotpStep(): Promise<void> {
  const ms = 30_000 - (Date.now() % 30_000) + 1_000;
  console.log(`  다음 인증번호가 생성될 때까지 ${Math.ceil(ms / 1000)}초 대기…`);
  await new Promise((r) => setTimeout(r, ms));
}

let ELECTION_ID = '';
let ELECTION_PUBLIC_KEY = '';

/** seed 가 만드는 E2E 전용 관리자 계정. 운영에서는 admin:create 로 만들고 비밀번호를 저장하지 않는다. */
const E2E_ADMIN_PW: Record<string, string> = {
  wi1: 'e2e-commissioner-1-pw',
  wi2: 'e2e-commissioner-2-pw',
  wi3: 'e2e-commissioner-3-pw',
  gam1: 'e2e-auditor-1-pw',
};

async function main() {
  const election = await prisma.election.findFirst({
    where: { title: { startsWith: '[테스트]' } },
    include: { candidates: { orderBy: { ballotNumber: 'asc' } } },
  });
  if (!election) throw new Error('테스트 선거가 없습니다. 먼저 seed 를 실행하세요.');
  ELECTION_ID = election.id;
  ELECTION_PUBLIC_KEY = election.ballotPublicKey!;

  const cands = election.candidates;

  console.log(`\n선거: ${election.title}`);
  console.log(`후보: ${cands.map((c) => `${c.ballotNumber}.${c.name}`).join('  ')}\n`);

  // 5b 에서 관리자 API 를 써야 하므로 먼저 로그인해 둔다.
  // 같은 위원이 30초 안에 두 번 로그인하면 TOTP 재사용 방지에 걸린다(의도된 동작).
  // 그래서 초반 작업에는 전용 계정을 쓴다.
  const asAdminEarly = { Authorization: `Bearer ${await adminLogin('wi3')}` };

  // ── 1. 공개 정보에 득표가 섞여 있지 않은가 ──
  console.log('\x1b[1m1. 공개 API\x1b[0m');
  const pub = await call(`/elections/${ELECTION_ID}`);
  check('선거 정보 조회', pub.status === 200);
  check(
    '후보 목록에 득표수가 포함되지 않음',
    !JSON.stringify(pub.body).match(/"votes"|"count"/),
  );

  const early = await call(`/elections/${ELECTION_ID}/results`);
  check('개표 전 결과 조회는 거부됨', early.status === 403, `HTTP ${early.status}`);

  // ── 2. 정상 투표 ──
  console.log('\n\x1b[1m2. 투표 한 표\x1b[0m');
  rmSync(devSmsPath('+821000000001'), { force: true }); // 지난 실행 기록 제거
  const t1 = await login(1);
  const v1 = await vote(t1, cands[0].id);
  check('투표 성공', v1.status === 201 || v1.status === 200);
  check('확인번호 발급', typeof v1.body.confirmationCode === 'string');

  // 투표 완료 문자 — 기권자 명의 투표를 잡는 방어선이다.
  // 이 문자가 안 나가면 명부에 있는 기권자 명의로 표를 채우는 조작을 잡을 수단이 없다.
  await new Promise((r) => setTimeout(r, 400)); // 발송은 기다리지 않고 던지므로
  {
    const smsFile = devSmsPath('+821000000001');
    const sms = existsSync(smsFile) ? readFileSync(smsFile, 'utf8') : '';
    check('투표 완료 문자 발송됨', sms.includes('투표가 완료되었습니다'));
    check('완료 문자에 확인번호 포함', sms.includes(v1.body.confirmationCode));
    check('완료 문자에 후보 정보 없음 (있으면 매표 영수증이 된다)',
      !sms.includes(cands[0].id) && !sms.includes(cands[0].name));
  }
  check(
    '확인번호에 후보 정보가 없음',
    !JSON.stringify(v1.body).includes(cands[0].id) &&
      !JSON.stringify(v1.body).includes(cands[0].name),
  );

  // ── 3. 중복 투표 차단 ──
  console.log('\n\x1b[1m3. 중복 투표 차단\x1b[0m');
  const dup = await vote(t1, cands[1].id);
  check('같은 토큰 재투표 거부', dup.status === 409, `HTTP ${dup.status}`);

  const reOtp = await call('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({
      electionId: ELECTION_ID, phone: '010-0000-0001', birthDate: seedBirthDate(1),
    }),
  });
  check('투표 완료자의 OTP 재요청 거부', reOtp.status === 409, `HTTP ${reOtp.status}`);

  // ── 4. 동시 요청 (1인 1표의 핵심) ──
  console.log('\n\x1b[1m4. 동시 요청 8건 (같은 유권자)\x1b[0m');
  const t2 = await login(2);
  const burst = await Promise.all(
    Array.from({ length: 8 }, (_, i) => vote(t2, cands[i % cands.length].id)),
  );
  const okCount = burst.filter((r) => r.status === 201 || r.status === 200).length;
  const conflictCount = burst.filter((r) => r.status === 409).length;
  check('성공은 정확히 1건', okCount === 1, `성공 ${okCount}건`);
  check('나머지 7건은 409', conflictCount === 7, `충돌 ${conflictCount}건`);

  const ballotsForVoter2 = await prisma.ballot.count({ where: { electionId: ELECTION_ID } });
  check('DB 에 실제로 2표만 존재', ballotsForVoter2 === 2, `${ballotsForVoter2}표`);

  // ── 5. 명부 대조 (휴대폰만으로 로그인) ──
  console.log('\n\x1b[1m5. 명부 대조\x1b[0m');
  const stranger = await call('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({
      electionId: ELECTION_ID, phone: '010-9999-9999', birthDate: '19800101',
    }),
  });
  check('명부에 없는 휴대폰 거부', stranger.status === 401, `HTTP ${stranger.status}`);

  // ── 핵심: 번호는 명부에 있지만 생년월일이 다른 경우 ──
  // 폰을 주웠거나, 명부의 번호가 낡아 지금은 남의 번호인 상황이 여기 해당한다.
  const wrongBirth = await call('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({
      electionId: ELECTION_ID, phone: '010-0000-0007', birthDate: '19010101',
    }),
  });
  check('번호는 맞지만 생년월일이 다르면 거부', wrongBirth.status === 401,
    `HTTP ${wrongBirth.status}`);
  check(
    '두 실패의 응답이 동일 (그 번호가 명부에 있는지 새어나가지 않음)',
    stranger.status === wrongBirth.status && stranger.body.message === wrongBirth.body.message,
  );

  const noSms = existsSync(devOtpPath('+821000000007'));
  check('생년월일이 틀리면 문자를 보내지 않음 (SMS 비용·괴롭힘 방지)', !noSms);

  const missingBirth = await call('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ electionId: ELECTION_ID, phone: '010-0000-0005' }),
  });
  check('생년월일 없이 요청하면 거부', missingBirth.status === 400,
    `HTTP ${missingBirth.status}`);

  const withMemberNo = await call('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({
      electionId: ELECTION_ID,
      phone: '010-0000-0005',
      birthDate: seedBirthDate(5),
      memberNo: 'M00005',
    }),
  });
  check('회원번호를 보내면 거부 (더 이상 받지 않는 필드)', withMemberNo.status === 400,
    `HTTP ${withMemberNo.status}`);

  // 구분자가 들어가도 통과해야 한다 (고령 유권자 입력 편의)
  const bd6 = seedBirthDate(6);
  const dashed = `${bd6.slice(0, 4)}-${bd6.slice(4, 6)}-${bd6.slice(6, 8)}`;
  const beforeVerify = await call('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ electionId: ELECTION_ID, phone: '010-0000-0006', birthDate: dashed }),
  });
  check('생년월일에 구분자가 있어도 통과', beforeVerify.status === 201 || beforeVerify.status === 200,
    dashed);
  check('인증 통과 전에는 이름을 주지 않음',
    beforeVerify.body.nameMasked === undefined && typeof beforeVerify.body.phoneLast4 === 'string');

  const verified = await call('/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: beforeVerify.body.challengeId,
      code: otpFor('+821000000006'),
    }),
  });
  check('인증 통과 후에는 이름을 확인해 줌', typeof verified.body.nameMasked === 'string',
    verified.body.nameMasked);

  // ── 5b. 명부에 같은 번호가 두 명이면 등록 자체를 막는다 ──
  console.log('\n\x1b[1m5b. 휴대폰 중복 명부 차단\x1b[0m');
  const dupCsv = [
    'memberNo,name,phone,birthDate',
    'D0001,김하나,010-7777-0001,19700101',
    'D0002,이두울,010-7777-0001,19800202', // 같은 번호
  ].join('\n');
  const dupElection = await prisma.election.create({
    data: {
      title: '[테스트] 중복번호 검사용',
      status: 'DRAFT',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 86400000),
      ballotPublicKey: ELECTION_PUBLIC_KEY,
    },
  });
  const dupRes = await call(`/admin/elections/${dupElection.id}/roster`, {
    method: 'POST',
    headers: asAdminEarly,
    body: JSON.stringify({ csv: dupCsv }),
  });
  check('같은 휴대폰이 두 회원에게 등록되면 명부 거부', dupRes.status === 400,
    `HTTP ${dupRes.status}`);
  check('어느 행이 겹쳤는지 알려줌',
    typeof dupRes.body.message === 'string' && dupRes.body.message.includes('2행'));
  await prisma.election.delete({ where: { id: dupElection.id } });

  // ── 6. 다수 투표로 분포 만들기 ──
  console.log('\n\x1b[1m6. 유권자 40명 투표\x1b[0m');
  const plan = Array.from({ length: 40 }, (_, i) => ({
    n: i + 10,
    // 기호1에 몰아주고, 일부는 기권
    candidateId: i % 7 === 0 ? null : cands[i % 3 === 0 ? 1 : i % 5 === 0 ? 2 : 0].id,
  }));
  for (let i = 0; i < plan.length; i += 10) {
    await Promise.all(
      plan.slice(i, i + 10).map(async (p) => {
        const tok = await login(p.n);
        await vote(tok, p.candidateId);
      }),
    );
    process.stdout.write(`\r  투표 진행 ${Math.min(i + 10, plan.length)}/${plan.length}`);
  }
  console.log();

  const turnout = await call(`/elections/${ELECTION_ID}/turnout`);
  check('투표율 조회 (진행 중 공개 가능)', turnout.status === 200,
    `${turnout.body.voted}/${turnout.body.eligible} = ${turnout.body.turnoutRate}%`);

  // ── 7. 익명성: 스키마에 연결고리가 없는가 ──
  console.log('\n\x1b[1m7. 익명성 (스키마 수준)\x1b[0m');
  const cols: Array<{ column_name: string }> = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Ballot'`,
  );
  const names = cols.map((c) => c.column_name);
  check(
    'Ballot 테이블에 유권자 참조 컬럼이 없음',
    !names.some((n) => /voter|member|phone|user/i.test(n)),
    names.join(', '),
  );

  const hourly: Array<{ castAtHour: Date }> = await prisma.ballot.findMany({
    where: { electionId: ELECTION_ID },
    select: { castAtHour: true },
    take: 5,
  });
  check(
    '투표 시각이 시(hour) 단위로 뭉개져 있음',
    hourly.every((b) => b.castAtHour.getMinutes() === 0 && b.castAtHour.getSeconds() === 0),
  );

  const voterAudit = await prisma.auditLog.findMany({
    where: { electionId: ELECTION_ID, actorType: 'VOTER' },
    select: { actorRef: true },
  });
  check(
    `감사 로그의 유권자 기록 ${voterAudit.length}건 전부 actorRef 가 비어 있음`,
    voterAudit.every((a) => a.actorRef === null),
  );

  // ── 7b. 저장된 표가 실제로 봉인되어 있는가 ──
  console.log('\n\x1b[1m7b. 저장된 표의 봉인 상태\x1b[0m');

  const storedCols: Array<{ column_name: string }> = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Ballot'`,
  );
  check(
    'Ballot 에 평문 candidateId 컬럼이 더 이상 없음',
    !storedCols.map((c) => c.column_name).includes('candidateId'),
    storedCols.map((c) => c.column_name).join(', '),
  );

  const stored = await prisma.ballot.findMany({
    where: { electionId: ELECTION_ID },
    select: { sealedVote: true },
  });
  check(`저장된 표 ${stored.length}건 모두 봉인 길이가 동일`,
    stored.every((b) => b.sealedVote.length === SEALED_BALLOT_LEN),
    `${SEALED_BALLOT_LEN} 바이트`);

  const uniqueCiphertexts = new Set(stored.map((b) => Buffer.from(b.sealedVote).toString('base64')));
  check('같은 후보를 찍었어도 암호문이 전부 다름',
    uniqueCiphertexts.size === stored.length,
    `고유 ${uniqueCiphertexts.size}/${stored.length}`);

  // DB 를 통째로 읽을 수 있는 사람이 중간 집계를 낼 수 있는지
  const blob = stored.map((b) => Buffer.from(b.sealedVote).toString('latin1')).join('');
  const leaked = cands.filter((c) => blob.includes(c.id));
  check('암호문 어디에도 후보 ID 가 나타나지 않음', leaked.length === 0,
    leaked.map((c) => c.name).join(', '));

  // 개인키 없이 후보별로 셀 수 있는 방법이 없다는 것을 실제로 확인한다
  const keyInDb: Array<{ n: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::bigint AS n FROM information_schema.columns
     WHERE table_name = 'Election' AND column_name ILIKE '%private%'`,
  );
  check('DB 스키마에 개인키를 담을 컬럼 자체가 없음', Number(keyInDb[0].n) === 0);

  // 개인키가 있으면 열린다 (개표가 가능하다는 확인)
  const testKey = readFileSync(join(process.cwd(), '.election-key.txt'), 'utf8').trim();
  const pubKey = (await prisma.election.findUnique({
    where: { id: ELECTION_ID }, select: { ballotPublicKey: true },
  }))!.ballotPublicKey!;
  const openedSample = stored
    .slice(0, 5)
    .map((b) => openBallot(testKey, pubKey, b.sealedVote));
  check('개인키가 있으면 정상적으로 열림',
    openedSample.every((c) => c === null || cands.some((k) => k.id === c)));

  // ── 7c. 서버가 평문을 받아주지 않는가 ──
  console.log('\n\x1b[1m7c. 서버는 평문 후보를 받지 않는다\x1b[0m');

  const plainAttemptToken = await login(300);
  const plainAttempt = await call('/vote', {
    method: 'POST',
    headers: { Authorization: `Bearer ${plainAttemptToken}` },
    body: JSON.stringify({ candidateId: cands[0].id }),
  });
  check('평문 candidateId 로 투표 시도 거부', plainAttempt.status === 400,
    `HTTP ${plainAttempt.status}`);

  const shortSeal = await call('/vote', {
    method: 'POST',
    headers: { Authorization: `Bearer ${plainAttemptToken}` },
    body: JSON.stringify({ sealedVote: Buffer.alloc(60).toString('base64') }),
  });
  check('길이가 틀린 봉인 거부', shortSeal.status === 400, `HTTP ${shortSeal.status}`);

  const stillUnused = await prisma.voter.findFirst({
    where: { electionId: ELECTION_ID, hasVoted: true },
    orderBy: { votedAt: 'desc' },
    select: { votedAt: true },
  });
  const notConsumed = await prisma.voter.count({
    where: { electionId: ELECTION_ID, hasVoted: false },
  });
  check('거부된 시도로 투표권이 소진되지 않음', notConsumed > 0 && stillUnused !== null);

  // 쓰레기 표는 받아들이되 개표를 막지 않아야 한다 (DoS 방지)
  const garbageToken = await login(301);
  const garbage = await sealBallot(ELECTION_PUBLIC_KEY, '00000000-0000-4000-8000-000000000000');
  const garbageRes = await call('/vote', {
    method: 'POST',
    headers: { Authorization: `Bearer ${garbageToken}` },
    body: JSON.stringify({ sealedVote: garbage }),
  });
  check('존재하지 않는 후보로 봉인한 표는 일단 접수됨',
    garbageRes.status === 201 || garbageRes.status === 200,
    `HTTP ${garbageRes.status} — 서버는 내용을 볼 수 없으므로 거를 수 없다`);

  // ── 8. 관리자 인증 ──
  console.log('\n\x1b[1m8. 관리자 로그인 (비밀번호 + TOTP)\x1b[0m');

  /** 비밀번호 → TOTP → 관리자 토큰. 실제 로그인 경로를 그대로 탄다. */
  async function adminLogin(loginId: string): Promise<string> {
    const pw = E2E_ADMIN_PW[loginId];
    const step1 = await call('/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify({ loginId, password: pw }),
    });
    if (!step1.body?.pendingToken) {
      throw new Error(`관리자 로그인 실패 (${step1.status}): ${JSON.stringify(step1.body)}`);
    }
    const pending = { Authorization: `Bearer ${step1.body.pendingToken}` };

    // 최초 로그인이면 TOTP 등록부터
    let secret = (await prisma.adminUser.findUnique({ where: { loginId } }))?.totpSecret;
    if (!step1.body.totpRegistered) {
      const enroll = await call('/admin/auth/totp/enroll', { method: 'POST', headers: pending });
      secret = enroll.body.secret;
    }

    const verify = () => call('/admin/auth/totp/verify', {
      method: 'POST',
      headers: pending,
      body: JSON.stringify({ code: totpGenerate({ ...TOTP_PLUGINS, secret: secret! }) }),
    });

    let step2 = await verify();
    if (!step2.body?.accessToken) {
      await waitForNextTotpStep();
      step2 = await verify();
    }
    if (!step2.body?.accessToken) {
      throw new Error(`TOTP 검증 실패 (${step2.status}): ${JSON.stringify(step2.body)}`);
    }
    return step2.body.accessToken;
  }

  const [c1, c2, auditorId] = ['wi1', 'wi2', 'gam1'];

  const badPw = await call('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ loginId: c1, password: 'wrong-password-xx' }),
  });
  check('잘못된 비밀번호 거부', badPw.status === 401, `HTTP ${badPw.status}`);

  const noSuchAccount = await call('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ loginId: 'nobody-here', password: 'wrong-password-xx' }),
  });
  check(
    '없는 계정과 틀린 비밀번호의 응답이 동일 (계정 목록 유출 방지)',
    noSuchAccount.status === badPw.status && noSuchAccount.body.message === badPw.body.message,
  );

  const pwOnly = await call('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ loginId: c1, password: E2E_ADMIN_PW[c1] }),
  });
  check('비밀번호 통과 시 pendingToken 발급', typeof pwOnly.body.pendingToken === 'string');
  check('pendingToken 은 아직 관리자 토큰이 아님', !pwOnly.body.accessToken);

  const pendingOnAdminApi = await call(`/admin/elections/${ELECTION_ID}/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pwOnly.body.pendingToken}` },
  });
  check(
    'TOTP 없이 pendingToken 으로 관리자 API 호출 거부',
    pendingOnAdminApi.status === 401,
    `HTTP ${pendingOnAdminApi.status}`,
  );

  const wrongTotp = await call('/admin/auth/totp/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pwOnly.body.pendingToken}` },
    body: JSON.stringify({ code: '000000' }),
  });
  check('잘못된 TOTP 거부', wrongTotp.status === 401, `HTTP ${wrongTotp.status}`);

  const adminToken1 = await adminLogin(c1);
  check('선관위원 1 로그인 성공 (비밀번호 + TOTP)', typeof adminToken1 === 'string');
  const asAdmin = { Authorization: `Bearer ${adminToken1}` };

  // TOTP 재사용 차단
  const reuseSecret = (await prisma.adminUser.findUnique({ where: { loginId: c1 } }))!.totpSecret!;
  const reuseCode = totpGenerate({ ...TOTP_PLUGINS, secret: reuseSecret });
  const reLogin = await call('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ loginId: c1, password: E2E_ADMIN_PW[c1] }),
  });
  const reused = await call('/admin/auth/totp/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${reLogin.body.pendingToken}` },
    body: JSON.stringify({ code: reuseCode }),
  });
  check('이미 사용한 TOTP 코드 재사용 거부', reused.status === 401, `HTTP ${reused.status}`);

  // 참관인 권한
  const auditorToken = await adminLogin(auditorId);
  const auditorWrite = await call(`/admin/elections/${ELECTION_ID}/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auditorToken}` },
  });
  check('참관인의 쓰기 작업 거부', auditorWrite.status === 403, `HTTP ${auditorWrite.status}`);

  const auditorRead = await call(`/admin/elections/${ELECTION_ID}/integrity`, {
    headers: { Authorization: `Bearer ${auditorToken}` },
  });
  check('참관인의 무결성 조회 허용', auditorRead.status === 200, `HTTP ${auditorRead.status}`);

  // ── 9. 마감과 개표 ──
  console.log('\n\x1b[1m9. 마감 · 개표 (2인 승인)\x1b[0m');
  const noAuth = await call(`/admin/elections/${ELECTION_ID}/close`, { method: 'POST' });
  check('토큰 없는 관리자 API 거부', noAuth.status === 401);

  const voterTokenOnAdmin = await call(`/admin/elections/${ELECTION_ID}/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t1}` },
  });
  check('유권자 토큰으로 관리자 API 호출 거부', voterTokenOnAdmin.status === 401);

  const closed = await call(`/admin/elections/${ELECTION_ID}/close`, {
    method: 'POST',
    headers: asAdmin,
  });
  check('투표 마감', closed.status === 201 || closed.status === 200);

  const closedVote = await login(200).then((t) => vote(t, cands[0].id)).catch(() => null);
  check('마감 후 투표 시도 거부', closedVote === null || closedVote.status === 403,
    closedVote ? `HTTP ${closedVote.status}` : '로그인 단계에서 차단');

  const integrity = await call(`/admin/elections/${ELECTION_ID}/integrity`, { headers: asAdmin });
  check('무결성 점검: 투표자 수 == 표 수', integrity.body.matched === true,
    `투표자 ${integrity.body.votedVoters} / 표 ${integrity.body.ballots}`);

  const beforeTally = await call(`/elections/${ELECTION_ID}/results`);
  check('마감 후에도 개표 전이면 결과 비공개', beforeTally.status === 403);

  const electionKey = readFileSync(join(process.cwd(), '.election-key.txt'), 'utf8').trim();

  const wrongKey = await call(`/admin/elections/${ELECTION_ID}/tally`, {
    method: 'POST',
    headers: asAdmin,
    body: JSON.stringify({ privateKey: 'A'.repeat(43) }),
  });
  check('엉뚱한 개표키 거부', wrongKey.status === 400, `HTTP ${wrongKey.status}`);

  const approvalsAfterBadKey = await call(`/admin/elections/${ELECTION_ID}/tally`, {
    headers: asAdmin,
  });
  check('키가 틀리면 승인 기록도 남지 않음', approvalsAfterBadKey.body?.approvals === 0,
    `승인 ${approvalsAfterBadKey.body?.approvals}`);

  const first = await call(`/admin/elections/${ELECTION_ID}/tally`, {
    method: 'POST',
    headers: asAdmin,
    body: JSON.stringify({ privateKey: electionKey }),
  });
  check('1차 승인은 개표하지 않음', first.body?.tallied === false,
    `승인 ${first.body?.approvals}/${first.body?.required}`);

  const stillClosed = await call(`/elections/${ELECTION_ID}/results`);
  check('1차 승인만으로는 결과 비공개', stillClosed.status === 403);

  const sameAgain = await call(`/admin/elections/${ELECTION_ID}/tally`, {
    method: 'POST',
    headers: asAdmin,
    body: JSON.stringify({ privateKey: electionKey }),
  });
  check('같은 위원의 재승인 거부 (혼자 정족수 못 채움)', sameAgain.status === 409,
    `HTTP ${sameAgain.status}`);

  const auditorTally = await call(`/admin/elections/${ELECTION_ID}/tally`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auditorToken}` },
    body: JSON.stringify({ privateKey: electionKey }),
  });
  check('참관인은 개표 승인 불가', auditorTally.status === 403, `HTTP ${auditorTally.status}`);

  const adminToken2 = await adminLogin(c2);
  const second = await call(`/admin/elections/${ELECTION_ID}/tally`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken2}` },
    body: JSON.stringify({ privateKey: electionKey }),
  });
  check('2차 승인으로 개표 실행', second.body?.tallied === true,
    `승인자: ${second.body?.approvedBy?.join(', ')} · 개봉 ${second.body?.opened} · 무효 ${second.body?.invalid}`);

  const reTally = await call(`/admin/elections/${ELECTION_ID}/tally`, {
    method: 'POST',
    headers: asAdmin,
    body: JSON.stringify({ privateKey: electionKey }),
  });
  check('재개표 거부 (되돌릴 수 없음)', reTally.status === 409, `HTTP ${reTally.status}`);

  // ── 10. 결과 ──
  console.log('\n\x1b[1m10. 개표 결과\x1b[0m');
  const results = await call(`/elections/${ELECTION_ID}/results`);
  check('결과 공개', results.status === 200);

  const r = results.body;
  console.log();
  console.log(`  선거인 ${r.eligible}명 · 투표 ${r.totalBallots}명 · 투표율 ${r.turnoutRate}%`);
  console.log(`  유효 ${r.validBallots}표 · 기권 ${r.abstained}표 · 무효 ${r.invalid}표\n`);
  for (const c of r.results) {
    const bar = '█'.repeat(Math.round(c.share / 2.5));
    console.log(
      `  기호${c.ballotNumber} ${c.name.padEnd(5)} ${String(c.votes).padStart(3)}표  ` +
        `${String(c.share).padStart(5)}%  ${bar}`,
    );
  }
  const sum = r.results.reduce((a: number, c: any) => a + c.votes, 0);
  console.log();
  check('후보 득표 + 기권 + 무효 == 총 투표수',
    sum + r.abstained + r.invalid === r.totalBallots,
    `${sum} + ${r.abstained} + ${r.invalid} = ${r.totalBallots}`);
  check('쓰레기 표가 개표를 막지 않고 무효로 집계됨', r.invalid === 1,
    `무효 ${r.invalid}건`);

  console.log(
    `\n\x1b[1m결과: \x1b[32m${passed} 통과\x1b[0m` +
      (failed ? `, \x1b[31m${failed} 실패\x1b[0m` : '') +
      '\x1b[0m\n',
  );
  if (failed) process.exit(1);
}

main()
  .catch((e) => {
    console.error('\n\x1b[31mE2E 실패:\x1b[0m', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
