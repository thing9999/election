import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminElectionsController } from './admin-elections.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminGuard } from './admin.guard';
import { IntegrityModule } from '../integrity/integrity.module';

@Module({
  imports: [
    IntegrityModule,
    // AdminGuard 와 AdminAuthService 가 JwtService 를 쓴다.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        secret: c.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [AdminService, AdminAuthService, AdminGuard],
  // AdminElectionsController(admin/elections) 를 AdminController(admin/elections/:id)
  // 보다 먼저 등록해 'candidates' 같은 경로가 :id 로 잡히지 않게 한다.
  controllers: [AdminAuthController, AdminElectionsController, AdminController],
})
export class AdminModule {}
