import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { CheckpointKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { ballotLeaf, merkleRoot, hashRecord } from './merkle';

const GENESIS = '0'.repeat(64);
const CHUNK = 5000;

export interface ChainVerdict {
  ok: boolean;
  checkpoints: number;
  problems: string[];
  head: { seq: number; hash: string; kind: CheckpointKind; createdAt: Date } | null;
}

@Injectable()
export class IntegrityService {
  private readonly logger = new Logger(IntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 체크포인트를 하나 만든다.
   *
   * 그 시점까지의 표 전체에 대한 머클 루트를 계산하고, 직전 체크포인트의 해시를
   * 물려 사슬을 잇는다. 투표 경로는 건드리지 않는다 — 표가 다 들어온 뒤 읽기만 한다.
   */
  async createCheckpoint(params: {
    electionId: string;
    kind: CheckpointKind;
    adminId?: string;
  }) {
    const { electionId, kind, adminId } = params;

    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
      select: { id: true },
    });
    if (!election) throw new BadRequestException('선거를 찾을 수 없습니다.');

    const prev = await this.prisma.checkpoint.findFirst({
      where: { electionId },
      orderBy: { seq: 'desc' },
      select: { seq: true, hash: true },
    });

    const { root, count } = await this.computeBallotRoot(electionId);
    const rosterHash = kind === 'ROSTER_SEALED' ? await this.computeRosterHash(electionId) : null;
    const resultsHash = kind === 'RESULTS' ? await this.computeResultsHash(electionId) : null;

    const seq = (prev?.seq ?? 0) + 1;
    const prevHash = prev?.hash ?? GENESIS;
    const createdAt = new Date();

    const hash = this.checkpointHash({
      electionId, seq, kind, ballotCount: count,
      merkleRoot: root, rosterHash, resultsHash, prevHash,
      createdAt: createdAt.toISOString(),
    });

    const cp = await this.prisma.checkpoint.create({
      data: {
        electionId, seq, kind, ballotCount: count, merkleRoot: root,
        rosterHash, resultsHash, prevHash, hash, createdAt,
      },
    });

    await this.audit.log({
      electionId, action: 'CHECKPOINT', actorType: adminId ? 'ADMIN' : 'SYSTEM',
      actorRef: adminId ?? null,
      detail: { seq, kind, ballotCount: count, hash },
    });

    return cp;
  }

  /**
   * 사슬 전체를 다시 계산해 대조한다.
   *
   * 잡아내는 것:
   *   · 표가 추가·삭제·변조됨      → 머클 루트 불일치
   *   · 체크포인트 내용이 바뀜      → 자기 해시 불일치
   *   · 체크포인트가 통째로 지워짐  → seq 끊김 / prevHash 불일치
   *   · 결과 숫자가 바뀜            → resultsHash 불일치
   *
   * 잡아내지 **못하는** 것: 공격자가 DB 를 통째로 쥐고 사슬을 처음부터 다시
   * 만들어 끼워넣는 경우. 그건 외부 고정(Anchor)이 있어야 잡힌다.
   */
  async verifyChain(electionId: string): Promise<ChainVerdict> {
    const cps = await this.prisma.checkpoint.findMany({
      where: { electionId },
      orderBy: { seq: 'asc' },
    });

    const problems: string[] = [];
    if (cps.length === 0) {
      return { ok: false, checkpoints: 0, problems: ['체크포인트가 하나도 없습니다.'], head: null };
    }

    let expectedPrev = GENESIS;
    for (const [i, cp] of cps.entries()) {
      if (cp.seq !== i + 1) {
        problems.push(`체크포인트 순번이 끊겼습니다: ${i + 1} 이어야 하는데 ${cp.seq} 입니다.`);
      }
      if (cp.prevHash !== expectedPrev) {
        problems.push(`#${cp.seq} 의 이전 해시가 어긋납니다 — 앞의 체크포인트가 바뀌었거나 지워졌습니다.`);
      }
      const recomputed = this.checkpointHash({
        electionId, seq: cp.seq, kind: cp.kind, ballotCount: cp.ballotCount,
        merkleRoot: cp.merkleRoot, rosterHash: cp.rosterHash, resultsHash: cp.resultsHash,
        prevHash: cp.prevHash, createdAt: cp.createdAt.toISOString(),
      });
      if (recomputed !== cp.hash) {
        problems.push(`#${cp.seq} 의 내용이 기록된 해시와 다릅니다 — 체크포인트 자체가 수정되었습니다.`);
      }
      expectedPrev = cp.hash;
    }

    // 마지막 체크포인트가 지금의 표 집합과 맞는지 — 개표 후 표를 넣거나 뺐다면 여기서 걸린다.
    const head = cps[cps.length - 1];
    if (head.kind === 'FINAL' || head.kind === 'RESULTS') {
      const { root, count } = await this.computeBallotRoot(electionId);
      if (count !== head.ballotCount) {
        problems.push(
          `표의 수가 달라졌습니다: 확정 당시 ${head.ballotCount}장 → 현재 ${count}장.`,
        );
      } else if (root !== head.merkleRoot) {
        problems.push('표의 수는 같지만 내용이 달라졌습니다 — 어떤 표가 다른 표로 바뀌었습니다.');
      }
    }

    if (head.kind === 'RESULTS' && head.resultsHash) {
      const now = await this.computeResultsHash(electionId);
      if (now !== head.resultsHash) {
        problems.push('개표 결과가 확정 당시와 다릅니다 — 득표수가 수정되었습니다.');
      }
    }

    const rosterCp = cps.find((c) => c.kind === 'ROSTER_SEALED');
    if (rosterCp?.rosterHash) {
      const now = await this.computeRosterHash(electionId);
      if (now !== rosterCp.rosterHash) {
        problems.push('명부가 확정 당시와 다릅니다 — 유권자가 추가되거나 삭제되었습니다.');
      }
    }

    return {
      ok: problems.length === 0,
      checkpoints: cps.length,
      problems,
      head: { seq: head.seq, hash: head.hash, kind: head.kind, createdAt: head.createdAt },
    };
  }

  /**
   * 명부가 봉인된 적이 있는지, 있다면 지금 명부가 그때와 같은지.
   *
   * 개시 때 이걸 확인해야 "공개해서 이의신청까지 받은 명부"와 "실제로 투표에 쓴 명부"가
   * 같다는 것이 보장된다. 봉인만 해두고 개시 때 대조하지 않으면 그 사이에
   * 바꿔치기해도 아무도 모른다.
   */
  async rosterSealState(electionId: string): Promise<{
    sealed: boolean; matches: boolean; sealedAt: Date | null; seq: number | null;
  }> {
    const cp = await this.prisma.checkpoint.findFirst({
      where: { electionId, kind: 'ROSTER_SEALED' },
      orderBy: { seq: 'asc' },
    });
    if (!cp || !cp.rosterHash) {
      return { sealed: false, matches: false, sealedAt: null, seq: null };
    }
    const now = await this.computeRosterHash(electionId);
    return { sealed: true, matches: now === cp.rosterHash, sealedAt: cp.createdAt, seq: cp.seq };
  }

  /** 외부 고정 기록 */
  async recordAnchor(params: {
    checkpointId: string;
    target: string;
    reference: string;
    detail?: Record<string, unknown>;
  }) {
    return this.prisma.anchor.create({
      data: {
        checkpointId: params.checkpointId,
        target: params.target,
        reference: params.reference,
        detail: (params.detail ?? {}) as any,
      },
    });
  }

  /** 참관인·후보 캠프가 대조할 수 있도록 공개하는 사슬 요약 */
  async publicChain(electionId: string) {
    const cps = await this.prisma.checkpoint.findMany({
      where: { electionId },
      orderBy: { seq: 'asc' },
      include: {
        anchors: { select: { target: true, reference: true, anchoredAt: true } },
      },
    });
    return cps.map((c) => ({
      seq: c.seq,
      kind: c.kind,
      ballotCount: c.ballotCount,
      merkleRoot: c.merkleRoot,
      rosterHash: c.rosterHash,
      resultsHash: c.resultsHash,
      prevHash: c.prevHash,
      hash: c.hash,
      createdAt: c.createdAt,
      anchors: c.anchors,
    }));
  }

  // ── 내부 계산 ──

  private checkpointHash(v: {
    electionId: string; seq: number; kind: string; ballotCount: number;
    merkleRoot: string; rosterHash: string | null; resultsHash: string | null;
    prevHash: string; createdAt: string;
  }): string {
    return createHash('sha256')
      .update([
        'kma-checkpoint-v1', v.electionId, v.seq, v.kind, v.ballotCount,
        v.merkleRoot, v.rosterHash ?? '-', v.resultsHash ?? '-', v.prevHash, v.createdAt,
      ].join('\n'))
      .digest('hex');
  }

  /** 표 전체의 머클 루트. id 순으로 고정해 투표 순서를 드러내지 않는다. */
  private async computeBallotRoot(electionId: string) {
    const leaves: Buffer[] = [];
    let cursor: string | undefined;

    for (;;) {
      const batch = await this.prisma.ballot.findMany({
        where: { electionId },
        select: { id: true, castAtHour: true, sealedVote: true },
        orderBy: { id: 'asc' },
        take: CHUNK,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;
      for (const b of batch) leaves.push(ballotLeaf(b));
      cursor = batch[batch.length - 1].id;
      if (batch.length < CHUNK) break;
    }

    return { root: merkleRoot(leaves).toString('hex'), count: leaves.length };
  }

  /**
   * 명부 해시. 개시 시점에 굳혀두면 나중에 가짜 유권자를 넣는 것이 드러난다.
   * 해시값만 쓰므로 이 값에서 명부를 복원할 수는 없다.
   */
  private async computeRosterHash(electionId: string): Promise<string> {
    const voters = await this.prisma.voter.findMany({
      where: { electionId },
      select: { memberNoHash: true, phoneHash: true, birthDateHash: true },
      orderBy: { memberNoHash: 'asc' },
    });
    return hashRecord([
      'kma-roster-v1', voters.length,
      ...voters.flatMap((v) => [v.memberNoHash, v.phoneHash, v.birthDateHash]),
    ]);
  }

  /** 개표 결과 해시. 득표수를 나중에 고치면 어긋난다. */
  private async computeResultsHash(electionId: string): Promise<string> {
    const [rows, election] = await Promise.all([
      this.prisma.tallyResult.findMany({
        where: { electionId },
        select: { candidateId: true, votes: true },
        orderBy: [{ candidateId: 'asc' }],
      }),
      this.prisma.election.findUnique({
        where: { id: electionId },
        select: { invalidVotes: true },
      }),
    ]);
    return hashRecord([
      'kma-results-v1', election?.invalidVotes ?? 0, rows.length,
      ...rows.flatMap((r) => [r.candidateId ?? 'ABSTAIN', r.votes]),
    ]);
  }
}
