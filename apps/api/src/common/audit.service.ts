import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditExportService } from './audit-sink';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly exporter: AuditExportService,
  ) {}

  /**
   * 감사 로그는 선거 분쟁 시 유일한 증거다. 반드시 남기되,
   * actorType 이 VOTER 인 경우 actorRef 를 절대 채우지 않는다.
   * (누가 몇 시에 투표했는지가 남으면 Ballot 시각과 대조될 수 있다)
   */
  async log(entry: {
    electionId?: string | null;
    action: string;
    actorType: 'VOTER' | 'ADMIN' | 'SYSTEM';
    actorRef?: string | null;
    detail?: Record<string, unknown>;
    ipPrefix?: string;
  }): Promise<void> {
    const actorRef = entry.actorType === 'VOTER' ? null : (entry.actorRef ?? null);
    try {
      const row = await this.prisma.auditLog.create({
        data: {
          electionId: entry.electionId ?? null,
          action: entry.action,
          actorType: entry.actorType,
          actorRef,
          detail: (entry.detail ?? {}) as any,
          ipPrefix: entry.ipPrefix ?? null,
        },
      });

      // DB 밖으로 한 벌 더. 같은 DB 안에만 있으면 DB 를 쥔 사람이 지울 수 있고,
      // 무엇보다 지워졌다는 사실 자체를 알 수 없다.
      // 큐에 넣기만 하고 기다리지 않는다 — 반출이 투표 속도를 좌우해서는 안 된다.
      this.exporter.enqueue({
        id: String(row.id),
        at: row.createdAt.toISOString(),
        electionId: row.electionId,
        action: row.action,
        actorType: row.actorType,
        actorRef: row.actorRef,
        detail: (entry.detail ?? {}) as Record<string, unknown>,
        ipPrefix: row.ipPrefix,
      });
    } catch (e) {
      // 감사 로그 실패가 투표 자체를 막아서는 안 된다. 단, 반드시 알람이 울려야 한다.
      this.logger.error(`감사 로그 기록 실패: ${entry.action}`, e as Error);
    }
  }
}
