import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ElectionService } from './election.service';
import { VoteService } from '../vote/vote.service';

@Controller('elections')
export class ElectionController {
  constructor(
    private readonly elections: ElectionService,
    private readonly votes: VoteService,
  ) {}

  /** 진행 중인 선거. :id 보다 먼저 선언해야 'current' 가 UUID 로 해석되지 않는다. */
  @Get('current')
  current() {
    return this.elections.getCurrent();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.elections.getPublic(id);
  }

  /** 투표율은 진행 중에도 공개 가능한 유일한 수치 */
  @Get(':id/turnout')
  turnout(@Param('id', ParseUUIDPipe) id: string) {
    return this.votes.getTurnout(id);
  }

  @Get(':id/results')
  results(@Param('id', ParseUUIDPipe) id: string) {
    return this.elections.getResults(id);
  }
}
