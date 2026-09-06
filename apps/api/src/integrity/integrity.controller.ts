import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards, Body } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { IntegrityService } from './integrity.service';
import { AnchorService } from './anchor.service';
import { AdminGuard, CurrentAdmin, Roles } from '../admin/admin.guard';
import type { AdminSession } from '../admin/admin-auth.service';

class AnchorDto {
  @IsIn(['FILE', 'OBSERVERS', 'BLOCKCHAIN'])
  target!: 'FILE' | 'OBSERVERS' | 'BLOCKCHAIN';
}

/**
 * 무결성 사슬은 **공개**다.
 *
 * 참관인·후보 캠프·회원 누구나 로그인 없이 대조할 수 있어야 검증이 성립한다.
 * 관리자만 볼 수 있으면 "협회가 스스로를 검증했다"가 되어 아무 의미가 없다.
 * 여기 나가는 값은 전부 해시라 표 내용도 명부도 복원되지 않는다.
 */
@Controller('elections/:id/integrity')
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  @Get('chain')
  chain(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrity.publicChain(id);
  }

  @Get('verify')
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrity.verifyChain(id);
  }
}

/** 체크포인트 생성·고정은 선관위만 */
@Controller('admin/elections/:id/integrity')
@UseGuards(AdminGuard)
export class AdminIntegrityController {
  constructor(
    private readonly integrity: IntegrityService,
    private readonly anchors: AnchorService,
  ) {}

  /** 투표 중 중간 확정. 마감 전에도 주기적으로 굳혀두면 되돌리기가 그만큼 어려워진다 */
  @Post('checkpoint')
  checkpoint(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() me: AdminSession) {
    return this.integrity.createCheckpoint({ electionId: id, kind: 'BALLOTS', adminId: me.adminId });
  }

  /** 최신 체크포인트를 외부에 고정 */
  @Post('anchor')
  anchor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnchorDto,
    @CurrentAdmin() me: AdminSession,
  ) {
    return this.anchors.anchorLatest(id, dto.target, me.adminId);
  }

  @Roles('COMMISSIONER', 'AUDITOR')
  @Get('verify')
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrity.verifyChain(id);
  }
}
