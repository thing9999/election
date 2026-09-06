/**
 * 시드 데이터 생성.
 *
 *   npm run seed --workspace=apps/api
 *   VOTER_COUNT=10000 npm run seed --workspace=apps/api   # 1만명 규모 테스트
 *
 * 테스트 유권자는 예측 가능한 값으로 만든다.
 *   회원번호   M00001, M00002, ...
 *   휴대폰     010-0000-0001, 010-0000-0002, ...
 * 당연히 운영 명부는 이 스크립트가 아니라 관리자 CSV 업로드로 넣는다.
 */
import 'dotenv/config';
import { ownerPrisma } from '../scripts/owner-db';
import { createHmac } from 'crypto';
import * as argon2 from 'argon2';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { generateElectionKeyPair } from '../src/common/ballot-crypto';

const prisma = ownerPrisma();

const PEPPER = process.env.VOTER_ID_PEPPER;
if (!PEPPER) throw new Error('VOTER_ID_PEPPER 가 .env 에 없습니다.');

const hash = (v: string) =>
  createHmac('sha256', PEPPER).update(v.trim().replace(/\s+/g, '').toUpperCase()).digest('hex');

const VOTER_COUNT = Number(process.env.VOTER_COUNT ?? 1000);

async function main() {
  // 기존 시드 선거를 지우고 다시 만든다 (Cascade 로 후보/명부/표까지 정리)
  const existing = await prisma.election.findFirst({
    where: { title: { startsWith: '[테스트]' } },
    select: { id: true },
  });
  if (existing) {
    await prisma.election.delete({ where: { id: existing.id } });
    console.log('기존 테스트 선거 삭제');
  }

  // ── 봉인키 ──
  // 실제 선거에서는 개인키를 출력해서 선관위가 오프라인 보관하고 서버에서 지운다.
  // 여기서는 자동 테스트가 개표할 수 있어야 하므로 파일로 떨군다.
  const { publicKey, privateKey } = generateElectionKeyPair();

  const now = new Date();
  const election = await prisma.election.create({
    data: {
      ballotPublicKey: publicKey,
      title: '[테스트] 제42대 협회장 선거',
      description: '시드 데이터로 생성된 테스트 선거입니다. 실제 선거가 아닙니다.',
      status: 'OPEN', // 바로 투표할 수 있도록. 운영에서는 DRAFT 로 시작해 관리자가 개시한다.
      startsAt: new Date(now.getTime() - 60 * 60 * 1000),
      endsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      candidates: {
        create: [
          { ballotNumber: 1, name: '김의준', affiliation: '前 시도의사회장', pledge: '수가 정상화' },
          { ballotNumber: 2, name: '박서현', affiliation: '前 학술이사', pledge: '전공의 처우 개선' },
          { ballotNumber: 3, name: '이한결', affiliation: '개원의協 부회장', pledge: '규제 완화' },
        ],
      },
    },
    include: { candidates: true },
  });

  // 명부 일괄 생성
  const rows = Array.from({ length: VOTER_COUNT }, (_, i) => {
    const n = i + 1;
    const memberNo = `M${String(n).padStart(5, '0')}`;
    const phone = `+8210${String(n).padStart(8, '0')}`;
    // 테스트 생년월일: 1950~1989 사이로 흩뿌린다 (n 으로 결정적 생성)
    const birthDate =
      `${1950 + (n % 40)}` +
      String((n % 12) + 1).padStart(2, '0') +
      String((n % 28) + 1).padStart(2, '0');
    // 본인확인 서비스가 돌려줄 "통신사 명의"와 대조할 이름.
    // 마스킹된 이름(테*0001)으로는 서로 다른 이름이 같은 값이 되어 대조가 안 된다.
    const name = `테스트${String(n).padStart(4, '0')}`;
    return {
      electionId: election.id,
      memberNoHash: hash(memberNo),
      phoneHash: hash(phone),
      birthDateHash: hash(birthDate),
      nameHash: hash(name),
      phoneLast4: phone.slice(-4),
      nameMasked: `테*${String(n).padStart(4, '0')}`,
    };
  });

  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.voter.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true });
    process.stdout.write(`\r명부 등록 ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  console.log();

  // ── 관리자 계정 ──
  // 개표에는 서로 다른 선관위원 2명의 승인이 필요하므로 최소 2명을 만든다.
  // 운영에서는 admin:create 로 만들고 비밀번호를 코드에 두지 않는다.
  const adminSeeds = [
    { loginId: 'wi1', name: '선관위원1', role: 'COMMISSIONER' as const, pw: 'e2e-commissioner-1-pw' },
    { loginId: 'wi2', name: '선관위원2', role: 'COMMISSIONER' as const, pw: 'e2e-commissioner-2-pw' },
    { loginId: 'wi3', name: '선관위원3', role: 'COMMISSIONER' as const, pw: 'e2e-commissioner-3-pw' },
    { loginId: 'gam1', name: '참관인1', role: 'AUDITOR' as const, pw: 'e2e-auditor-1-pw' },
  ];
  for (const a of adminSeeds) {
    // TOTP 등록 상태까지 초기화해서 매번 같은 조건에서 테스트되게 한다.
    await prisma.adminUser.upsert({
      where: { loginId: a.loginId },
      update: {
        passwordHash: await argon2.hash(a.pw),
        totpSecret: null, totpConfirmedAt: null, lastTotpStep: null,
        failedAttempts: 0, lockedUntil: null, disabledAt: null,
      },
      create: {
        loginId: a.loginId, name: a.name, role: a.role,
        passwordHash: await argon2.hash(a.pw),
      },
    });
  }

  // 개표키를 파일로. 운영에서는 절대 이렇게 하지 않는다 —
  // 서버 디스크에 개인키가 있으면 서버를 뚫은 사람이 중간 집계를 볼 수 있다.
  const keyPath = join(process.cwd(), '.election-key.txt');
  writeFileSync(keyPath, privateKey, 'utf8');

  console.log('\n─────────────────────────────────────────────');
  console.log(`선거 ID    : ${election.id}`);
  console.log(`제목       : ${election.title}`);
  election.candidates.forEach((c) => console.log(`  기호 ${c.ballotNumber}   : ${c.name}`));
  console.log(`유권자     : ${VOTER_COUNT}명`);
  console.log('테스트 계정: 휴대폰 010-0000-0001 / 생년월일 19510202 / 이름 테스트0001');
  console.log('관리자     : wi1 / wi2 (선관위원), gam1 (참관인)  ※ 테스트 전용 비밀번호');
  console.log(`봉인 공개키 : ${publicKey}`);
  console.log(`개표키      : ${privateKey}`);
  console.log(`             ↳ 테스트용으로 ${'.election-key.txt'} 에 저장됨`);
  console.log('             ↳ 운영에서는 출력만 하고 서버에 남기지 않는다');
  console.log('─────────────────────────────────────────────');
  console.log('\napps/web/.env.local 에 아래를 넣으면 브라우저에서 바로 투표할 수 있습니다:');
  console.log(`VITE_ELECTION_ID=${election.id}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
