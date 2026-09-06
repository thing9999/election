/**
 * 조각을 모아 개표키를 복원한다.
 *
 *   npm run key:combine --workspace=apps/api -- --public-key <선거 공개키>
 *
 * 조각을 한 줄씩 붙여넣고, 다 넣으면 빈 줄을 입력합니다.
 *
 * ── 개표 당일 절차 ──
 * 선관위원들이 **한자리에 모여** 각자 자기 조각을 입력합니다. 복원된 키는 화면에만
 * 나오고 어디에도 저장되지 않으므로, 그 자리에서 관리자 화면에 붙여넣고 개표합니다.
 * 이 스크립트도 네트워크를 쓰지 않고 DB 에 붙지 않습니다.
 */
import { createInterface } from 'readline';
import { combine, decodeShare, type Share } from '../src/common/shamir';
import { keyPairMatches } from '../src/common/ballot-crypto';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PUBLIC_KEY = arg('public-key');

async function main() {
  console.log('\n\x1b[1m개표키 복원\x1b[0m');
  console.log('  조각을 한 줄씩 붙여넣고, 다 넣었으면 \x1b[1m빈 줄\x1b[0m을 입력하세요.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const shares: Share[] = [];
  let need: number | null = null;

  for (;;) {
    const line: string = await new Promise((r) => rl.question(`조각 ${shares.length + 1}: `, r));
    if (!line.trim()) break;

    let s: Share;
    try {
      s = decodeShare(line);
    } catch (e) {
      console.log(`  \x1b[31m${(e as Error).message}\x1b[0m`);
      continue;
    }
    if (shares.some((p) => p.x === s.x)) {
      console.log(`  \x1b[31m${s.x}번 조각은 이미 넣었습니다.\x1b[0m`);
      continue;
    }
    if (shares.length && s.checksum !== shares[0].checksum) {
      console.log('  \x1b[31m다른 개표키의 조각입니다 (검증값 불일치).\x1b[0m');
      continue;
    }

    shares.push(s);
    need = s.threshold;
    const left = Math.max(0, need - shares.length);
    console.log(
      left > 0
        ? `  \x1b[32m✓\x1b[0m ${s.x}번 조각 (${shares.length}/${need}) — ${left}개 더 필요합니다`
        : `  \x1b[32m✓\x1b[0m ${s.x}번 조각 (${shares.length}/${need}) — 이제 복원할 수 있습니다`,
    );
    if (shares.length >= need) break;
  }
  rl.close();

  if (need === null) throw new Error('조각이 하나도 입력되지 않았습니다.');
  if (shares.length < need) {
    throw new Error(`조각이 ${shares.length}개뿐입니다. ${need}개가 필요합니다.`);
  }

  const key = combine(shares).toString('utf8');

  if (PUBLIC_KEY) {
    if (!keyPairMatches(PUBLIC_KEY, key)) {
      // 여기까지 왔는데 안 맞으면 조각은 멀쩡한데 다른 선거의 키라는 뜻이다.
      throw new Error('복원은 됐지만 이 선거의 개표키가 아닙니다. 공개키를 다시 확인하세요.');
    }
    console.log('\n\x1b[32m✓ 선거 공개키와 짝이 맞습니다.\x1b[0m');
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(key);
  console.log('─────────────────────────────────────────────\n');
  console.log('\x1b[33m이 값은 저장되지 않았습니다.\x1b[0m 관리자 화면에 붙여넣어 개표하세요.');
  console.log('\x1b[2m터미널 스크롤백에 남으니, 개표 후 창을 닫으세요.\x1b[0m\n');
}

main().catch((e) => {
  console.error(`\n\x1b[31m${(e as Error).message}\x1b[0m\n`);
  process.exit(1);
});
