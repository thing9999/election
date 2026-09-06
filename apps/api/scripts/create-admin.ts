/**
 * 관리자 계정 생성. 부트스트랩용 CLI.
 *
 *   npm run admin:create --workspace=apps/api -- --id kim --name 김위원 --role COMMISSIONER
 *
 * 비밀번호는 인자로 받지 않는다. 셸 히스토리와 프로세스 목록에 남기 때문이다.
 * 생성된 임시 비밀번호를 출력하고, 최초 로그인 시 TOTP 등록과 비밀번호 변경을 강제한다.
 *
 * 이 스크립트는 서버 접근 권한이 있는 사람만 실행할 수 있다 —
 * 관리자 계정을 만드는 HTTP 엔드포인트는 일부러 만들지 않았다.
 */
import 'dotenv/config';
import { type AdminRole } from '@prisma/client';
import { ownerPrisma } from './owner-db';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

const prisma = ownerPrisma();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 읽어서 옮겨적기 쉬운 임시 비밀번호. 혼동되는 글자는 뺀다. */
function tempPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(20))
    .map((b) => alphabet[b % alphabet.length])
    .join('');
}

async function main() {
  const loginId = arg('id');
  const name = arg('name');
  const role = (arg('role') ?? 'COMMISSIONER') as AdminRole;

  if (!loginId || !name) {
    console.error(
      '사용법: npm run admin:create --workspace=apps/api -- --id <아이디> --name <이름> ' +
        '[--role COMMISSIONER|AUDITOR] [--password <비밀번호>]',
    );
    process.exit(1);
  }
  if (role !== 'COMMISSIONER' && role !== 'AUDITOR') {
    console.error('role 은 COMMISSIONER 또는 AUDITOR 여야 합니다.');
    process.exit(1);
  }

  const existing = await prisma.adminUser.findUnique({ where: { loginId } });
  if (existing) {
    console.error(`이미 존재하는 아이디입니다: ${loginId}`);
    process.exit(1);
  }

  // --password 로 직접 지정할 수 있다. 로컬 테스트 계정처럼 아는 값이 필요할 때 쓴다.
  // 셸 히스토리와 프로세스 목록에 남으므로 운영 계정에는 쓰지 말 것.
  const given = arg('password');
  const password = given ?? tempPassword();
  if (given && given.length < 12) {
    console.warn(
      `\n[경고] 비밀번호가 ${given.length}자입니다. 로컬 테스트용으로만 쓰세요 — ` +
        '선관위 계정 하나가 뚫리면 선거 전체가 무너집니다. ' +
        '운영에서는 --password 없이 실행해 난수 비밀번호를 발급받으세요.\n',
    );
  }
  const admin = await prisma.adminUser.create({
    data: { loginId, name, role, passwordHash: await argon2.hash(password) },
  });

  const commissioners = await prisma.adminUser.count({
    where: { role: 'COMMISSIONER', disabledAt: null },
  });

  console.log('\n─────────────────────────────────────────────');
  console.log(`아이디     : ${admin.loginId}`);
  console.log(`이름       : ${admin.name}`);
  console.log(`역할       : ${admin.role}${role === 'AUDITOR' ? ' (읽기 전용)' : ''}`);
  console.log(`비밀번호   : ${password}${given ? ' (직접 지정)' : ' (자동 생성)'}`);
  console.log('─────────────────────────────────────────────');
  if (!given) console.log('이 비밀번호는 다시 볼 수 없습니다. 본인에게 직접 전달하세요.');
  console.log('최초 로그인 시 2차 인증(TOTP) 등록이 필요합니다.\n');

  if (role === 'COMMISSIONER' && commissioners < 2) {
    console.log(
      `⚠  현재 선관위원이 ${commissioners}명입니다. 개표에는 서로 다른 위원 2명의 승인이\n` +
        '   필요하므로, 최소 2명을 등록해야 개표할 수 있습니다.\n',
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
