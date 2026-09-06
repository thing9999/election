import { createHash, randomBytes } from 'crypto';

/**
 * 개표키 분산 (Shamir's Secret Sharing, GF(256)).
 *
 * ── 왜 필요한가 ──
 * 지금까지 개표키는 base64 문자열 하나였고 서버 어디에도 없었다. 그건 맞는 설계인데,
 * 두 가지 문제가 따라온다:
 *
 *   1) 그걸 든 사람이 잃어버리면 **개표가 영구히 불가능하다.** 복구 경로가 없다.
 *      1만 명이 던진 표가 전부 열리지 않은 채로 끝난다. 아무도 공격하지 않아도 터진다.
 *   2) 한 사람이 통째로 들고 있으면 그 사람만 믿어야 한다. 개표를 2인 승인으로
 *      막아놓고 키는 한 명이 쥐고 있으면 dual control 이 반쪽이다.
 *
 * 5명에게 나눠 3명이 모여야 복원되는 구조로 두 문제가 같이 풀린다.
 * 2명까지 잃어버려도 개표할 수 있고, 2명이 담합해도 아무것도 못 한다.
 *
 * ── 왜 안전한가 ──
 * k-1 개 이하의 조각으로는 원본에 대해 **아무것도** 알 수 없다. 계산이 어려운 게
 * 아니라 정보 자체가 없다(information-theoretic). k 차 다항식은 k-1 개의 점만으로는
 * 어떤 상수항도 똑같이 가능하기 때문이다.
 *
 * ── 서버는 이 파일을 개표에 쓰지 않는다 ──
 * 조각을 합치는 건 선관위원들이 **오프라인 CLI 로** 한다. 서버가 조각을 받으면
 * 그 순간 서버가 개표키를 아는 것이 되어 분산의 의미가 사라진다.
 *   npm run key:split   --workspace=apps/api
 *   npm run key:combine --workspace=apps/api
 */

// ── GF(256) — AES 와 같은 기약다항식 0x11b ──
//
// 생성원은 **3**이다. 2 를 쓰면 안 된다 — 이 체에서 2 의 위수는 51 이라
// 로그표의 5분의 4가 0 으로 남고, mul(a,3) 이 mul(a,1) 과 같아지는 식으로
// 조용히 틀린 값을 낸다. (실제로 이 구현에서 처음에 그 버그를 냈고,
// "3개 조합 10가지가 전부 복원되는가" 테스트가 잡아냈다.)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    let d = x << 1;                 // x·2
    if (d & 0x100) d ^= 0x11b;
    x = d ^ x;                      // x·3 = x·2 + x
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  // 표가 실제로 0 을 뺀 전체를 한 번씩 도는지 확인한다.
  // 위 같은 실수는 결과가 그럴듯해 보여서 눈으로는 안 잡힌다.
  const seen = new Set(Array.from(EXP.slice(0, 255)));
  if (seen.size !== 255 || seen.has(0)) {
    throw new Error('GF(256) 로그표가 잘못되었습니다. 생성원을 확인하세요.');
  }
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a: number, b: number) => {
  if (b === 0) throw new Error('GF(256) 0으로 나눔');
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
};

export const MAX_SHARES = 255; // x 는 1..255 (0 은 비밀 자리라 쓸 수 없다)

/** 조각 하나 */
export interface Share {
  /** 다항식을 평가한 지점. 1..255, 조각마다 달라야 한다 */
  x: number;
  /** 복원에 필요한 최소 개수 */
  threshold: number;
  /** 원본 바이트 수 */
  length: number;
  y: Buffer;
  /** 원본의 해시 앞 4바이트. 엉뚱한 조각을 섞었을 때 즉시 알아채기 위한 것 */
  checksum: string;
}

const checksumOf = (secret: Buffer) =>
  createHash('sha256').update(secret).digest('hex').slice(0, 8);

/**
 * 비밀을 n 조각으로 나눈다. 그중 k 개가 모이면 복원된다.
 */
export function split(secret: Buffer, n: number, k: number): Share[] {
  if (secret.length === 0) throw new Error('빈 값은 나눌 수 없습니다.');
  if (k < 2) throw new Error('임계값(k)은 2 이상이어야 합니다. 1이면 나누는 의미가 없습니다.');
  if (n < k) throw new Error(`조각 수(n=${n})가 임계값(k=${k})보다 적습니다.`);
  if (n > MAX_SHARES) throw new Error(`조각은 최대 ${MAX_SHARES}개입니다.`);

  const checksum = checksumOf(secret);
  const ys = Array.from({ length: n }, () => Buffer.alloc(secret.length));

  for (let pos = 0; pos < secret.length; pos++) {
    // f(0) = 비밀 바이트, 나머지 계수는 매번 새로 뽑는다.
    // 계수를 재사용하면 여러 비밀을 나눴을 때 서로를 복원할 수 있게 된다.
    const coeffs = randomBytes(k - 1);

    for (let i = 0; i < n; i++) {
      const x = i + 1;
      // 호너 법: f(x) = c_{k-1}·x^{k-1} + … + c_1·x + secret
      let acc = 0;
      for (let d = k - 2; d >= 0; d--) acc = mul(acc, x) ^ coeffs[d];
      ys[i][pos] = mul(acc, x) ^ secret[pos];
    }
  }

  return ys.map((y, i) => ({
    x: i + 1, threshold: k, length: secret.length, y, checksum,
  }));
}

/**
 * 조각을 합쳐 원본을 복원한다. x=0 에서의 라그랑주 보간.
 */
export function combine(shares: Share[]): Buffer {
  if (shares.length === 0) throw new Error('조각이 없습니다.');

  const k = shares[0].threshold;
  const len = shares[0].length;
  const checksum = shares[0].checksum;

  for (const s of shares) {
    if (s.threshold !== k) throw new Error('서로 다른 분산에서 나온 조각이 섞여 있습니다 (임계값 불일치).');
    if (s.checksum !== checksum) throw new Error('서로 다른 개표키의 조각이 섞여 있습니다 (검증값 불일치).');
    if (s.y.length !== len) throw new Error('조각의 길이가 서로 다릅니다.');
    if (s.x < 1 || s.x > MAX_SHARES) throw new Error(`조각 번호가 올바르지 않습니다: ${s.x}`);
  }

  const xs = new Set(shares.map((s) => s.x));
  if (xs.size !== shares.length) throw new Error('같은 번호의 조각이 두 번 들어왔습니다.');
  if (shares.length < k) {
    throw new Error(`조각이 ${shares.length}개뿐입니다. ${k}개가 필요합니다.`);
  }

  // k 개만 쓴다. 더 넣어도 결과는 같지만 굳이 계산할 이유가 없다.
  const use = shares.slice(0, k);
  const out = Buffer.alloc(len);

  for (let pos = 0; pos < len; pos++) {
    let acc = 0;
    for (let i = 0; i < use.length; i++) {
      // L_i(0) = ∏_{j≠i} x_j / (x_j - x_i)   ※ GF(256) 에서 뺄셈은 XOR
      let basis = 1;
      for (let j = 0; j < use.length; j++) {
        if (i === j) continue;
        basis = mul(basis, div(use[j].x, use[i].x ^ use[j].x));
      }
      acc ^= mul(use[i].y[pos], basis);
    }
    out[pos] = acc;
  }

  if (checksumOf(out) !== checksum) {
    throw new Error('복원 결과가 검증값과 다릅니다. 조각 중 하나가 손상되었습니다.');
  }
  return out;
}

// ── 사람이 주고받을 수 있는 텍스트 형식 ──
//   KMA-KEY-1.<k>.<x>.<base64url(y)>.<checksum>
// 종이에 적어 봉투에 넣거나, 각자 다른 경로로 전달할 수 있어야 한다.

const PREFIX = 'KMA-KEY-1';

export function encodeShare(s: Share): string {
  return [PREFIX, s.threshold, s.x, s.y.toString('base64url'), s.checksum].join('.');
}

export function decodeShare(text: string): Share {
  const t = text.trim();
  const parts = t.split('.');
  if (parts.length !== 5 || parts[0] !== PREFIX) {
    throw new Error(`조각 형식이 올바르지 않습니다: ${t.slice(0, 24)}…`);
  }
  const [, kStr, xStr, yB64, checksum] = parts;
  const threshold = Number(kStr);
  const x = Number(xStr);
  const y = Buffer.from(yB64, 'base64url');
  if (!Number.isInteger(threshold) || threshold < 2) throw new Error('조각의 임계값이 올바르지 않습니다.');
  if (!Number.isInteger(x) || x < 1 || x > MAX_SHARES) throw new Error('조각 번호가 올바르지 않습니다.');
  if (!/^[0-9a-f]{8}$/.test(checksum)) throw new Error('조각의 검증값이 올바르지 않습니다.');
  if (y.length === 0) throw new Error('조각이 비어 있습니다.');
  return { x, threshold, length: y.length, y, checksum };
}
