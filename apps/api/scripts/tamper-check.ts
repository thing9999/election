/**
 * 무결성 사슬이 실제로 조작을 잡아내는지 검증한다.
 *   npm run tamper:check --workspace=apps/api
 *
 * DB 를 직접 고쳐 공격자를 흉내낸다. 검증이 "통과"만 하고 끝나면 의미가 없으므로,
 * **고친 뒤 반드시 실패로 뒤집히는지**를 확인한다.
 * 각 시나리오는 확인 후 원상복구한다.
 */
import 'dotenv/config';
import { ownerPrisma } from './owner-db';
import { randomUUID } from 'crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { IntegrityService } from '../src/integrity/integrity.service';
import { sealBallot } from '../../../packages/ballot-seal/seal';
import {
  generateElectionKeyPair, SEALED_BALLOT_LEN,
} from '../src/common/ballot-crypto';

const prisma = ownerPrisma();
let pass = 0, fail = 0;

const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label} \x1b[31m${detail}\x1b[0m`); }
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const integrity = app.get(IntegrityService);

  console.log('\n\x1b[1m무결성 사슬 — 조작 탐지 검증\x1b[0m\n');

  // ── 검증용 선거를 하나 만든다 ──
  const { publicKey, privateKey } = generateElectionKeyPair();
  const election = await prisma.election.create({
    data: {
      title: '[변조검증] 임시 선거',
      status: 'OPEN',
      startsAt: new Date(Date.now() - 3600e3),
      endsAt: new Date(Date.now() + 864e5),
      ballotPublicKey: publicKey,
      candidates: {
        create: [
          { ballotNumber: 1, name: '가' },
          { ballotNumber: 2, name: '나' },
        ],
      },
    },
    include: { candidates: true },
  });
  const eid = election.id;
  const cands = election.candidates;

  // 유권자 10명 + 표 10장
  await prisma.voter.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      electionId: eid,
      memberNoHash: `m${i}`.padEnd(64, '0'),
      phoneHash: `p${i}`.padEnd(64, '0'),
      birthDateHash: `b${i}`.padEnd(64, '0'),
      phoneLast4: String(1000 + i),
      nameMasked: `테*${i}`,
      hasVoted: true,
      votedAt: new Date(),
    })),
  });
  const hour = new Date();
  hour.setMinutes(0, 0, 0);
  for (let i = 0; i < 10; i++) {
    await prisma.ballot.create({
      data: {
        electionId: eid,
        sealedVote: Uint8Array.from(
          Buffer.from(await sealBallot(publicKey, cands[i % 2].id), 'base64'),
        ),
        castAtHour: hour,
      },
    });
  }

  await integrity.createCheckpoint({ electionId: eid, kind: 'ROSTER_SEALED' });
  await integrity.createCheckpoint({ electionId: eid, kind: 'FINAL' });

  const base = await integrity.verifyChain(eid);
  check('정상 상태에서는 통과', base.ok, `체크포인트 ${base.checkpoints}개`);

  // ── 시나리오 1: 표 추가 ──
  console.log('\n\x1b[1m1. 표를 몰래 넣으면\x1b[0m');
  const injected = await prisma.ballot.create({
    data: {
      electionId: eid,
      sealedVote: Uint8Array.from(
        Buffer.from(await sealBallot(publicKey, cands[0].id), 'base64'),
      ),
      castAtHour: hour,
    },
  });
  let v = await integrity.verifyChain(eid);
  check('탐지됨', !v.ok, v.problems[0]);
  await prisma.ballot.delete({ where: { id: injected.id } });
  check('원복 후 다시 통과', (await integrity.verifyChain(eid)).ok);

  // ── 시나리오 2: 표 삭제 ──
  console.log('\n\x1b[1m2. 표를 몰래 지우면\x1b[0m');
  const victim = await prisma.ballot.findFirst({ where: { electionId: eid } });
  const backup = { ...victim! };
  await prisma.ballot.delete({ where: { id: victim!.id } });
  v = await integrity.verifyChain(eid);
  check('탐지됨', !v.ok, v.problems[0]);
  await prisma.ballot.create({ data: backup as any });
  check('원복 후 다시 통과', (await integrity.verifyChain(eid)).ok);

  // ── 시나리오 3: 표 내용 바꿔치기 (개수는 그대로) ──
  console.log('\n\x1b[1m3. 표 하나를 다른 표로 바꿔치기하면\x1b[0m');
  const target = await prisma.ballot.findFirst({ where: { electionId: eid } });
  const original = Buffer.from(target!.sealedVote);
  await prisma.ballot.update({
    where: { id: target!.id },
    data: {
      sealedVote: Uint8Array.from(
        Buffer.from(await sealBallot(publicKey, cands[1].id), 'base64'),
      ),
    },
  });
  v = await integrity.verifyChain(eid);
  check('탐지됨 (개수는 그대로인데도)', !v.ok, v.problems[0]);
  await prisma.ballot.update({
    where: { id: target!.id }, data: { sealedVote: Uint8Array.from(original) },
  });
  check('원복 후 다시 통과', (await integrity.verifyChain(eid)).ok);

  // ── 시나리오 4: 명부에 가짜 유권자 추가 ──
  console.log('\n\x1b[1m4. 명부에 가짜 유권자를 넣으면\x1b[0m');
  const fake = await prisma.voter.create({
    data: {
      electionId: eid,
      memberNoHash: 'fake'.padEnd(64, 'f'),
      phoneHash: 'fake'.padEnd(64, 'e'),
      birthDateHash: 'fake'.padEnd(64, 'd'),
      phoneLast4: '9999', nameMasked: '가*짜',
    },
  });
  v = await integrity.verifyChain(eid);
  check('탐지됨', !v.ok, v.problems.find((p) => p.includes('명부')) ?? v.problems[0]);
  await prisma.voter.delete({ where: { id: fake.id } });
  check('원복 후 다시 통과', (await integrity.verifyChain(eid)).ok);

  // ── 시나리오 5: 체크포인트 자체를 수정 ──
  console.log('\n\x1b[1m5. 체크포인트를 고쳐 덮으려 하면\x1b[0m');
  const cp = await prisma.checkpoint.findFirst({ where: { electionId: eid }, orderBy: { seq: 'desc' } });
  const cpBallotCount = cp!.ballotCount;
  await prisma.checkpoint.update({
    where: { id: cp!.id }, data: { ballotCount: cpBallotCount + 1 },
  });
  v = await integrity.verifyChain(eid);
  check('탐지됨 (자기 해시와 안 맞음)', !v.ok, v.problems[0]);
  await prisma.checkpoint.update({
    where: { id: cp!.id }, data: { ballotCount: cpBallotCount },
  });
  check('원복 후 다시 통과', (await integrity.verifyChain(eid)).ok);

  // ── 시나리오 6: 체크포인트를 통째로 삭제 ──
  console.log('\n\x1b[1m6. 체크포인트를 통째로 지우면\x1b[0m');
  const first = await prisma.checkpoint.findFirst({ where: { electionId: eid }, orderBy: { seq: 'asc' } });
  const firstBackup = { ...first! };
  await prisma.checkpoint.delete({ where: { id: first!.id } });
  v = await integrity.verifyChain(eid);
  check('탐지됨 (사슬이 끊김)', !v.ok, v.problems[0]);
  await prisma.checkpoint.create({ data: firstBackup as any });
  check('원복 후 다시 통과', (await integrity.verifyChain(eid)).ok);

  // ── 시나리오 7: 개표 결과 숫자 조작 ──
  console.log('\n\x1b[1m7. 개표 후 득표수를 고치면\x1b[0m');
  await prisma.tallyResult.createMany({
    data: [
      { electionId: eid, candidateId: cands[0].id, votes: 5 },
      { electionId: eid, candidateId: cands[1].id, votes: 5 },
    ],
  });
  await integrity.createCheckpoint({ electionId: eid, kind: 'RESULTS' });
  check('결과 확정 직후에는 통과', (await integrity.verifyChain(eid)).ok);

  await prisma.tallyResult.updateMany({
    where: { electionId: eid, candidateId: cands[0].id }, data: { votes: 9 },
  });
  v = await integrity.verifyChain(eid);
  check('탐지됨', !v.ok, v.problems.find((p) => p.includes('결과')) ?? v.problems[0]);

  // ── 사슬이 못 잡는 것도 확인해 둔다 ──
  console.log('\n\x1b[1m8. 사슬만으로는 못 잡는 것\x1b[0m');
  await prisma.tallyResult.updateMany({
    where: { electionId: eid, candidateId: cands[0].id }, data: { votes: 5 },
  });
  await prisma.checkpoint.deleteMany({ where: { electionId: eid } });
  await prisma.ballot.deleteMany({ where: { electionId: eid } });
  for (let i = 0; i < 10; i++) {
    await prisma.ballot.create({
      data: {
        electionId: eid,
        sealedVote: Uint8Array.from(
          Buffer.from(await sealBallot(publicKey, cands[0].id), 'base64'),
        ),
        castAtHour: hour,
      },
    });
  }
  await integrity.createCheckpoint({ electionId: eid, kind: 'ROSTER_SEALED' });
  await integrity.createCheckpoint({ electionId: eid, kind: 'FINAL' });
  const rebuilt = await integrity.verifyChain(eid);
  check(
    '사슬을 통째로 다시 만들면 내부 검증은 통과한다 — 외부 고정이 필요한 이유',
    rebuilt.ok,
    '이래서 Anchor 가 있다',
  );

  await prisma.election.delete({ where: { id: eid } });
  await app.close();

  console.log(`\n\x1b[1m${pass} 통과${fail ? `, \x1b[31m${fail} 실패` : ''}\x1b[0m\n`);
  if (fail) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
