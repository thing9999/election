/**
 * 감사 로그 반출본을 검증하고, DB 와 대조한다.
 *
 *   npm run audit:check --workspace=apps/api
 *
 * 두 가지를 본다:
 *   1) 반출본 사슬이 온전한가 — 중간을 지우거나 고치면 뒤가 전부 어긋난다
 *   2) 반출이 **덮고 있는 구간** 안에서, DB 에 있어야 할 줄이 다 있는가
 *      → **DB 에서 지워진 로그를 찾아낸다.** 이게 이 스크립트의 존재 이유다.
 *
 * 사슬은 프로세스(인스턴스)마다 따로 이어진다. 여러 인스턴스가 한 파일에 append 하면
 * 서로의 사슬이 끼어들어 전부 깨지기 때문이다. 그래서 파일별로 검증하고 합쳐서 본다.
 */
import 'dotenv/config';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { verifyExportedChain, type ExportedLine } from '../src/common/audit-sink';
import { ownerPrisma } from './owner-db';

const DIR = process.env.AUDIT_EXPORT_DIR || join(process.cwd(), 'audit-export');

let pass = 0, fail = 0;
const ok = (l: string, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}${d ? ` \x1b[2m(${d})\x1b[0m` : ''}`); };
const bad = (l: string, d: string) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l} \x1b[31m${d}\x1b[0m`); };

async function main() {
  console.log('\n\x1b[1m감사 로그 반출본 검증\x1b[0m\n');

  const files = existsSync(DIR)
    ? readdirSync(DIR).filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
    : [];

  if (files.length === 0) {
    console.log(`  \x1b[33m!\x1b[0m 반출본이 없습니다: ${DIR}`);
    console.log('    AUDIT_SINKS="FILE" 로 켜고 서버를 다시 띄우세요.');
    console.log('    \x1b[2m반출이 없으면 DB 에서 로그를 지워도 알 수 없습니다.\x1b[0m\n');
    process.exit(1);
  }
  console.log(`  경로: \x1b[2m${DIR}\x1b[0m`);
  console.log(`  인스턴스 \x1b[1m${files.length}개\x1b[0m\n`);

  // ── 1. 사슬 ──
  console.log('\x1b[1m1. 반출본 사슬 (인스턴스별)\x1b[0m');
  const lines: ExportedLine[] = [];
  let broken = 0;

  for (const f of files) {
    const text = readFileSync(join(DIR, f), 'utf8');
    const r = verifyExportedChain(text);
    const label = f.replace(/^audit-|\.jsonl$/g, '');
    // 파일 수는 실행 횟수에 따라 늘어난다. 항목 수가 흔들리지 않도록
    // 개별 파일은 참고 출력으로만 두고, 판정은 아래 집계 한 줄로 한다.
    if (r.ok) console.log(`    [2m· ${label}  ${r.lines}줄[0m`);
    else {
      broken++;
      bad(`${label}`, `${r.problems.length}건`);
      r.problems.slice(0, 3).forEach((p) => console.log(`      \x1b[31m· ${p}\x1b[0m`));
    }
    for (const raw of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      try { lines.push(JSON.parse(raw)); } catch { /* 위에서 이미 보고됨 */ }
    }
  }
  if (broken === 0) ok('모든 인스턴스의 사슬이 온전함', `총 ${lines.length}줄`);

  // ── 2. DB 대조 ──
  console.log('\n\x1b[1m2. DB 와 대조\x1b[0m');
  const db = ownerPrisma();

  // 반출이 덮는 구간. 이 시각 이전의 DB 로그는 반출이 켜지기 전 것이라 판단 대상이 아니다.
  const coverageStart = lines.reduce<string | null>(
    (min, l) => (min === null || l.at < min ? l.at : min), null,
  );
  const exportedIds = new Set(lines.map((l) => l.id));

  const dbRows = await db.auditLog.findMany({ select: { id: true, createdAt: true } });
  const inCoverage = dbRows.filter((r) => coverageStart !== null && r.createdAt.toISOString() >= coverageStart);
  const beforeCoverage = dbRows.length - inCoverage.length;

  console.log(`  \x1b[2mDB ${dbRows.length}줄 · 반출본 ${lines.length}줄 · 반출 시작 ${coverageStart ?? '-'}\x1b[0m`);
  if (beforeCoverage > 0) {
    console.log(`  \x1b[2m반출 시작 이전 ${beforeCoverage}줄은 대조 대상이 아닙니다 (그 구간은 검증할 수 없습니다).\x1b[0m`);
  }

  // 반출본에는 있는데 DB 에 없다 = 누군가 DB 에서 지웠다
  const dbIds = new Set(dbRows.map((r) => String(r.id)));
  const missingInDb = lines.filter((l) => !dbIds.has(l.id));
  if (missingInDb.length === 0) {
    ok('반출본의 모든 줄이 DB 에도 있음');
  } else {
    bad('DB 에서 사라진 감사 로그가 있음', `${missingInDb.length}줄 — 누군가 지웠습니다`);
    for (const l of missingInDb.slice(0, 5)) {
      console.log(`      \x1b[31m· id=${l.id} ${l.at} ${l.action} (${l.actorType})\x1b[0m`);
    }
  }

  // 반출은 비동기다. 마지막으로 반출된 줄보다 **뒤에** 생긴 DB 로그는
  // 아직 큐에 있거나 종료 순간 유실된 "꼬리"이고, 그 **사이에** 빠진 줄은
  // 반출이 중간에 실패했다는 뜻이라 성격이 다르다. 둘을 섞으면 진짜 문제가 묻힌다.
  const lastExportedAt = lines.reduce<string | null>(
    (max, l) => (max === null || l.at > max ? l.at : max), null,
  );
  const missing = inCoverage.filter((r) => !exportedIds.has(String(r.id)));
  const holes = missing.filter((r) => lastExportedAt !== null && r.createdAt.toISOString() <= lastExportedAt);
  const tail = missing.length - holes.length;

  if (holes.length === 0) {
    ok('반출 구간 안에 빠진 줄이 없음', `${inCoverage.length - tail}줄 대조`);
  } else {
    bad('반출 중간에 빠진 줄이 있음',
      `${holes.length}줄 — 반출이 실패했습니다. 그만큼 검증 사각이 생깁니다`);
  }
  if (tail > 0) {
    console.log(
      `  \x1b[2m마지막 반출 이후 ${tail}줄은 아직 큐에 있거나 종료 시 유실된 꼬리입니다 ` +
      `(정상 종료면 비워집니다).\x1b[0m`,
    );
  }

  await db.$disconnect();

  console.log(`\n\x1b[1m${pass} 통과${fail ? `, \x1b[31m${fail} 실패` : ''}\x1b[0m`);
  if (fail === 0) {
    console.log('\x1b[2m참고: 이 파일들이 같은 서버 안에 있는 한 공격자가 사슬을 통째로 다시 만들 수 있습니다.\x1b[0m');
    console.log('\x1b[2m      append-only 외부 저장소로 복제해야 비로소 고정이 됩니다.\x1b[0m');
  }
  console.log('');
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
