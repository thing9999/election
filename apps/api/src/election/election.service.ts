import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ElectionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 지금 투표할 수 있는 선거.
   *
   * 유권자는 선거 ID 를 모른다. 화면에 ID 를 박아두면 선거가 바뀔 때마다
   * 배포를 다시 해야 하므로, 진행 중인 선거를 서버가 알려준다.
   */
  async getCurrent() {
    const open = await this.prisma.election.findFirst({
      where: { status: 'OPEN' },
      orderBy: { startsAt: 'desc' },
      select: { id: true },
    });
    if (!open) {
      throw new NotFoundException('현재 진행 중인 선거가 없습니다.');
    }
    return this.getPublic(open.id);
  }

  /** 공개 정보: 선거 개요 + 후보 명단 (득표수는 절대 포함하지 않는다) */
  async getPublic(electionId: string) {
    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        startsAt: true,
        endsAt: true,
        // 브라우저가 표를 봉인하려면 이게 필요하다. 공개키라 내려보내도 안전하다.
        ballotPublicKey: true,
        candidates: {
          orderBy: { ballotNumber: 'asc' },
          select: {
            id: true,
            ballotNumber: true,
            name: true,
            affiliation: true,
            pledge: true,
            photoUrl: true,
          },
        },
      },
    });
    if (!election) throw new NotFoundException('선거를 찾을 수 없습니다.');
    return election;
  }

  /**
   * 개표 결과. status 가 TALLIED 일 때만 응답한다.
   * 이 가드가 이 함수의 존재 이유다 — 마감 전 득표 노출은
   * 남은 유권자의 선택을 바꾸고, 그것만으로 선거가 무효가 될 수 있다.
   */
  async getResults(electionId: string) {
    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
      select: { id: true, title: true, status: true, talliedAt: true, invalidVotes: true },
    });
    if (!election) throw new NotFoundException('선거를 찾을 수 없습니다.');
    if (election.status !== 'TALLIED') {
      throw new ForbiddenException('아직 개표되지 않았습니다.');
    }
    const invalidRow = election;

    // 표는 봉인되어 있어 여기서 셀 수 없다. 개표 때 기록해둔 집계를 읽는다.
    const [candidates, tallied, totalBallots, eligible] = await Promise.all([
      this.prisma.candidate.findMany({
        where: { electionId },
        orderBy: { ballotNumber: 'asc' },
        select: { id: true, ballotNumber: true, name: true, affiliation: true },
      }),
      this.prisma.tallyResult.findMany({
        where: { electionId },
        select: { candidateId: true, votes: true },
      }),
      this.prisma.ballot.count({ where: { electionId } }),
      this.prisma.voter.count({ where: { electionId } }),
    ]);

    const counts = new Map(tallied.map((t) => [t.candidateId, t.votes]));
    const abstained = counts.get(null) ?? 0;
    const invalidVotes = invalidRow?.invalidVotes ?? 0;
    const valid = totalBallots - abstained - invalidVotes;

    const results = candidates
      .map((c) => {
        const votes = counts.get(c.id) ?? 0;
        return {
          ...c,
          votes,
          share: valid === 0 ? 0 : Math.round((votes / valid) * 10000) / 100,
        };
      })
      .sort((a, b) => b.votes - a.votes);

    return {
      election: { id: election.id, title: election.title, talliedAt: election.talliedAt },
      eligible,
      totalBallots,
      validBallots: valid,
      abstained,
      // 형식이 깨졌거나 명부에 없는 후보가 담긴 표. 0 이 아니면 반드시 조사해야 한다.
      invalid: invalidVotes,
      turnoutRate: eligible === 0 ? 0 : Math.round((totalBallots / eligible) * 10000) / 100,
      results,
    };
  }
}
