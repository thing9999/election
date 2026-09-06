/**
 * 봉인·개봉 검증. DB 없이 돌아간다.
 *   npm run crypto:check --workspace=apps/api
 *
 * 봉인 쪽은 브라우저가 실제로 쓰는 모듈을 그대로 불러온다 (Web Crypto 만 쓰므로
 * Node 에서도 동일하게 실행된다). 서버용 사본을 따로 두면 둘이 갈라지는 순간
 * 아무도 모르게 개표가 깨진다.
 */
import { randomUUID } from 'crypto';
import { sealBallot } from '../../../packages/ballot-seal/seal';
import {
  generateElectionKeyPair,
  keyPairMatches,
  openBallot,
  SEALED_BALLOT_LEN,
} from '../src/common/ballot-crypto';
import { split, combine, encodeShare, decodeShare } from '../src/common/shamir';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label} \x1b[31m${detail}\x1b[0m`); }
};

const b = (s: string) => Buffer.from(s, 'base64');

async function main() {
  const { publicKey, privateKey } = generateElectionKeyPair();
  const candA = randomUUID();
  const candB = randomUUID();

  console.log('\n\x1b[1m투표지 봉인 검증 — 브라우저 봉인 → 서버 개봉\x1b[0m\n');

  // 왕복
  const sealedA = b(await sealBallot(publicKey, candA));
  check('브라우저가 봉인한 표를 서버가 열면 원래 후보',
    openBallot(privateKey, publicKey, sealedA) === candA);
  check('기권도 왕복',
    openBallot(privateKey, publicKey, b(await sealBallot(publicKey, null))) === null);

  // 길이
  const lens = new Set([
    b(await sealBallot(publicKey, candA)).length,
    b(await sealBallot(publicKey, candB)).length,
    b(await sealBallot(publicKey, null)).length,
  ]);
  check('선택·기권 모두 암호문 길이가 동일', lens.size === 1 && lens.has(SEALED_BALLOT_LEN),
    `${[...lens].join(', ')} 바이트`);

  // 같은 후보를 100번
  const same: string[] = [];
  for (let i = 0; i < 100; i++) same.push(await sealBallot(publicKey, candA));
  check('같은 후보를 100번 봉인해도 암호문이 전부 다름', new Set(same).size === 100,
    `고유 ${new Set(same).size}/100`);

  // 흔적
  const raw = sealedA.toString('hex') + sealedA.toString('base64') + sealedA.toString('latin1');
  check('암호문에 후보 UUID 문자열이 없음',
    !raw.includes(candA) && !raw.includes(candA.replace(/-/g, '')));

  // 다른 선거 키
  const other = generateElectionKeyPair();
  let openedWrong = false;
  try { openBallot(other.privateKey, publicKey, sealedA); openedWrong = true; } catch { /* 기대한 실패 */ }
  check('다른 선거의 개인키로는 열리지 않음', !openedWrong);

  // 다른 선거 공개키로 봉인한 표를 이 선거에 밀어넣기
  const foreign = b(await sealBallot(other.publicKey, candA));
  let openedForeign = false;
  try { openBallot(privateKey, publicKey, foreign); openedForeign = true; } catch { /* 기대한 실패 */ }
  check('다른 선거용으로 봉인된 표는 이 선거에서 안 열림', !openedForeign);

  // 변조
  const tampered = Buffer.from(sealedA);
  tampered[90] ^= 0xff;
  let openedTampered = false;
  try { openBallot(privateKey, publicKey, tampered); openedTampered = true; } catch { /* 기대한 실패 */ }
  check('한 바이트만 바꿔도 개봉 실패 (변조 탐지)', !openedTampered);

  // 길이 이상
  let openedShort = false;
  try { openBallot(privateKey, publicKey, sealedA.subarray(0, 100)); openedShort = true; } catch { /* 기대한 실패 */ }
  check('길이가 다른 데이터 거부', !openedShort);

  // 키쌍 확인
  check('올바른 키쌍을 인식', keyPairMatches(publicKey, privateKey));
  check('엉뚱한 개인키를 거부', !keyPairMatches(publicKey, other.privateKey));

  // 처리량
  const N = 2000;
  // ── 개표키 분산 (Shamir) ──
  console.log('\n\x1b[1m개표키 분산\x1b[0m');
  {
    const shares = split(Buffer.from(privateKey, 'utf8'), 5, 3);
    check('5조각으로 나뉨', shares.length === 5);
    check('조각들이 서로 다름', new Set(shares.map((x) => x.y.toString('hex'))).size === 5);

    // 3개 조합 10가지를 전부 확인한다. 몇 가지만 보면 GF(256) 로그표가 부분적으로만
    // 맞는 버그를 놓친다 — 실제로 처음 구현에서 생성원을 2 로 잡아 그 버그를 냈다.
    let every = true;
    for (let a = 0; a < 5; a++)
      for (let b2 = a + 1; b2 < 5; b2++)
        for (let c2 = b2 + 1; c2 < 5; c2++)
          if (combine([shares[a], shares[b2], shares[c2]]).toString('utf8') !== privateKey) every = false;
    check('3개 조합 10가지 전부 복원', every);

    let few = false;
    try { combine(shares.slice(0, 2)); } catch { few = true; }
    check('2개로는 복원 거부 (담합 방지)', few);

    let mixed = false;
    try { combine([shares[0], shares[1], split(Buffer.from('다른 키'), 5, 3)[2]]); } catch { mixed = true; }
    check('다른 개표키의 조각을 섞으면 거부', mixed);

    const corrupt = shares.map((x) => ({ ...x, y: Buffer.from(x.y) }));
    corrupt[1].y[0] ^= 0xff;
    let detected = false;
    try { combine([corrupt[0], corrupt[1], corrupt[2]]); } catch { detected = true; }
    check('조각이 1비트 손상되어도 탐지', detected);

    const texts = shares.map(encodeShare);
    check('텍스트 형식 왕복', combine(texts.slice(0, 3).map(decodeShare)).toString('utf8') === privateKey,
      `조각 한 줄 ${texts[0].length}자`);
    check('복원한 키로 실제 개표 가능',
      keyPairMatches(publicKey, combine([shares[4], shares[0], shares[2]]).toString('utf8')));
  }

  console.log('\n\x1b[1m성능\x1b[0m');
  let t = Date.now();
  const bulk: Buffer[] = [];
  for (let i = 0; i < N; i++) bulk.push(b(await sealBallot(publicKey, i % 2 ? candA : candB)));
  const sealMs = Date.now() - t;
  t = Date.now();
  const opened = bulk.map((x) => openBallot(privateKey, publicKey, x));
  const openMs = Date.now() - t;
  check('대량 왕복 정확도',
    opened.filter((c, i) => c === (i % 2 ? candA : candB)).length === N);
  console.log(
    `\n  봉인 ${(N / (sealMs / 1000)).toFixed(0)} 표/초 (브라우저 경로) · ` +
      `개봉 ${(N / (openMs / 1000)).toFixed(0)} 표/초 ` +
      `\x1b[2m(1만표 개표 예상 ${((10000 / N) * openMs / 1000).toFixed(1)}초)\x1b[0m`,
  );

  console.log(`\n\x1b[1m${pass} 통과${fail ? `, \x1b[31m${fail} 실패` : ''}\x1b[0m\n`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
