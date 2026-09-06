import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { SmsService } from './sms.service';
import { IdentityService } from './identity.service';
import { MockIdentityProvider, RealIdentityProvider } from './identity-verification';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        secret: c.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [
    AuthService, JwtStrategy, SmsService,
    IdentityService, MockIdentityProvider, RealIdentityProvider,
  ],
  controllers: [AuthController],
})
export class AuthModule {}
