import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { SmsService } from './sms.service';
import {
  hashIdentifier,
  normalizePhone,
  normalizeBirthDate,
  generateOtp,
  safeEqual,
} from '../common/crypto.util';

/**
 * OTP 해싱 파라미터.
 *
 * argon2 라이브러리 기본값(64MiB, t=3, p=4)은 수년간 유지되는 비밀번호 기준이다.
 * 우리가 해싱하는 건 3분 만료 · 5회 오입력 잠금이 걸린 6자리 코드라 그 정도가 필요 없고,
 * 그 값으로는 로그인 처리량이 코어당 9건/초까지 떨어져 마감 직전 트래픽을 못 버틴다.
 *
 * OWASP argon2id 최소 권장치(19MiB, t=2, p=1)를 기본으로 쓴다.
 * DB 가 털려도 공격자에게 남는 건 3분짜리 창이며, 그 안에 10^6 을 argon2 로
 * 전수 대입하는 비용은 여전히 유의미하다.
 */
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 19456),
  timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
  parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
} as const;

const OTP_TTL_MS = 3 * 60 * 1000;   // 3분
const MAX_OTP_ATTEMPTS = 5;         // 인증번호 오입력 5회 → 잠금
const MAX_OTP_SENDS = 5;            // 재발송 5회 → 잠금
const LOCK_MS = 30 * 60 * 1000;     // 30분 잠금

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sms: SmsService,
    private readonly audit: AuditService,
  ) {}

  private get pepper(): string {
    const p = this.config.get<string>('VOTER_ID_PEPPER');
    if (!p) throw new Error('VOTER_ID_PEPPER 가 설정되지 않았습니다.');
    return p;
  }

  /**
   * 1단계: 휴대폰 → 명부 대조 후 OTP 발송
   *
   * 회원번호는 받지 않는다. 본인 확인은 "이 번호로 온 문자를 받았다"가 전부이고,
   * 회원번호는 거기에 아무것도 더하지 못한다 — 회원증과 명부에 적혀 있어
   * 비밀이 아니기 때문이다. 반면 못 외우는 회원이 많아 투표율만 깎는다.
   *
   * 대신 명부에서 휴대폰이 회원마다 고유하도록 강제한다
   * (Voter.@@unique([electionId, phoneHash]), AdminService.importRoster).
   * 한 번호에 두 회원이 걸리면 그 폰을 쥔 사람이 두 명 몫을 투표할 수 있다.
   */
  async requestOtp(params: {
    electionId: string;
    phone: string;
    birthDate: string;
    ipPrefix?: string;
  }) {
    const { electionId, phone, birthDate, ipPrefix } = params;

    const phoneE164 = normalizePhone(phone);
    const phoneHash = hashIdentifier(phoneE164, this.pepper);

    // 실패는 어떤 이유든 같은 메시지여야 한다. "번호는 맞는데 생년월일이 틀렸다"를
    // 알려주면 그 번호가 명부에 있다는 사실이 새어나간다.
    const genericFailure = new UnauthorizedException(
      '입력하신 정보가 회원명부와 일치하지 않습니다. 협회에 등록된 정보를 확인해 주세요.',
    );

    let birthDateHash: string;
    try {
      birthDateHash = hashIdentifier(normalizeBirthDate(birthDate), this.pepper);
    } catch {
      throw genericFailure;
    }

    const voter = await this.prisma.voter.findUnique({
      where: { electionId_phoneHash: { electionId, phoneHash } },
    });

    if (!voter || !safeEqual(voter.birthDateHash, birthDateHash)) {
      await this.audit.log({
        electionId,
        action: 'LOGIN_FAIL',
        actorType: 'VOTER',
        ipPrefix,
      });
      throw genericFailure;
    }

    const now = new Date();
    if (voter.lockedUntil && voter.lockedUntil > now) {
      throw new HttpException(
        '인증 시도 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 이미 투표했다면 OTP 를 보낼 필요가 없다.
    if (voter.hasVoted) {
      throw new HttpException('이미 투표를 완료하셨습니다.', HttpStatus.CONFLICT);
    }

    if (voter.otpSentCount >= MAX_OTP_SENDS) {
      await this.prisma.voter.update({
        where: { id: voter.id },
        data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
      });
      throw new HttpException(
        '인증번호 발송 횟수를 초과했습니다.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = generateOtp();
    await this.prisma.voter.update({
      where: { id: voter.id },
      data: {
        otpHash: await argon2.hash(code, ARGON2_OPTS),
        otpExpiresAt: new Date(now.getTime() + OTP_TTL_MS),
        otpAttempts: 0,
        otpSentCount: { increment: 1 },
      },
    });

    await this.sms.sendOtp(phoneE164, code);
    await this.audit.log({
      electionId,
      action: 'OTP_SENT',
      actorType: 'VOTER',
      ipPrefix,
    });

    // 휴대폰 평문은 어디에도 저장하지 않는다(명부는 해시만 갖고 있다).
    // 그런데 투표 완료 문자를 보내려면 투표 시점에 번호가 필요하다.
    // 그래서 **서버가 서명한 토큰**에 실어 보냈다가 인증 단계에서 돌려받는다.
    // 클라이언트가 남의 번호로 바꿔치기할 수 없다 — 서명을 위조해야 하기 때문이다.
    const challengeToken = await this.jwt.signAsync(
      { sub: voter.id, phone: phoneE164, typ: 'otp' },
      { expiresIn: `${OTP_TTL_MS / 1000}s` },
    );

    return {
      challengeId: voter.id, // 아직 아무 권한도 없는 값
      challengeToken,
      phoneLast4: voter.phoneLast4,
      expiresInSec: OTP_TTL_MS / 1000,
      // 이름은 여기서 주지 않는다. 인증번호를 통과하기 전에 이름을 알려주면
      // "이 번호가 명부에 있고 누구 것인지"가 그대로 새어나간다.
    };
  }

  /** 2단계: OTP 검증 → 짧은 투표 세션 토큰 발급 */
  async verifyOtp(params: {
    challengeId: string;
    code: string;
    challengeToken?: string;
    ipPrefix?: string;
  }) {
    const { challengeId, code, challengeToken, ipPrefix } = params;

    const voter = await this.prisma.voter.findUnique({ where: { id: challengeId } });
    if (!voter || !voter.otpHash || !voter.otpExpiresAt) {
      throw new UnauthorizedException('인증 정보가 없습니다. 처음부터 다시 진행해 주세요.');
    }

    const now = new Date();
    if (voter.lockedUntil && voter.lockedUntil > now) {
      throw new HttpException('인증이 잠겨 있습니다.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (voter.otpExpiresAt < now) {
      throw new UnauthorizedException('인증번호가 만료되었습니다. 다시 요청해 주세요.');
    }
    if (voter.hasVoted) {
      throw new HttpException('이미 투표를 완료하셨습니다.', HttpStatus.CONFLICT);
    }

    const ok = await argon2.verify(voter.otpHash, code);
    if (!ok) {
      const attempts = voter.otpAttempts + 1;
      await this.prisma.voter.update({
        where: { id: voter.id },
        data: {
          otpAttempts: attempts,
          lockedUntil:
            attempts >= MAX_OTP_ATTEMPTS ? new Date(now.getTime() + LOCK_MS) : voter.lockedUntil,
        },
      });
      throw new UnauthorizedException('인증번호가 일치하지 않습니다.');
    }

    // 성공 즉시 OTP 를 폐기한다. 재사용 불가.
    await this.prisma.voter.update({
      where: { id: voter.id },
      data: { otpHash: null, otpExpiresAt: null, otpAttempts: 0 },
    });

    await this.audit.log({
      electionId: voter.electionId,
      action: 'LOGIN_OK',
      actorType: 'VOTER',
      ipPrefix,
    });

    // 발급 단계에서 실어 보낸 번호를 되받는다. 서명이 맞고 같은 유권자의 것일 때만 쓴다.
    let phone: string | undefined;
    if (challengeToken) {
      try {
        const c = await this.jwt.verifyAsync<{ sub: string; phone: string; typ: string }>(challengeToken);
        if (c.typ === 'otp' && c.sub === challengeId) phone = c.phone;
      } catch {
        // 만료·위조는 조용히 무시한다. 문자를 못 받을 뿐 투표는 되어야 한다.
        this.logger.warn('챌린지 토큰이 유효하지 않아 투표 완료 문자를 보낼 수 없습니다.');
      }
    }

    // 토큰 수명은 짧게. 로그인하고 자리를 비운 사이 남이 투표하는 상황을 줄인다.
    const accessToken = await this.jwt.signAsync(
      { sub: voter.id, electionId: voter.electionId, phone, typ: 'vote' },
      // ms 라이브러리의 StringValue 타입("10m" 등)을 요구하므로 캐스팅한다.
      { expiresIn: this.config.get<string>('VOTE_SESSION_TTL', '10m') as any },
    );

    // 이름은 본인 확인을 통과한 지금 준다. 투표 화면에서 보여주면
    // 유권자가 "내가 맞게 인식됐구나"를 확인할 수 있다.
    return { accessToken, electionId: voter.electionId, nameMasked: voter.nameMasked };
  }
}
