import { Module } from '@nestjs/common';
import { VoteService } from './vote.service';
import { VoteController } from './vote.controller';
import { SmsService } from '../auth/sms.service';

@Module({
  // SmsService 는 상태가 없고 ConfigService 만 쓰므로 여기서 따로 제공해도 된다.
  // (AuthModule 을 통째로 import 하면 순환 참조가 생긴다)
  providers: [VoteService, SmsService],
  controllers: [VoteController],
  exports: [VoteService],
})
export class VoteModule {}
