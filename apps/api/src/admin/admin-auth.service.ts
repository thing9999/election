import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import {
  generateSecret,
  generateURI,
  NobleCryptoPlugin,
  ScureBase32Plugin,
} from 'otplib';
// otplib 최상위 verify 는 TOTP/HOTP 공용이라 반환 타입이 합집합이고 timeStep 이 안 잡힌다.
// 재사용 방지에 timeStep 이 필요하므로 TOTP 전용 함수를 쓴다 (플러그인은 직접 주입).
import { verify as verifyTotpCode } from '@otplib/totp';
import * as QRCode from 'qrcode';
import type { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_MS = 30 * 60 * 1000;

/**
 * TOTP 허용 오차(초). 기기 시계 오차를 감안해 과거 방향으로만 30초 인정한다.
 * 미래 방향을 열면 아직 오지 않은 코드가 통과하고, 넓힐수록
 * 훔쳐본 코드의 유효시간이 그만큼 길어진다. RFC 권장도 과거 방향만이다.
 */
const TOTP_TOLERANCE: [number, number] = [30, 0];

const TOTP_PLUGINS = {
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
} as const;

export interface AdminSession {
  adminId: string;
  role: AdminRole;
  name: string;
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 1단계: 아이디 + 비밀번호.
   *
   * 성공해도 아직 아무 권한이 없는 'admin_pending' 토큰만 준다.
   * TOTP 를 통과해야 실제 관리자 토큰이 나온다.
   */
  async login(params: { loginId: string; password: string; ipPrefix?: string }) {
    const { loginId, password, ipPrefix } = params;

    const admin = await this.prisma.adminUser.findUnique({ where: { loginId } });

    // 존재하지 않는 계정도 같은 지연·같은 메시지로 응답한다.
    // 응답 차이로 계정 목록을 긁어낼 수 있으면 안 된다.
    const fail = new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.');
    if (!admin) {
      await argon2.hash(password); // 타이밍 맞추기
      await this.audit.log({
        action: 'ADMIN_LOGIN_FAIL',
        actorType: 'SYSTEM',
        detail: { reason: 'no_such_account' },
        ipPrefix,
      });
      throw fail;
    }

    const now = new Date();
    if (admin.disabledAt) {
      throw new ForbiddenException('비활성화된 계정입니다.');
    }
    if (admin.lockedUntil && admin.lockedUntil > now) {
      throw new HttpException(
        '로그인 시도 횟수를 초과했습니다. 30분 후 다시 시도해 주세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ok = await argon2.verify(admin.passwordHash, password);
    if (!ok) {
      const attempts = admin.failedAttempts + 1;
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: {
          failedAttempts: attempts,
          lockedUntil:
            attempts >= MAX_LOGIN_ATTEMPTS ? new Date(now.getTime() + LOCK_MS) : admin.lockedUntil,
        },
      });
      await this.audit.log({
        action: 'ADMIN_LOGIN_FAIL',
        actorType: 'ADMIN',
        actorRef: admin.id,
        detail: { attempts },
        ipPrefix,
      });
      throw fail;
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { failedAttempts: 0 },
    });

    // 비밀번호만 통과한 상태의 임시 토큰. TOTP 엔드포인트에서만 쓰인다.
    const pendingToken = await this.jwt.signAsync(
      { sub: admin.id, typ: 'admin_pending' },
      { expiresIn: '5m' },
    );

    return {
      pendingToken,
      totpRegistered: admin.totpConfirmedAt !== null,
      name: admin.name,
    };
  }

  /**
   * TOTP 최초 등록. 비밀번호를 통과한 사람만 호출할 수 있다.
   * 이미 등록된 계정은 다시 등록할 수 없다 — 등록을 갈아끼울 수 있으면
   * 세션을 탈취한 공격자가 자기 기기로 2차 인증을 옮겨버릴 수 있다.
   */
  async beginTotpEnrollment(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new UnauthorizedException();
    if (admin.totpConfirmedAt) {
      throw new ForbiddenException(
        '이미 2차 인증이 등록되어 있습니다. 재등록은 다른 위원의 승인이 필요합니다.',
      );
    }

    const secret = generateSecret();
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { totpSecret: secret },
    });

    const otpauth = generateURI({
      issuer: this.config.get<string>('TOTP_ISSUER', '협회장선거 선관위'),
      label: admin.loginId,
      secret,
    });

    return {
      secret, // 앱에 수동 입력할 때 쓰는 값
      qrDataUrl: await QRCode.toDataURL(otpauth),
    };
  }

  /**
   * 2단계: TOTP 코드 검증 → 실제 관리자 토큰 발급.
   * 최초 등록 직후의 확인도 이 경로를 쓴다.
   */
  async verifyTotp(params: { adminId: string; code: string; ipPrefix?: string }) {
    const { adminId, code, ipPrefix } = params;

    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin?.totpSecret) {
      throw new UnauthorizedException('2차 인증이 등록되지 않았습니다.');
    }

    const now = new Date();
    if (admin.lockedUntil && admin.lockedUntil > now) {
      throw new HttpException('계정이 잠겨 있습니다.', HttpStatus.TOO_MANY_REQUESTS);
    }

    // afterTimeStep 이 재사용을 막는다. 이미 쓴 시간 슬롯 이하의 코드는
    // 유효시간이 남아 있어도 거부된다 — 어깨너머로 본 코드를 30초 안에
    // 그대로 쓰는 걸 차단한다.
    const result = await verifyTotpCode({
      ...TOTP_PLUGINS,
      secret: admin.totpSecret,
      token: code,
      epochTolerance: TOTP_TOLERANCE,
      afterTimeStep: admin.lastTotpStep === null ? undefined : Number(admin.lastTotpStep),
    });

    if (!result.valid) {
      const attempts = admin.failedAttempts + 1;
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: {
          failedAttempts: attempts,
          lockedUntil:
            attempts >= MAX_LOGIN_ATTEMPTS ? new Date(now.getTime() + LOCK_MS) : admin.lockedUntil,
        },
      });
      await this.audit.log({
        action: 'ADMIN_TOTP_FAIL',
        actorType: 'ADMIN',
        actorRef: admin.id,
        ipPrefix,
      });
      throw new UnauthorizedException(
        '인증번호가 올바르지 않거나 이미 사용된 번호입니다.',
      );
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        lastTotpStep: BigInt(result.timeStep),
        failedAttempts: 0,
        lastLoginAt: now,
        totpConfirmedAt: admin.totpConfirmedAt ?? now, // 최초 통과 시점에 등록 확정
      },
    });

    await this.audit.log({
      action: 'ADMIN_LOGIN_OK',
      actorType: 'ADMIN',
      actorRef: admin.id,
      detail: { role: admin.role },
      ipPrefix,
    });

    // 관리자 세션은 짧게. 개표일에 자리를 비운 사이 남이 쓰는 상황을 줄인다.
    const accessToken = await this.jwt.signAsync(
      { sub: admin.id, typ: 'admin', role: admin.role, name: admin.name },
      { expiresIn: this.config.get<string>('ADMIN_SESSION_TTL', '30m') as any },
    );

    return { accessToken, role: admin.role, name: admin.name };
  }

  /** admin_pending 토큰에서 adminId 를 꺼낸다 (TOTP 단계 전용) */
  async resolvePending(bearer?: string): Promise<string> {
    const raw = bearer?.replace(/^Bearer\s+/i, '');
    if (!raw) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync(raw);
      if (payload?.typ !== 'admin_pending') throw new UnauthorizedException();
      return payload.sub as string;
    } catch {
      throw new UnauthorizedException('인증 단계가 만료되었습니다. 다시 로그인해 주세요.');
    }
  }

  /** 비밀번호 변경 — 본인만, 현재 비밀번호 확인 후 */
  async changePassword(params: { adminId: string; current: string; next: string }) {
    const { adminId, current, next } = params;
    if (next.length < 12) {
      throw new BadRequestException('비밀번호는 12자 이상이어야 합니다.');
    }
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new UnauthorizedException();
    if (!(await argon2.verify(admin.passwordHash, current))) {
      throw new UnauthorizedException('현재 비밀번호가 올바르지 않습니다.');
    }
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { passwordHash: await argon2.hash(next) },
    });
    await this.audit.log({
      action: 'ADMIN_PASSWORD_CHANGED',
      actorType: 'ADMIN',
      actorRef: adminId,
    });
    return { ok: true };
  }
}
