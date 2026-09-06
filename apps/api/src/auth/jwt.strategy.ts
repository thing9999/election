import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

export interface VoteSession {
  voterId: string;
  electionId: string;
  /** 투표 완료 문자를 보낼 번호. 저장하지 않고 세션에만 있다. */
  phone?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: any): Promise<VoteSession> {
    // 관리자 토큰으로 투표 API 를 호출하지 못하도록 용도를 못박는다.
    if (payload?.typ !== 'vote') throw new UnauthorizedException();
    return { voterId: payload.sub, electionId: payload.electionId, phone: payload.phone };
  }
}
