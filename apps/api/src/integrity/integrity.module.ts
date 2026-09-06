import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IntegrityService } from './integrity.service';
import { AnchorService } from './anchor.service';
import { IntegrityController, AdminIntegrityController } from './integrity.controller';
import { FileAnchorProvider, ObserverAnchorProvider, BlockchainAnchorProvider } from './anchor';
import { AdminGuard } from '../admin/admin.guard';
import { SmsService } from '../auth/sms.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({ secret: c.getOrThrow<string>('JWT_SECRET') }),
    }),
  ],
  providers: [
    IntegrityService, AnchorService, AdminGuard, SmsService,
    FileAnchorProvider, ObserverAnchorProvider, BlockchainAnchorProvider,
  ],
  controllers: [IntegrityController, AdminIntegrityController],
  exports: [IntegrityService, AnchorService],
})
export class IntegrityModule {}
