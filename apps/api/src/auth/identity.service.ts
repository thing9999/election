import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { hashIdentifier, normalizeBirthDate, normalizePhone } from '../common/crypto.util';
import {
  MockIdentityProvider, RealIdentityProvider,
  type IdentityVerificationProvider,
} from './identity-verification';

export type IdentityMode = 'off' | 'optional' | 'required';

/**
 * 본인확인 서비스로 신원을 확인하고, 명부와 대조해 투표 세션을 발급한다.
 *
 * OTP 단계를 **대체한다.** 본인확인 서비스가 자체적으로 문자/앱 인증을 하므로
 * 우리 OTP 를 한 번 더 돌리면 문자 비용만 두 배가 된다.
 *
 * IDENTITY_VERIFICATION:
 *   off      — 쓰지 않는다. 기존 휴대폰+생년월일+OTP 만 동작한다 (기본값)
 *   optional — 둘 다 열어둔다. 시범 운영용
 *   required — 본인확인만 허용한다. OTP 경로는 거부된다
 *              (열어두면 그게 곧 우회로가 되므로 반드시 막아야 한다)
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  private readonly pepper: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly mock: MockIdentityProvider,
    private readonly real: RealIdentityProvider,
  ) {
    this.pepper = this.config.getOrThrow<string>('VOTER_ID_PEPPER');
  }

  get mode(): IdentityMode {
    const m = (this.config.get<string>('IDENTITY_VERIFICATION') ?? 'off').toLowerCase();
    return (['off', 'optional', 'required'] as const).includes(m as IdentityMode)
      ? (m as IdentityMode)
      : 'off';
  }

  private get provider(): IdentityVerificationProvider {
    return (this.config.get<string>('IDENTITY_PROVIDER') ?? 'mock') === 'mock'
      ? this.mock
      : this.real;
  }

  /** OTP 경로를 열어둘지. required 면 닫는다 — 열어두면 그게 우회로가 된다. */
  get otpPathAllowed(): boolean {
    return this.mode !== 'required';
  }

  private assertEnabled() {
    if (this.mode === 'off') {
      throw new BadRequestException('이 선거는 본인확인 서비스를 사용하지 않습니다.');
    }
  }

  async begin(electionId: string) {
    this.assertEnabled();
    const election = await this.prisma.election.findUnique({
      where: { id: electionId }, select: { status: true },
    });
    if (!election) throw new BadRequestException('존재하지 않는 선거입니다.');
    if (election.status !== 'OPEN') throw new ForbiddenException('현재 투표 기간이 아닙니다.');

    const r = await this.provider.begin({ electionId });
    await this.audit.log({
      electionId, action: 'IDENTITY_BEGIN', actorType: 'VOTER',
      detail: { provider: this.provider.name },
    });
    return { ...r, provider: this.provider.name };
  }

  /**
   * 서비스가 확인해 준 신원을 명부와 대조하고 투표 세션을 발급한다.
   *
   * 평문 이름·생년월일·번호는 이 함수 안에서만 존재하고 저장되지 않는다.
   */
  async complete(params: {
    electionId: string;
    txId: string;
    payload?: unknown;
    ipPrefix?: string;
  }) {
    this.assertEnabled();
    const { electionId, txId, payload, ipPrefix } = params;

    let identity;
    try {
      identity = await this.provider.complete({ txId, payload });
    } catch (e) {
      await this.audit.log({
        electionId, action: 'IDENTITY_FAILED', actorType: 'VOTER', ipPrefix,
        detail: { reason: (e as Error).message },
      });
      throw new UnauthorizedException((e as Error).message);
    }

    let phoneE164: string;
    let birthDate: string;
    try {
      phoneE164 = normalizePhone(identity.phoneE164);
      birthDate = normalizeBirthDate(identity.birthDate);
    } catch {
      throw new BadRequestException('본인확인 결과의 형식이 올바르지 않습니다.');
    }

    const phoneHash = hashIdentifier(phoneE164, this.pepper);
    const birthDateHash = hashIdentifier(birthDate, this.pepper);
    const nameHash = hashIdentifier(identity.name.trim(), this.pepper);
    const ciHash = identity.ci ? hashIdentifier(identity.ci, this.pepper) : null;

    const voter = await this.prisma.voter.findUnique({
      where: { electionId_phoneHash: { electionId, phoneHash } },
    });

    // 명부에 없는 번호. 존재 여부가 새어나가지 않도록 같은 응답을 준다.
    if (!voter || voter.birthDateHash !== birthDateHash) {
      await this.audit.log({
        electionId, action: 'IDENTITY_NO_MATCH', actorType: 'VOTER', ipPrefix,
      });
      throw new UnauthorizedException('회원 명부에서 확인할 수 없습니다. 협회로 문의해 주세요.');
    }

    // ── 여기가 본인확인을 붙이는 이유 ──
    // 번호와 생년월일은 맞는데 **통신사 명의가 다른 사람**이면 대리투표다.
    // 이 단계에서는 이미 신원이 확인됐으므로 사유를 알려줘도 명부가 새지 않는다.
    if (voter.nameHash && voter.nameHash !== nameHash) {
      await this.audit.log({
        electionId, action: 'IDENTITY_NAME_MISMATCH', actorType: 'VOTER', ipPrefix,
      });
      throw new ForbiddenException(
        '이 휴대폰의 명의자가 해당 회원 본인이 아닙니다. ' +
          '본인 명의의 휴대폰으로 진행하시거나 협회로 문의해 주세요.',
      );
    }
    if (!voter.nameHash) {
      // 명부에 이름 해시가 없는 경우(구 명부). 명의 대조를 못 하므로 그만큼 약하다.
      this.logger.warn('명부에 이름 해시가 없어 통신사 명의 대조를 건너뜁니다.');
    }

    if (voter.hasVoted) throw new ConflictException('이미 투표를 완료하셨습니다.');

    // CI 기록. 같은 사람이 다른 회원번호로 두 번 등록돼 있으면 유니크 제약에서 걸린다.
    if (ciHash) {
      try {
        await this.prisma.voter.update({
          where: { id: voter.id },
          data: { ciHash, identityVerifiedAt: new Date() },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          await this.audit.log({
            electionId, action: 'IDENTITY_DUPLICATE_PERSON', actorType: 'VOTER', ipPrefix,
          });
          throw new ConflictException(
            '이미 다른 회원번호로 투표 자격이 확인되었습니다. ' +
              '한 분이 두 번 투표하실 수는 없습니다. 협회로 문의해 주세요.',
          );
        }
        throw e;
      }
    } else {
      await this.prisma.voter.update({
        where: { id: voter.id }, data: { identityVerifiedAt: new Date() },
      });
    }

    await this.audit.log({
      electionId, action: 'IDENTITY_OK', actorType: 'VOTER', ipPrefix,
      detail: { provider: this.provider.name, ciChecked: Boolean(ciHash) },
    });

    // OTP 경로와 같은 형태의 세션을 준다. 투표 완료 문자를 보낼 번호도 함께.
    const accessToken = await this.jwt.signAsync(
      { sub: voter.id, electionId: voter.electionId, phone: phoneE164, typ: 'vote' },
      { expiresIn: this.config.get<string>('VOTE_SESSION_TTL', '10m') as any },
    );

    return { accessToken, electionId: voter.electionId, nameMasked: voter.nameMasked };
  }
}
