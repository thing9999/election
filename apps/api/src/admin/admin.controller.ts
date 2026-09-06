import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard, CurrentAdmin, Roles } from './admin.guard';
import type { AdminSession } from './admin-auth.service';
import { IsString, Length } from 'class-validator';

class TallyDto {
  /** 선관위가 오프라인으로 보관 중인 개표키 (P-256 PKCS8, base64url 약 184자) */
  @IsString()
  @Length(150, 300)
  privateKey!: string;
}

/**
 * 선거관리위원회 전용.
 *
 * 기본값은 COMMISSIONER 만 통과다. 참관인(AUDITOR)이 볼 수 있어야 하는 조회 API 에만
 * @Roles 로 명시적으로 열어준다 — 기본이 '거부'여야 실수로 열리지 않는다.
 */
@Controller('admin/elections/:id')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('roster')
  importRoster(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { csv: string },
    @CurrentAdmin() me: AdminSession,
  ) {
    const rows = this.admin.parseRosterCsv(body.csv);
    return this.admin.importRoster({ electionId: id, rows, adminId: me.adminId });
  }

  /** 명부 확정. 이 시점의 해시를 후보 캠프·참관인에게 배포한다 */
  @Post('roster/seal')
  sealRoster(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() me: AdminSession) {
    return this.admin.sealRoster(id, me.adminId);
  }

  @Post('open')
  open(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() me: AdminSession) {
    return this.admin.openElection(id, me.adminId);
  }

  @Post('close')
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() me: AdminSession) {
    return this.admin.closeElection(id, me.adminId);
  }

  /** 참관인도 무결성은 직접 확인할 수 있어야 감시가 성립한다 */
  @Roles('COMMISSIONER', 'AUDITOR')
  @Get('integrity')
  integrity(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.integrityCheck(id);
  }

  @Roles('COMMISSIONER', 'AUDITOR')
  @Get('tally')
  tallyStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.tallyStatus(id);
  }

  /**
   * 개표 승인. 서로 다른 선관위원 2명이 각자 호출해야 실제로 개표된다.
   * 첫 번째 호출은 승인만 기록하고 결과를 열지 않는다.
   *
   * 개인키는 매 호출마다 받는다. 서버에 저장하지 않는 것이 이 설계의 핵심이라
   * 세션에 넣어두는 것조차 하지 않는다.
   */
  @Post('tally')
  tally(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TallyDto,
    @CurrentAdmin() me: AdminSession,
  ) {
    return this.admin.approveTally(id, me.adminId, body.privateKey);
  }
}
