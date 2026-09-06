/**
 * 개표키를 여러 조각으로 나눈다.
 *
 *   npm run key:split --workspace=apps/api -- --n 5 --k 3
 *
 * 개표키를 붙여넣으면 조각을 출력한다. 조각을 서로 다른 선관위원에게 하나씩
 * 나눠주고, 원본은 파기한다.
 *
 * ── 왜 CLI 인가 ──
 * 서버에 이 기능을 두면 서버가 개표키를 아는 순간이 생긴다. 그러면 분산의 의미가
 * 사라진다. 이 스크립트는 **네트워크를 쓰지 않고 DB 에도 붙지 않는다** —
 * 인터넷이 끊긴 노트북에서 돌려도 된다.
 */
import { createInterface } from 'readline';
import { split, encodeShare } from '../src/common/shamir';
import { keyPairMatches } from '../src/common/ballot-crypto';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const N = Number(arg('n', '5'));
const K = Number(arg('k', '3'));
const PUBLIC_KEY = arg('public-key');

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function main() {
  console.log('\n\x1b[1m개표키 분산\x1b[0m');
  console.log(`  ${N}조각으로 나누고, 그중 \x1b[1m${K}개\x1b[0m가 모이면 복원됩니다.`);
  console.log(`  \x1b[2m조각 ${N - K}개까지 잃어버려도 개표할 수 있고, ${K - 1}명이 담합해도 아무것도 못 합니다.\x1b[0m\n`);

  const key = await ask('개표키를 붙여넣으세요: ');
  if (!key) throw new Error('입력이 비어 있습니다.');

  // 선거 공개키를 같이 주면 "이 키가 그 선거의 것이 맞는지" 여기서 확인해 준다.
  // 엉뚱한 키를 나눠놓고 개표 날에 알게 되는 것보다 지금 아는 게 낫다.
  if (PUBLIC_KEY) {
    if (!keyPairMatches(PUBLIC_KEY, key)) {
      throw new Error('이 개표키는 지정한 선거 공개키와 짝이 아닙니다.');
    }
    console.log('\x1b[32m✓ 선거 공개키와 짝이 맞습니다.\x1b[0m');
  } else {
    console.log('\x1b[2m(--public-key 를 주면 이 키가 그 선거의 것인지 확인해 드립니다)\x1b[0m');
  }

  const shares = split(Buffer.from(key, 'utf8'), N, K);

  console.log('\n─────────────────────────────────────────────');
  shares.forEach((s, i) => {
    console.log(`\n\x1b[1m조각 ${i + 1} / ${N}\x1b[0m`);
    console.log(encodeShare(s));
  });
  console.log('\n─────────────────────────────────────────────\n');

  console.log('\x1b[33m이제 해야 할 일\x1b[0m');
  console.log('  1. 조각을 서로 다른 선관위원에게 \x1b[1m하나씩\x1b[0m 전달합니다.');
  console.log('     한 사람이 두 조각을 가지면 정족수가 그만큼 낮아집니다.');
  console.log('  2. 전달 경로도 나누세요. 같은 메신저로 전부 보내면 그 계정 하나가 뚫릴 때 끝입니다.');
  console.log('  3. \x1b[1m원본 개표키를 파기합니다.\x1b[0m 남겨두면 분산한 의미가 없습니다.');
  console.log('     (개발 중 생성된 apps/api/.election-key.txt 도 함께)');
  console.log('  4. 누가 몇 번 조각을 받았는지 기록해 두세요. 개표 날 모으려면 필요합니다.');
  console.log('     기록에 조각 값 자체를 적지는 마세요 — 번호와 이름만.\n');
}

main().catch((e) => {
  console.error(`\n\x1b[31m${(e as Error).message}\x1b[0m\n`);
  process.exit(1);
});
