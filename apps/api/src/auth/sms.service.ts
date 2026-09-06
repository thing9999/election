import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

/** mock 모드에서만 쓰는 인증번호 임시 디렉터리. E2E 스크립트가 이걸 읽는다. */
export const DEV_OTP_DIR = join(process.cwd(), '.dev-otp');

/** mock 모드에서 실제로 나간 문자 전문. 검증 스크립트가 "무엇을 보냈는지" 확인한다. */
export const DEV_SMS_DIR = join(process.cwd(), '.dev-sms');
export const devSmsPath = (phoneE164: string) =>
  join(DEV_SMS_DIR, `${phoneE164.replace(/[^0-9]/g, '')}.log`);

/** 파일명으로 쓸 수 있게 E.164 를 정규화 (+ 제거) */
export const devOtpPath = (phoneE164: string) =>
  join(DEV_OTP_DIR, `${phoneE164.replace(/[^0-9]/g, '')}.txt`);

/**
 * OTP 발송. 개발 중에는 mock 으로 콘솔에 찍고,
 * 운영에서는 NAVER SENS / NHN Toast / 알리고 중 계약한 곳으로 교체한다.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly config: ConfigService) {}

  async sendOtp(phoneE164: string, code: string): Promise<void> {
    const provider = this.config.get<string>('SMS_PROVIDER', 'mock');

    if (provider === 'mock') {
      // 자동 테스트가 인증번호를 집어갈 수 있도록 파일에 남긴다.
      // 번호마다 별도 파일에 쓴다 — 한 파일에 몰면 동시 요청 시
      // read-modify-write 가 겹쳐 파일이 깨진다.
      // provider 가 mock 이 아니면 이 블록에 진입하지 않으므로 운영에는 존재하지 않는다.
      try {
        mkdirSync(DEV_OTP_DIR, { recursive: true });
        writeFileSync(devOtpPath(phoneE164), code, 'utf8');
      } catch (e) {
        this.logger.error('mock OTP 파일 기록 실패', e as Error);
      }
    }

    await this.send(phoneE164, `[협회장선거] 인증번호 ${code} (3분 이내 입력)`);
  }

  /**
   * 투표 완료 문자.
   *
   * ── 왜 필요한가 ──
   * 명부에 있는 **기권자 명의로 표를 채우는 것**은 무결성 사슬로도, DB 권한 분리로도
   * 잡히지 않는다. 명부가 그대로라 rosterHash 가 안 변하고, hasVoted 와 표 수를
   * 같이 고치면 대조도 통과한다. 실제로 확인했다.
   *
   * 이걸 잡는 유일한 수단이 이 문자다. 투표하지 않은 회원이 "투표가 완료되었습니다"를
   * 받으면 그 자리에서 드러난다. 문자는 협회 서버 밖(통신사)을 지나 회원 손전화에
   * 남으므로 조작 범위 밖이다. **1만 명이 각자 자기 한 표의 참관인이 된다.**
   *
   * ── 여기에 후보를 적으면 안 된다 ──
   * 누구를 찍었는지 문자에 담으면 그게 곧 영수증이 되어 매표가 성립한다.
   * 서버는 애초에 알지도 못하지만, 실수로라도 넣지 말 것.
   */
  async sendVoteReceipt(phoneE164: string, confirmationCode: string): Promise<void> {
    await this.send(
      phoneE164,
      `[협회장선거] 투표가 완료되었습니다. 확인번호 ${confirmationCode}\n` +
        '본인이 투표하지 않으셨다면 즉시 선거관리위원회로 연락해 주세요.',
    );
  }

  /** 참관인·후보 캠프에 체크포인트 해시 발송 */
  async sendObserverAnchor(phoneE164: string, text: string): Promise<void> {
    await this.send(phoneE164, text);
  }

  /** 실제 발송 지점. provider 를 갈아끼우는 곳은 여기 한 군데다. */
  private async send(phoneE164: string, text: string): Promise<void> {
    const provider = this.config.get<string>('SMS_PROVIDER', 'mock');
    if (provider === 'mock') {
      const flat = text.replace(/\n/g, ' / ');
      this.logger.warn(`[MOCK SMS] ${phoneE164} → ${flat}`);
      // 검증 스크립트가 "정말로 보냈는지, 무엇을 보냈는지"를 확인할 수 있어야 한다.
      // 특히 투표 완료 문자에 후보가 섞여 들어가지 않았는지 대조하는 데 쓴다.
      try {
        mkdirSync(DEV_SMS_DIR, { recursive: true });
        appendFileSync(devSmsPath(phoneE164), `${new Date().toISOString()}\t${flat}\n`, 'utf8');
      } catch (e) {
        this.logger.error('mock SMS 기록 실패', e as Error);
      }
      return;
    }

    // TODO: 실제 provider 연동.
    //   NAVER SENS  : POST https://sens.apigw.ntruss.com/sms/v2/services/{id}/messages
    //   NHN Toast   : POST https://api-sms.cloud.toast.com/sms/v3.0/appKeys/{key}/sender/sms
    // 발송 실패는 반드시 예외로 던져야 한다. 조용히 넘기면
    // 유권자는 문자를 못 받았는데 서버는 성공으로 알고 있게 된다.
    throw new Error(`SMS provider '${provider}' 가 아직 연동되지 않았습니다.`);
  }
}
