/**
 * 부하 측정. "1만명이 동시에 눌러도 잠금 대기가 없다"는 주장을 실제로 재본다.
 *
 *   npm run seed --workspace=apps/api      # VOTER_COUNT 만큼 명부 생성
 *   npm run load --workspace=apps/api      # LOAD_N 명이 동시에 투표
 *
 * 인증(argon2)과 투표(DB 트랜잭션)를 분리해서 잰다. 둘의 비용이 완전히 다르고,
 * 실제 병목이 어디인지가 증설 계획을 좌우하기 때문이다.
 */
import 'dotenv/config';
import { ownerPrisma } from './owner-db';
import { readFileSync, existsSync } from 'fs';
import { devOtpPath } from '../src/auth/sms.service';
import { sealBallot } from '../../../packages/ballot-seal/seal';

const BASE = process.env.E2E_BASE ?? 'http://localhost:4000/api';
const N = Number(process.env.LOAD_N ?? 300);
const LOGIN_CONCURRENCY = Number(process.env.LOAD_LOGIN_CONCURRENCY ?? 25);

const prisma = ownerPrisma();

/** prisma/seed.ts 와 같은 규칙 */
function seedBirthDate(n: number): string {
  return (
    `${1950 + (n % 40)}` +
    String((n % 12) + 1).padStart(2, '0') +
    String((n % 28) + 1).padStart(2, '0')
  );
}
let ELECTION_PUBLIC_KEY = '';

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function login(electionId: string, n: number): Promise<string | null> {
  const phone = `010-0000-${String(n).padStart(4, '0')}`;
  const e164 = `+8210${String(n).padStart(8, '0')}`;
  const birthDate = seedBirthDate(n);

  const req = await call('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ electionId, phone, birthDate }),
  });
  if (!req.body?.challengeId) return null;

  const p = devOtpPath(e164);
  if (!existsSync(p)) return null;

  const ver = await call('/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: req.body.challengeId, code: readFileSync(p, 'utf8').trim() }),
  });
  return ver.body?.accessToken ?? null;
}

const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

async function main() {
  const election = await prisma.election.findFirst({
    where: { title: { startsWith: '[테스트]' } },
    include: { candidates: { orderBy: { ballotNumber: 'asc' } } },
  });
  if (!election) throw new Error('테스트 선거가 없습니다. seed 를 먼저 실행하세요.');
  if (election.status !== 'OPEN') {
    throw new Error(`선거 상태가 ${election.status} 입니다. seed 를 다시 실행하세요.`);
  }

  ELECTION_PUBLIC_KEY = election.ballotPublicKey!;
  const eligible = await prisma.voter.count({ where: { electionId: election.id } });
  console.log(`\n명부 ${eligible.toLocaleString()}명 중 ${N}명으로 측정\n`);

  // ── 1) 인증 단계 ──
  console.log(`1. 인증 (동시 ${LOGIN_CONCURRENCY})`);
  const tLogin = Date.now();
  const tokens: string[] = [];
  for (let i = 0; i < N; i += LOGIN_CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(LOGIN_CONCURRENCY, N - i) },
      (_, k) => login(election.id, i + k + 1),
    );
    for (const t of await Promise.all(batch)) if (t) tokens.push(t);
    process.stdout.write(`\r   ${tokens.length}/${N}`);
  }
  const loginMs = Date.now() - tLogin;
  console.log(
    `\r   ${tokens.length}명 인증 완료 · ${loginMs}ms · ` +
      `${(tokens.length / (loginMs / 1000)).toFixed(1)} 건/초\n`,
  );

  // ── 2) 봉인 (브라우저가 할 일) ──
  // 실제로는 각 유권자의 기기에서 한 번씩 일어난다. 서버 부하와 무관하므로
  // 발사 전에 미리 만들어 두고, 봉인 비용은 따로 잰다.
  const cands = election.candidates;
  const tSeal = Date.now();
  const sealedVotes: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    sealedVotes.push(await sealBallot(ELECTION_PUBLIC_KEY, cands[i % cands.length].id));
  }
  const sealMs = Date.now() - tSeal;
  console.log(
    `2. 봉인 ${tokens.length}건 · ${sealMs}ms · ` +
      `${(tokens.length / (sealMs / 1000)).toFixed(1)} 표/초 (기기 1대 기준)
`,
  );

  // ── 3) 투표 단계: 전원 동시 발사 ──
  console.log(`3. 봉인된 표 ${tokens.length}건 동시 전송`);
  const tVote = Date.now();
  const latencies: number[] = [];

  const results = await Promise.all(
    tokens.map(async (token, i) => {
      const t0 = Date.now();
      const r = await call('/vote', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sealedVote: sealedVotes[i] }),
      });
      latencies.push(Date.now() - t0);
      return r.status;
    }),
  );
  const voteMs = Date.now() - tVote;

  const ok = results.filter((s) => s === 200 || s === 201).length;
  const conflict = results.filter((s) => s === 409).length;
  const other = results.length - ok - conflict;
  latencies.sort((a, b) => a - b);

  console.log(`   성공 ${ok} · 중복차단 ${conflict} · 기타 ${other}`);
  console.log(`   전체 ${voteMs}ms · ${(ok / (voteMs / 1000)).toFixed(1)} 표/초`);
  console.log(
    `   지연 p50 ${pct(latencies, 0.5)}ms · p95 ${pct(latencies, 0.95)}ms · ` +
      `p99 ${pct(latencies, 0.99)}ms · max ${latencies[latencies.length - 1]}ms\n`,
  );

  // ── 3) 정합성 ──
  const [voted, ballots] = await Promise.all([
    prisma.voter.count({ where: { electionId: election.id, hasVoted: true } }),
    prisma.ballot.count({ where: { electionId: election.id } }),
  ]);
  console.log('4. 정합성');
  console.log(`   투표 처리된 유권자 ${voted} · 실제 표 ${ballots} · ${voted === ballots ? '일치' : '불일치!'}`);
  console.log(`   유실/중복 없음: ${ok === ballots ? '예' : `아니오 (성공 ${ok} vs 표 ${ballots})`}\n`);

  if (voted !== ballots || ok !== ballots) process.exit(1);
}

main()
  .catch((e) => {
    console.error('부하 측정 실패:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
