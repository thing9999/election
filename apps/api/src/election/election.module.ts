import { Module } from '@nestjs/common';
import { ElectionService } from './election.service';
import { ElectionController } from './election.controller';
import { VoteModule } from '../vote/vote.module';

@Module({
  imports: [VoteModule],
  providers: [ElectionService],
  controllers: [ElectionController],
})
export class ElectionModule {}
