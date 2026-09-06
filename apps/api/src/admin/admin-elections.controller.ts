import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  IsArray, IsDateString, IsInt, IsOptional, IsString, Length, Max, Min,
  ValidateNested, ArrayMinSize, ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AdminService } from './admin.service';
import { AdminGuard, CurrentAdmin, Roles } from './admin.guard';
import type { AdminSession } from './admin-auth.service';

class CandidateInput {
  @IsInt() @Min(1) @Max(99)
  ballotNumber!: number;

  @IsString() @Length(1, 40)
  name!: string;

  @IsOptional() @IsString() @Length(0, 120)
  affiliation?: string;

  @IsOptional() @IsString() @Length(0, 2000)
  pledge?: string;
}

class CreateElectionDto {
  @IsString() @Length(2, 120)
  title!: string;

  @IsOptional() @IsString() @Length(0, 500)
  description?: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CandidateInput)
  candidates!: CandidateInput[];
}

class ReplaceCandidatesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CandidateInput)
  candidates!: CandidateInput[];
}

/**
 * 선거 목록·생성. 개별 선거 조작은 AdminController(admin/elections/:id) 가 맡는다.
 */
@Controller('admin/elections')
@UseGuards(AdminGuard)
export class AdminElectionsController {
  constructor(private readonly admin: AdminService) {}

  /** 참관인도 목록은 봐야 감시가 성립한다 */
  @Roles('COMMISSIONER', 'AUDITOR')
  @Get()
  list() {
    return this.admin.listElections();
  }

  @Roles('COMMISSIONER', 'AUDITOR')
  @Get(':id/overview')
  overview(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.electionOverview(id);
  }

  /**
   * 선거 생성. 봉인 키쌍을 만들고 **개표키를 이 응답에서 한 번만** 돌려준다.
   * 서버에 저장하지 않으므로 다시 볼 수 없다.
   */
  @Post()
  create(@Body() dto: CreateElectionDto, @CurrentAdmin() me: AdminSession) {
    return this.admin.createElection(dto, me.adminId);
  }

  /** 후보 교체. DRAFT 에서만 가능하다 */
  @Post(':id/candidates')
  replaceCandidates(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceCandidatesDto,
    @CurrentAdmin() me: AdminSession,
  ) {
    return this.admin.replaceCandidates(id, dto.candidates, me.adminId);
  }
}
