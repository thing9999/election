import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

/**
 * 본인확인 서비스 연동 (PASS / NICE / KCB / 간편인증).
 *
 * ── 왜 필요한가 ──
 * "휴대폰 + 생년월일 + 문자 인증"으로는
 *   · 명부에 없는 사람
 *   · 폰을 줍거나 훔친 사람
 *   · 명부의 번호가 낡아 지금은 남의 번호가 된 경우
 * 까지만 걸러진다. **가족·직원이 회원 폰을 들고 대리투표하는 것은 막지 못한다.**
 * 생년월일은 가족이면 아는 값이기 때문이다.
 *
 * 본인확인 서비스는 통신사에 등록된 명의와 대조하므로 "이 폰이 그 회원 본인
 * 명의인가"까지 확인된다.
 *
 * ── 우리 설계와 맞물리는 지점 ──
 * 명부는 해시만 갖고 있어서 이름·생년월일 평문을 **보낼 수가 없다.** 그래서
 * 방향을 뒤집는다 — 서비스가 인증된 신원을 **돌려주면**, 우리가 그걸 해시해서
 * 명부와 대조한다. 평문은 요청 처리 중에만 존재하고 어디에도 저장되지 않는다.
 *
 * ── CI(연계정보) ──
 * 사람 단위 식별자라 번호를 바꿔도 같다. 해시해서 저장해 두면 **같은 사람이 다른
 * 회원번호로 명부에 두 번 있을 때** 두 표를 던지는 걸 막을 수 있다.
 * CI 자체는 주민등록번호 파생값이므로 저장하지 않는다 — 해시만 둔다.
 * 보관 기간과 파기 절차를 선거관리규정에 명시하고 시작할 것.
 *
 * ── 그래도 못 막는 것 ──
 * 회원 본인이 옆에서 시켜서 하는 경우는 어떤 기술로도 막히지 않는다.
 * 그건 비밀투표와 매표 방지(영수증을 주지 않는 것)가 담당하는 영역이다.
 */

export interface VerifiedIdentity {
  /** 통신사에 등록된 실명 */
  name: string;
  /** YYYYMMDD */
  birthDate: string;
  /** E.164 */
  phoneE164: string;
  /** 연계정보. 저장 여부는 위 참고 */
  ci?: string;
}

export interface IdentityVerificationProvider {
  readonly name: string;
  /** 인증 창을 띄우기 위한 거래 시작 */
  begin(params: { electionId: string; returnUrl?: string }): Promise<{
    txId: string;
    /** 사용자를 보낼 곳. mock 은 null 이고 화면이 직접 입력을 받는다 */
    redirectUrl: string | null;
  }>;
  /** 콜백으로 받은 결과를 검증하고 신원을 돌려준다 */
  complete(params: { txId: string; payload: unknown }): Promise<VerifiedIdentity>;
}

/** mock 거래 파일 위치. 자동 테스트가 읽는다. */
export const DEV_IDENTITY_DIR = join(process.cwd(), '.dev-identity');

/**
 * 개발·검증용 mock.
 *
 * **운영에서 절대 쓰면 안 된다.** payload 에 담긴 이름·생년월일·번호를 그대로
 * "통신사가 확인해 줬다"고 취급하므로, 이게 켜져 있으면 아무나 남의 신원을
 * 주장할 수 있다. 그래서 NODE_ENV=production 이면 기동 자체를 거부한다.
 */
@Injectable()
export class MockIdentityProvider implements IdentityVerificationProvider, OnModuleInit {
  readonly name = 'mock';
  private readonly logger = new Logger(MockIdentityProvider.name);

  onModuleInit() {
    if (
      process.env.NODE_ENV === 'production' &&
      (process.env.IDENTITY_PROVIDER ?? 'mock') === 'mock' &&
      (process.env.IDENTITY_VERIFICATION ?? 'off') !== 'off'
    ) {
      throw new Error(
        'IDENTITY_PROVIDER=mock 인 채로 production 에서 본인확인을 켤 수 없습니다. ' +
          'mock 은 제출된 신원을 그대로 믿습니다 — 계약한 서비스를 연동하세요.',
      );
    }
  }

  async begin(params: { electionId: string }) {
    const txId = randomUUID();
    mkdirSync(DEV_IDENTITY_DIR, { recursive: true });
    writeFileSync(
      join(DEV_IDENTITY_DIR, `${txId}.json`),
      JSON.stringify({ txId, electionId: params.electionId, at: new Date().toISOString() }),
      'utf8',
    );
    this.logger.warn(`[MOCK 본인확인] 거래 시작 ${txId}`);
    // mock 은 보낼 곳이 없다. 화면이 직접 이름·생년월일·번호를 받는다.
    return { txId, redirectUrl: null };
  }

  async complete(params: { txId: string; payload: unknown }): Promise<VerifiedIdentity> {
    const file = join(DEV_IDENTITY_DIR, `${params.txId}.json`);
    if (!existsSync(file)) {
      throw new Error('본인확인 거래를 찾을 수 없습니다. 처음부터 다시 진행해 주세요.');
    }
    JSON.parse(readFileSync(file, 'utf8')); // 형식 확인
    rmSync(file, { force: true }); // 한 거래는 한 번만 쓴다

    const p = (params.payload ?? {}) as { name?: string; birthDate?: string; phone?: string };
    if (!p.name?.trim() || !p.birthDate?.trim() || !p.phone?.trim()) {
      throw new Error('이름·생년월일·휴대폰번호가 모두 필요합니다.');
    }

    // CI 는 **사람 단위** 식별자다. 번호를 바꿔도 같아야 하므로 전화번호는 섞지 않는다.
    const ci = createHash('sha256')
      .update(`mock-ci|${p.name.trim()}|${p.birthDate.replace(/\D/g, '')}`)
      .digest('hex');

    this.logger.warn(`[MOCK 본인확인] 통과 ${p.name.trim()} (${p.phone.trim()})`);
    return { name: p.name.trim(), birthDate: p.birthDate, phoneE164: p.phone.trim(), ci };
  }
}

/**
 * 실제 서비스 연동 자리 (미구현).
 *
 * ── 붙일 때 ──
 * 1) begin(): 서비스의 거래 생성 API 를 호출해 redirectUrl 을 받아 그대로 돌려준다.
 *    txId 는 우리 쪽에서 만들고 서비스의 거래번호와 함께 짧게 보관한다(TTL 5분).
 * 2) complete(): 콜백으로 받은 암호문을 **서비스가 준 키로 복호화하고 서명을 검증**한다.
 *    검증 없이 복호화만 하면 위조된 결과를 그대로 믿게 된다.
 * 3) 반환값의 이름·생년월일·번호를 우리가 해시해서 명부와 대조한다(IdentityService).
 * 4) 건당 비용이 발생한다(대략 50~100원). 1만 명이면 재시도 포함 예산을 잡을 것.
 * 5) 실패 사유를 사용자에게 그대로 노출하지 말 것 — 명부 존재 여부가 새어나간다.
 */
@Injectable()
export class RealIdentityProvider implements IdentityVerificationProvider {
  readonly name = 'real';

  async begin(): Promise<{ txId: string; redirectUrl: string | null }> {
    throw new Error(
      '본인확인 서비스가 아직 연동되지 않았습니다. ' +
        'apps/api/src/auth/identity-verification.ts 의 RealIdentityProvider 를 구현하세요.',
    );
  }

  async complete(): Promise<VerifiedIdentity> {
    throw new Error('본인확인 서비스가 아직 연동되지 않았습니다.');
  }
}
