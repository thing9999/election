/**
 * 관리자 계정의 현재 TOTP 코드를 출력한다. **로컬 테스트 전용.**
 *
 *   npm run totp --workspace=apps/api -- --id test
 *
 * 인증 앱 없이 관리자 화면을 열어보기 위한 도구다. DB 에서 TOTP 시크릿을 직접 읽으므로
 * 서버 접근 권한이 있는 사람만 실행할 수 있고, 그 사람은 어차피 무엇이든 할 수 있다.
 * 운영 환경에서는 이 스크립트를 배포하지 말 것 —
 * 2차 인증을 우회하는 것이 아니라, 2차 인증의 의미 자체를 없앤다.
 */
import 'dotenv/config';
import { ownerPrisma } from './owner-db';
import { generateSync, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';

const prisma = ownerPrisma();
const PLUGINS = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const loginId = arg('id');
  if (!loginId) {
    console.error('사용법: npm run totp --workspace=apps/api -- --id <아이디>');
    process.exit(1);
  }

  const admin = await prisma.adminUser.findUnique({
    where: { loginId },
    select: { name: true, role: true, totpSecret: true, totpConfirmedAt: true, lastTotpStep: true },
  });

  if (!admin) {
    console.error(`계정을 찾을 수 없습니다: ${loginId}`);
    process.exit(1);
  }
  if (!admin.totpSecret) {
    console.error(
      `${loginId} 은 아직 2차 인증이 등록되지 않았습니다.\n` +
        '관리자 화면에서 아이디·비밀번호로 로그인해 QR 화면까지 간 다음 다시 실행하세요.\n' +
        '(그 화면을 여는 순간 시크릿이 만들어집니다)',
    );
    process.exit(1);
  }

  const code = generateSync({ ...PLUGINS, secret: admin.totpSecret });
  const step = Math.floor(Date.now() / 30000);
  const remain = 30 - Math.floor((Date.now() % 30000) / 1000);

  console.log('\n─────────────────────────────────────────────');
  console.log(`계정     : ${loginId} (${admin.name})`);
  console.log(`인증번호 : ${code}`);
  console.log(`남은 시간: ${remain}초`);

  // 같은 슬롯의 코드는 한 번만 쓸 수 있다. 방금 쓴 코드를 또 받으면 거부된다.
  if (admin.lastTotpStep !== null && Number(admin.lastTotpStep) >= step) {
    console.log('\n※ 이 번호는 이미 사용되었습니다.');
    console.log(`   ${remain}초 뒤 다시 실행해 새 번호를 받으세요.`);
  }
  console.log('─────────────────────────────────────────────\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
