import { Injectable, ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { VoteSession } from './jwt.strategy';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

export const CurrentVoter = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): VoteSession =>
    ctx.switchToHttp().getRequest().user,
);
