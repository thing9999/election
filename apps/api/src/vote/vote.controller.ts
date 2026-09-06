import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import type { Request } from 'express';
import { VoteService } from './vote.service';
import { JwtAuthGuard, CurrentVoter } from '../auth/jwt.guard';
import type { VoteSession } from '../auth/jwt.strategy';
import { ipPrefixOf } from '../common/crypto.util';

class CastBallotDto {
  /**
   * 브라우저가 봉인한 투표지 (base64, 133바이트).
   * 서버는 이 안에 어떤 후보가 들었는지 알 수 없다 — 그게 목적이다.
   */
  @IsString()
  @Length(176, 180) // base64(133B) = 178자
  sealedVote!: string;
}

@Controller('vote')
@UseGuards(JwtAuthGuard)
export class VoteController {
  constructor(private readonly vote: VoteService) {}

  @Get('status')
  status(@CurrentVoter() me: VoteSession) {
    return this.vote.getVotingStatus(me.voterId);
  }

  @Post()
  cast(
    @CurrentVoter() me: VoteSession,
    @Body() dto: CastBallotDto,
    @Req() req: Request,
  ) {
    // electionId 는 토큰에서만 읽는다. 클라이언트가 보낸 값을 믿으면
    // 다른 선거에 표를 넣을 수 있다.
    return this.vote.castBallot({
      voterId: me.voterId,
      electionId: me.electionId,
      sealedVoteB64: dto.sealedVote,
      phone: me.phone,
      ipPrefix: ipPrefixOf(req.ip),
    });
  }
}
