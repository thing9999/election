import {
  CanActivate, ExecutionContext, Injectable, UnauthorizedException,
  ForbiddenException, createParamDecorator, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminSession } from './admin-auth.service';

export const ROLES_KEY = 'admin_roles';

/** 이 핸들러를 호출할 수 있는 역할. 안 붙이면 COMMISSIONER 만 통과한다. */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!raw) throw new UnauthorizedException();

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(raw);
    } catch {
      throw new UnauthorizedException();
    }

    // typ 을 못박지 않으면 유권자 토큰이나 비밀번호만 통과한 pending 토큰으로
    // 관리자 API 를 호출할 수 있게 된다.
    if (payload?.typ !== 'admin') throw new UnauthorizedException();

    // 토큰이 살아 있어도 계정이 그 사이 비활성화됐을 수 있다.
    // 퇴임한 위원의 토큰이 만료까지 남아 도는 걸 막으려면 매 요청 확인해야 한다.
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, name: true, disabledAt: true },
    });
    if (!admin || admin.disabledAt) throw new UnauthorizedException();

    const allowed =
      this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? (['COMMISSIONER'] as AdminRole[]);

    if (!allowed.includes(admin.role)) {
      throw new ForbiddenException(
        admin.role === 'AUDITOR'
          ? '참관인 계정은 조회만 가능합니다.'
          : '권한이 없습니다.',
      );
    }

    // 역할은 토큰이 아니라 방금 읽은 DB 값을 신뢰한다.
    req.admin = { adminId: admin.id, role: admin.role, name: admin.name } satisfies AdminSession;
    return true;
  }
}

export const CurrentAdmin = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): AdminSession =>
    ctx.switchToHttp().getRequest().admin,
);
