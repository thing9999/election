import {
  Body,
  Controller,
  Post,
  Req,
  Get,
  ForbiddenException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { RequestOtpDto, VerifyOtpDto, IdentityBeginDto, IdentityCompleteDto } from './dto';
import { IdentityService } from './identity.service';
import { ipPrefixOf } from '../common/crypto.util';

// 공용 NAT(병원·의국) 뒤에서 여러 회원이 동시에 투표하는 상황을 견뎌야 한다.
const OTP_REQUEST_LIMIT = Number(process.env.THROTTLE_OTP_REQUEST ?? 30);
const OTP_VERIFY_LIMIT = Number(process.env.THROTTLE_OTP_VERIFY ?? 60);

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly identity: IdentityService,
  ) {}

  /** 이 선거가 본인확인을 쓰는지. 화면이 어떤 경로를 보여줄지 정하는 데 쓴다 */
  @Get('methods')
  methods() {
    return { identity: this.identity.mode, otp: this.identity.otpPathAllowed };
  }

  /** 본인확인 시작 — 서비스로 보낼 주소를 받는다 */
  @Throttle({ default: { limit: OTP_REQUEST_LIMIT, ttl: 60_000 } })
  @Post('identity/begin')
  identityBegin(@Body() dto: IdentityBeginDto) {
    return this.identity.begin(dto.electionId);
  }

  /** 본인확인 결과를 받아 명부와 대조하고 투표 세션을 발급한다 */
  @Throttle({ default: { limit: OTP_VERIFY_LIMIT, ttl: 60_000 } })
  @Post('identity/complete')
  identityComplete(@Body() dto: IdentityCompleteDto, @Req() req: Request) {
    return this.identity.complete({ ...dto, ipPrefix: ipPrefixOf(req.ip) });
  }

  /**
   * SMS 는 건당 비용이 들므로 IP 제한을 둔다. 다만 너무 조이면 안 된다 —
   * 같은 병원 의국에서 여러 회원이 동시에 투표하면 공용 NAT 뒤라 IP 가 같다.
   * 1인당 발송 상한은 DB 의 otpSentCount(5회)가 이미 막고 있으므로,
   * 여기서는 봇/DoS 만 걸러낼 정도로만 잡는다.
   */
  @Throttle({ default: { limit: OTP_REQUEST_LIMIT, ttl: 60_000 } })
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto, @Req() req: Request) {
    // 본인확인이 required 면 이 경로를 닫는다. 열어두면 그게 곧 우회로다.
    this.assertOtpAllowed();
    return this.auth.requestOtp({ ...dto, ipPrefix: ipPrefixOf(req.ip) });
  }

  @Throttle({ default: { limit: OTP_VERIFY_LIMIT, ttl: 60_000 } })
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    this.assertOtpAllowed();
    return this.auth.verifyOtp({ ...dto, ipPrefix: ipPrefixOf(req.ip) });
  }

  private assertOtpAllowed() {
    if (!this.identity.otpPathAllowed) {
      throw new ForbiddenException(
        '이 선거는 본인확인 서비스로만 인증할 수 있습니다.',
      );
    }
  }
}
