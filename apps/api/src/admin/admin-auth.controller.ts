import { Body, Controller, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length, Matches } from 'class-validator';
import type { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard, CurrentAdmin, Roles } from './admin.guard';
import type { AdminSession } from './admin-auth.service';
import { ipPrefixOf } from '../common/crypto.util';

// 선관위원들이 같은 사무실에서 로그인하면 IP 가 같다. 계정별 잠금(5회)이
// 무차별 대입을 막고 있으므로, IP 제한은 봇만 거를 정도로 잡는다.
const ADMIN_LOGIN_LIMIT = Number(process.env.THROTTLE_ADMIN_LOGIN ?? 30);

class LoginDto {
  @IsString() @Length(3, 64) loginId!: string;

  // 길이 하한을 로그인에서 강제하지 않는다. 비밀번호 정책은 생성·변경 시점의 몫이고
  // (admin:create 는 20자 난수를 발급, changePassword 는 12자 이상 요구),
  // 로그인에서 막으면 정책 이전에 만들어진 계정이 아예 들어오지 못한다.
  // 무차별 대입은 argon2 + 5회 실패 시 30분 잠금이 담당한다.
  @IsString() @Length(1, 200) password!: string;
}

class TotpDto {
  @Matches(/^[0-9]{6}$/, { message: '인증번호는 6자리 숫자입니다.' })
  code!: string;
}

class ChangePasswordDto {
  @IsString() @Length(8, 200) current!: string;
  @IsString() @Length(12, 200) next!: string;
}

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  /** 1단계: 아이디 + 비밀번호 → pendingToken */
  @Throttle({ default: { limit: ADMIN_LOGIN_LIMIT, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login({ ...dto, ipPrefix: ipPrefixOf(req.ip) });
  }

  /** 최초 1회: TOTP 등록용 QR 발급. pendingToken 필요 */
  @Throttle({ default: { limit: ADMIN_LOGIN_LIMIT, ttl: 60_000 } })
  @Post('totp/enroll')
  async enroll(@Headers('authorization') bearer?: string) {
    const adminId = await this.auth.resolvePending(bearer);
    return this.auth.beginTotpEnrollment(adminId);
  }

  /** 2단계: TOTP 검증 → 실제 관리자 토큰. pendingToken 필요 */
  @Throttle({ default: { limit: ADMIN_LOGIN_LIMIT, ttl: 60_000 } })
  @Post('totp/verify')
  async verify(
    @Body() dto: TotpDto,
    @Req() req: Request,
    @Headers('authorization') bearer?: string,
  ) {
    const adminId = await this.auth.resolvePending(bearer);
    return this.auth.verifyTotp({ adminId, code: dto.code, ipPrefix: ipPrefixOf(req.ip) });
  }

  /** 비밀번호 변경 — 참관인도 자기 비밀번호는 바꿀 수 있어야 한다 */
  @Roles('COMMISSIONER', 'AUDITOR')
  @UseGuards(AdminGuard)
  @Post('password')
  changePassword(@CurrentAdmin() me: AdminSession, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword({ adminId: me.adminId, ...dto });
  }
}
