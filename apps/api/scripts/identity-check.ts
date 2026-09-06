/**
 * 본인확인 · 투표 완료 문자 · 명부 사전 확정 · 감사 로그 반출 검증.
 *
 *   npm run identity:check --workspace=apps/api
 *
 * HTTP 서버 없이 Nest 컨텍스트만 띄워서 돈다. 모드(off/optional/required)를
 * 바꿔가며 확인해야 하는데 ConfigService 는 기동 시점의 env 를 붙잡으므로,
 * 컨텍스트를 모드별로 다시 만든다.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { readFileSync, existsSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { IdentityService } from '../src/auth/identity.service';
import { AdminService } from '../src/admin/admin.service';
import { VoteService } from '../src/vote/vote.service';
import { IntegrityService } from '../src/integrity/integrity.service';
import { AuditExportService, verifyExportedChain } from '../src/common/audit-sink';
import { devSmsPath } from '../src/auth/sms.service';
import { hashIdentifier } from '../src/common/crypto.util';
import { generateElectionKeyPair } from '../src/common/ballot-crypto';
import { sealBallot } from '../../../packages/ballot-seal/seal';
import { ownerPrisma } from './owner-db';

const prisma = ownerPrisma();
const PEPPER = process.env.VOTER_ID_PEPPER!;
let pass = 0, fail = 0;

const ok = (l: string, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}${d ? ` \x1b[2m(${d})\x1b[0m` : ''}`); };
const no = (l: string, d: string) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l} \x1b[31m${d}\x1b[0m`); };
const check = (l: string, cond: boolean, d = '') => (cond ? ok(l, d) : no(l, d || '실패'));

/** 던져야 정상인 호출 */
async function rejects(l: string, fn: () => Promise<unknown>, expect?: RegExp) {
  try {
    await fn();
    no(l, '거부되지 않음');
  } catch (e) {
    const m = (e as Error).message;
    if (expect && !expect.test(m)) no(l, `다른 이유로 실패: ${m.slice(0, 70)}`);
    else ok(l, m.slice(0, 52));
  }
}

const PEOPLE = [
  { member: 'IDC-1', name: '김본인', birth: '19700101', phone: '+821077770001' },
  { member: 'IDC-2', name: '이본인', birth: '19800202', phone: '+821077770002' },
  { member: 'IDC-3', name: '박본인', birth: '19900303', phone: '+821077770003' },
];

async function makeElection(title: string) {
  const { publicKey, privateKey } = generateElectionKeyPair();
  const e = await prisma.election.create({
    data: {
      title, status: 'DRAFT',
      startsAt: new Date(Date.now() - 3600e3), endsAt: new Date(Date.now() + 864e5),
      ballotPublicKey: publicKey,
      candidates: { create: [{ ballotNumber: 1, name: '가' }, { ballotNumber: 2, name: '나' }] },
    },
    include: { candidates: true },
  });
  await prisma.voter.createMany({
    data: PEOPLE.map((p) => ({
      electionId: e.id,
      memberNoHash: hashIdentifier(p.member, PEPPER),
      phoneHash: hashIdentifier(p.phone, PEPPER),
      birthDateHash: hashIdentifier(p.birth, PEPPER),
      nameHash: hashIdentifier(p.name, PEPPER),
      phoneLast4: p.phone.slice(-4),
      nameMasked: p.name[0] + '*' + p.name.slice(2),
    })),
  });
  return { e, publicKey, privateKey };
}

async function withMode<T>(mode: string, fn: (app: any) => Promise<T>): Promise<T> {
  process.env.IDENTITY_VERIFICATION = mode;
  process.env.IDENTITY_PROVIDER = 'mock';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function main() {
  console.log('\n\x1b[1m본인확인 · 완료 문자 · 명부 확정 · 감사 반출\x1b[0m');

  // ══ 1. 본인확인 (optional 모드) ══
  await withMode('optional', async (app) => {
    const identity = app.get(IdentityService);
    const { e } = await makeElection('[검증] 본인확인');
    await prisma.election.update({ where: { id: e.id }, data: { status: 'OPEN' } });

    console.log('\n\x1b[1m1. 본인확인 — 통과해야 하는 경우\x1b[0m');
    const p0 = PEOPLE[0];
    const begun = await identity.begin(e.id);
    check('거래 시작', Boolean(begun.txId), `provider=${begun.provider}`);

    const r = await identity.complete({
      electionId: e.id, txId: begun.txId,
      payload: { name: p0.name, birthDate: p0.birth, phone: p0.phone },
    });
    check('명부와 대조 후 투표 세션 발급', Boolean(r.accessToken));
    check('마스킹된 이름을 돌려줌', r.nameMasked === '김*인', r.nameMasked);

    const v = await prisma.voter.findFirst({
      where: { electionId: e.id, phoneHash: hashIdentifier(p0.phone, PEPPER) },
    });
    check('본인확인 시각이 기록됨', Boolean(v?.identityVerifiedAt));
    check('CI 는 해시로만 저장됨', Boolean(v?.ciHash) && v!.ciHash!.length === 64);

    console.log('\n\x1b[1m2. 본인확인 — 막아야 하는 경우\x1b[0m');
    const tx = async () => (await identity.begin(e.id)).txId;

    await rejects('명부에 없는 번호', async () =>
      identity.complete({
        electionId: e.id, txId: await tx(),
        payload: { name: '없는사람', birthDate: '19700101', phone: '+821099998888' },
      }), /명부에서 확인할 수 없습니다/);

    await rejects('생년월일이 다르면 거부', async () =>
      identity.complete({
        electionId: e.id, txId: await tx(),
        payload: { name: PEOPLE[1].name, birthDate: '19991231', phone: PEOPLE[1].phone },
      }), /명부에서 확인할 수 없습니다/);

    // ── 이게 본인확인을 붙이는 이유다 ──
    // 번호도 생년월일도 맞는데 통신사 명의가 다른 사람 = 가족·직원 대리투표
    await rejects('번호·생년월일은 맞지만 명의자가 다른 사람이면 거부 (대리투표)', async () =>
      identity.complete({
        electionId: e.id, txId: await tx(),
        payload: { name: '김가족', birthDate: PEOPLE[1].birth, phone: PEOPLE[1].phone },
      }), /명의자가 해당 회원 본인이 아닙니다/);

    await rejects('거래번호 재사용 거부', async () =>
      identity.complete({
        electionId: e.id, txId: begun.txId,
        payload: { name: p0.name, birthDate: p0.birth, phone: p0.phone },
      }), /거래를 찾을 수 없습니다/);

    // 같은 사람이 다른 회원번호로 명부에 또 있는 경우 (CI 가 같다)
    await prisma.voter.create({
      data: {
        electionId: e.id,
        memberNoHash: hashIdentifier('IDC-1-DUP', PEPPER),
        phoneHash: hashIdentifier('+821077779999', PEPPER),
        birthDateHash: hashIdentifier(p0.birth, PEPPER),
        nameHash: hashIdentifier(p0.name, PEPPER),
        phoneLast4: '9999', nameMasked: '김*인',
      },
    });
    await rejects('같은 사람이 다른 회원번호로 또 인증하면 거부 (CI 중복)', async () =>
      identity.complete({
        electionId: e.id, txId: await tx(),
        payload: { name: p0.name, birthDate: p0.birth, phone: '+821077779999' },
      }), /이미 다른 회원번호로/);

    await prisma.election.delete({ where: { id: e.id } });
  });

  // ══ 2. 모드 ══
  console.log('\n\x1b[1m3. 모드\x1b[0m');
  await withMode('required', async (app) => {
    const identity = app.get(IdentityService);
    check('required 이면 OTP 경로가 닫힘', identity.otpPathAllowed === false);
  });
  await withMode('off', async (app) => {
    const identity = app.get(IdentityService);
    check('off 이면 OTP 경로가 열림', identity.otpPathAllowed === true);
    await rejects('off 이면 본인확인 엔드포인트가 거부', () => identity.begin(randomUUID()),
      /사용하지 않습니다/);
  });

  // ══ 3. 명부 사전 확정 · 완료 문자 · 감사 반출 ══
  await withMode('off', async (app) => {
    const admin = app.get(AdminService);
    const vote = app.get(VoteService);
    const integrity = app.get(IntegrityService);
    const exporter = app.get(AuditExportService);

    const { e, publicKey } = await makeElection('[검증] 명부확정');
    const wi = await prisma.adminUser.findFirst({ where: { role: 'COMMISSIONER' } });
    if (!wi) throw new Error('선관위원 계정이 없습니다. npm run seed 를 먼저 실행하세요.');

    console.log('\n\x1b[1m4. 명부 사전 확정\x1b[0m');
    const sealed = await admin.sealRoster(e.id, wi.id);
    check('DRAFT 에서 명부 확정', Boolean(sealed.rosterHash), `유권자 ${sealed.voterCount}명`);
    check('배포할 해시가 전문으로 나옴', sealed.rosterHash!.length === 64);

    await rejects('확정 후에는 명부를 못 바꿈', () =>
      admin.importRoster({
        electionId: e.id, adminId: wi.id,
        rows: [{ memberNo: 'X', name: '침입', phone: '01011112222', birthDate: '19700101' }],
      }), /이미 확정\(봉인\)되었습니다/);

    await rejects('두 번 확정 거부', () => admin.sealRoster(e.id, wi.id), /이미 확정/);

    // 확정 후 DB 를 직접 고쳐 유권자를 밀어넣으면 개시가 막혀야 한다
    const ghost = await prisma.voter.create({
      data: {
        electionId: e.id,
        memberNoHash: hashIdentifier('GHOST', PEPPER),
        phoneHash: hashIdentifier('+821066660000', PEPPER),
        birthDateHash: hashIdentifier('19700101', PEPPER),
        phoneLast4: '0000', nameMasked: '유*령',
      },
    });
    check('확정 이후 명부가 바뀐 것을 탐지',
      (await integrity.rosterSealState(e.id)).matches === false);
    await rejects('명부가 바뀌었으면 개시 거부', () => admin.openElection(e.id, wi.id),
      /명부가 확정 당시와 다릅니다/);

    await prisma.voter.delete({ where: { id: ghost.id } });
    check('원복하면 다시 일치', (await integrity.rosterSealState(e.id)).matches === true);
    const opened = await admin.openElection(e.id, wi.id);
    check('원복 후 개시 성공', opened.ok === true);

    console.log('\n\x1b[1m5. 투표 완료 문자\x1b[0m');
    const p0 = PEOPLE[0];
    rmSync(devSmsPath(p0.phone), { force: true });
    const voter = await prisma.voter.findFirst({
      where: { electionId: e.id, phoneHash: hashIdentifier(p0.phone, PEPPER) },
    });
    const cast = await vote.castBallot({
      voterId: voter!.id, electionId: e.id, phone: p0.phone,
      sealedVoteB64: await sealBallot(publicKey, null),
    });
    // 발송은 기다리지 않고 던지므로 잠깐 준다
    await new Promise((r) => setTimeout(r, 400));

    const smsPath = devSmsPath(p0.phone);
    const sms = existsSync(smsPath) ? readFileSync(smsPath, 'utf8') : '';
    check('투표 후 완료 문자가 발송됨', sms.includes('투표가 완료되었습니다'));
    check('문자에 확인번호가 들어 있음', sms.includes(cast.confirmationCode));
    check('문자에 후보 정보가 없음 (있으면 매표 영수증이 된다)',
      !sms.includes('가') || !sms.includes('나') ? true : !/후보|기호/.test(sms));
    check('본인이 아니면 신고하라는 안내 포함', sms.includes('연락해'));

    console.log('\n\x1b[1m6. 감사 로그 외부 반출\x1b[0m');
    await exporter.flush();
    const st = exporter.status();
    if (st.sinks.length === 0) {
      no('반출이 켜져 있음', 'AUDIT_SINKS 가 비어 있습니다');
    } else {
      ok('반출이 켜져 있음', st.sinks.join(','));
      const text = st.path && existsSync(st.path) ? readFileSync(st.path, 'utf8') : '';
      check('인스턴스별 파일로 분리됨', Boolean(st.instance) && Boolean(st.path?.includes(st.instance)));
      const chain = verifyExportedChain(text);
      check('반출본 사슬이 온전함', chain.ok, `${chain.lines}줄`);
      check('방금 일어난 사건이 반출본에 있음', text.includes('VOTE_CAST'));

      // 한 줄을 지우면 사슬이 끊겨야 한다 — 지워졌다는 사실을 알 수 있어야 한다
      const lines = text.split('\n').filter(Boolean);
      const holed = [...lines.slice(0, Math.max(1, lines.length - 3)), ...lines.slice(lines.length - 2)].join('\n');
      check('중간 한 줄을 지우면 탐지됨', verifyExportedChain(holed).ok === false);
    }

    await prisma.election.delete({ where: { id: e.id } });
  });

  console.log(`\n\x1b[1m${pass} 통과${fail ? `, \x1b[31m${fail} 실패` : ''}\x1b[0m\n`);
  if (fail) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
