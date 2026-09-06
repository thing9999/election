import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { IntegrityService } from './integrity.service';
import {
  FileAnchorProvider, ObserverAnchorProvider, BlockchainAnchorProvider,
  type AnchorProvider,
} from './anchor';

@Injectable()
export class AnchorService {
  private readonly logger = new Logger(AnchorService.name);
  private readonly providers: Record<string, AnchorProvider>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrity: IntegrityService,
    private readonly audit: AuditService,
    file: FileAnchorProvider,
    observers: ObserverAnchorProvider,
    blockchain: BlockchainAnchorProvider,
  ) {
    this.providers = {
      [file.target]: file,
      [observers.target]: observers,
      [blockchain.target]: blockchain,
    };
  }

  /** 가장 최근 체크포인트를 지정한 대상에 고정한다 */
  async anchorLatest(electionId: string, target: string, adminId?: string) {
    const provider = this.providers[target];
    if (!provider) throw new BadRequestException(`알 수 없는 고정 대상입니다: ${target}`);

    const cp = await this.prisma.checkpoint.findFirst({
      where: { electionId },
      orderBy: { seq: 'desc' },
    });
    if (!cp) throw new BadRequestException('고정할 체크포인트가 없습니다.');

    const result = await provider.anchor({
      electionId, seq: cp.seq, hash: cp.hash, kind: cp.kind,
    });

    await this.integrity.recordAnchor({
      checkpointId: cp.id,
      target: result.target,
      reference: result.reference,
      detail: result.detail,
    });

    await this.audit.log({
      electionId, action: 'ANCHOR', actorType: adminId ? 'ADMIN' : 'SYSTEM',
      actorRef: adminId ?? null,
      detail: { seq: cp.seq, target: result.target, reference: result.reference },
    });

    return { seq: cp.seq, hash: cp.hash, ...result };
  }

  /**
   * 단계 전환(개시·마감·개표) 때 자동으로 고정한다.
   * 실패해도 선거 진행 자체는 막지 않되, 반드시 로그를 남겨 나중에 다시 시도할 수 있게 한다 —
   * 고정에 실패한 채로 선거가 끝나면 그 구간은 검증할 수 없다.
   */
  async autoAnchor(electionId: string, adminId?: string) {
    const targets = (process.env.ANCHOR_TARGETS ?? 'FILE')
      .split(',').map((s) => s.trim()).filter(Boolean);

    for (const t of targets) {
      try {
        await this.anchorLatest(electionId, t, adminId);
      } catch (e) {
        this.logger.error(`외부 고정 실패 (${t}): ${(e as Error).message}`);
        await this.audit.log({
          electionId, action: 'ANCHOR_FAILED', actorType: 'SYSTEM',
          detail: { target: t, error: (e as Error).message },
        });
      }
    }
  }
}
