import {
  Injectable,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { SEALED_BALLOT_LEN } from '../common/ballot-crypto';
import { SmsService } from '../auth/sms.service';

/**
 * 투표 시각을 시(hour) 단위로 내림.
 * Ballot 에 초 단위 시각을 남기면 접속 로그의 로그인 시각과 대조해
 * 개인의 표를 역추적할 수 있다. 익명성은 이 한 줄에 달려 있다.
 */
function truncateToHour(d: Date): Date {
  const t = new Date(d);
  t.setMinutes(0, 0, 0);
  return t;
}

@Injectable()
export class VoteService {
  private readonly logger = new Logger(VoteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
  ) {}

  /**
   * 표를 던진다.
   *
   * 동시성 안전성의 근거:
   *   UPDATE voter SET has_voted = true WHERE id = ? AND has_voted = false
   * 이 한 문장이 원자적 compare-and-swap 역할을 한다.
   * 같은 유권자의 요청이 동시에 두 개 들어오면 Postgres 가 행 잠금을 걸고,
   * 나중 트랜잭션은 커밋된 값(has_voted = true)으로 WHERE 를 재평가하므로
   * 0건이 매칭된다 → 두 번째 표는 만들어지지 않는다.
   *
   * 서로 다른 유권자끼리는 다른 행이므로 경합이 없다.
   * 1만 명이 동시에 눌러도 잠금 대기는 발생하지 않는다.
   */
  async castBallot(params: {
    voterId: string;
    electionId: string;
    /** 브라우저가 봉인해서 보낸 133바이트 (base64). 서버는 내용을 알 수 없다. */
    sealedVoteB64: string;
    /** 완료 문자를 보낼 번호. 세션에서만 오고 저장하지 않는다. */
    phone?: string;
    ipPrefix?: string;
  }): Promise<{ completedAt: Date; confirmationCode: string }> {
    const { voterId, electionId, sealedVoteB64, phone, ipPrefix } = params;

    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
      select: {
        id: true, status: true, startsAt: true, endsAt: true, ballotPublicKey: true,
      },
    });
    if (!election) throw new BadRequestException('존재하지 않는 선거입니다.');
    if (!election.ballotPublicKey) {
      throw new BadRequestException('선거 봉인키가 설정되지 않았습니다. 선관위에 문의하세요.');
    }

    const now = new Date();
    if (election.status !== 'OPEN') {
      throw new ForbiddenException('현재 투표 기간이 아닙니다.');
    }
    if (now < election.startsAt) {
      throw new ForbiddenException('투표 시작 전입니다.');
    }
    if (now > election.endsAt) {
      throw new ForbiddenException('투표가 마감되었습니다.');
    }

    // ── 서버가 확인할 수 있는 전부 ──
    // 봉인된 표의 내용은 개인키가 없어 볼 수 없다. 즉 "이 선거의 후보인가"를
    // 여기서 검증할 방법이 없다. 그건 개표 때 드러나고, 그때 무효표로 센다
    // (AdminService.openAndCount). 개표를 중단시키지 않는 이유는
    // 그렇게 하면 유권자 한 명이 쓰레기 표 하나로 선거 전체를 막을 수 있기 때문이다.
    let sealedVote: Uint8Array<ArrayBuffer>;
    try {
      sealedVote = Uint8Array.from(Buffer.from(sealedVoteB64, 'base64'));
    } catch {
      throw new BadRequestException('투표지 형식이 올바르지 않습니다.');
    }
    if (sealedVote.length !== SEALED_BALLOT_LEN) {
      throw new BadRequestException(
        `투표지 길이가 올바르지 않습니다 (${sealedVote.length} != ${SEALED_BALLOT_LEN}).`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // ── 1단계: 투표권 소진 (원자적) ──
      const claimed = await tx.voter.updateMany({
        where: { id: voterId, electionId, hasVoted: false },
        data: { hasVoted: true, votedAt: now },
      });

      if (claimed.count === 0) {
        // 이미 has_voted = true 이거나, 이 선거의 유권자가 아니다.
        throw new ConflictException('이미 투표를 완료하셨습니다.');
      }

      // ── 2단계: 봉인된 표 기록 ──
      // data 객체에 voterId 를 넣을 수 있는 필드가 스키마에 아예 없고,
      // 후보 선택은 봉인되어 개인키 없이는 읽을 수 없다.
      await tx.ballot.create({
        data: {
          electionId,
          sealedVote,
          castAtHour: truncateToHour(now),
        },
      });
    });

    // 감사 로그에도 voterId 를 남기지 않는다. 사건이 일어났다는 사실만 남긴다.
    await this.audit.log({
      electionId,
      action: 'VOTE_CAST',
      actorType: 'VOTER',
      actorRef: null,
      ipPrefix,
    });

    // 확인번호는 표 내용과 무관하게 파생된다.
    // 표 내용을 증명할 수 있는 영수증을 주면 매표(vote buying)가 가능해진다.
    const confirmationCode = this.makeConfirmationCode();

    // 투표 완료 문자. 기권자 명의로 표를 채우는 조작을 잡는 유일한 수단이다 —
    // 투표하지 않은 회원이 이 문자를 받으면 그 자리에서 드러난다.
    //
    // 발송 실패가 투표를 되돌리게 해서는 안 된다. 표는 이미 확정되었고,
    // 여기서 예외를 던지면 유권자는 실패한 줄 알고 다시 시도했다가 409 를 본다.
    // 대신 반드시 로그를 남긴다 — 못 간 문자만큼 이 방어가 비어 있다.
    if (phone) {
      this.sms.sendVoteReceipt(phone, confirmationCode).catch((e) => {
        this.logger.error(`투표 완료 문자 발송 실패: ${(e as Error).message}`);
        void this.audit.log({
          electionId, action: 'VOTE_RECEIPT_FAILED', actorType: 'SYSTEM',
          detail: { reason: (e as Error).message },
        });
      });
    } else {
      // 번호 없이 들어온 세션. 문자가 안 나가므로 그만큼 탐지가 비어 있다.
      this.logger.warn('세션에 번호가 없어 투표 완료 문자를 보내지 못했습니다.');
    }

    return { completedAt: now, confirmationCode };
  }

  /** 이 유권자가 이미 투표했는지 (투표 화면 진입 시 확인용) */
  async getVotingStatus(voterId: string) {
    const voter = await this.prisma.voter.findUnique({
      where: { id: voterId },
      select: { hasVoted: true, votedAt: true, electionId: true },
    });
    if (!voter) throw new BadRequestException('유권자 정보를 찾을 수 없습니다.');
    return { hasVoted: voter.hasVoted, votedAt: voter.votedAt };
  }

  /**
   * 투표율. 마감 전에도 공개해도 되는 유일한 숫자다.
   * (후보별 득표는 마감 전 절대 노출 금지 — 남은 유권자의 선택에 영향을 준다)
   */
  async getTurnout(electionId: string) {
    const [total, voted] = await Promise.all([
      this.prisma.voter.count({ where: { electionId } }),
      this.prisma.voter.count({ where: { electionId, hasVoted: true } }),
    ]);
    return {
      eligible: total,
      voted,
      turnoutRate: total === 0 ? 0 : Math.round((voted / total) * 10000) / 100,
    };
  }

  private makeConfirmationCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I 제외
    const bytes = require('crypto').randomBytes(8) as Buffer;
    return Array.from(bytes)
      .map((b) => alphabet[b % alphabet.length])
      .join('');
  }
}
