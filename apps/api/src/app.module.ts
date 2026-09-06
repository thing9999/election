import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { VoteModule } from './vote/vote.module';
import { ElectionModule } from './election/election.module';
import { AdminModule } from './admin/admin.module';
import { IntegrityModule } from './integrity/integrity.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 1만 명 동시 접속 대비 기본 상한. 앞단 CDN/WAF 와 함께 쓴다.
    // 공용 NAT 를 고려해 넉넉히 잡는다 (아래 주석 참고: auth.controller.ts).
    ThrottlerModule.forRoot([
      { ttl: 60_000, limit: Number(process.env.THROTTLE_GLOBAL ?? 300) },
    ]),
    PrismaModule,
    CommonModule,
    AuthModule,
    VoteModule,
    ElectionModule,
    IntegrityModule,
    AdminModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
