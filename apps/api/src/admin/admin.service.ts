import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { IntegrityService } from '../integrity/integrity.service';
import { AnchorService } from '../integrity/anchor.service';
import {
  hashIdentifier, normalizePhone, maskName, normalizeBirthDate,
} from '../common/crypto.util';
import {
  keyPairMatches, openBallot, generateElectionKeyPair,
} from '../common/ballot-crypto';

export interface RosterRow {
  memberNo: string;
  name: string;
  phone: string;
  birthDate: string; // YYYYMMDD (구분자 있어도 됨)
}

/** 개표에 필요한 서로 다른 선관위원 승인 수 */
const TALLY_QUORUM = Number(process.env.TALLY_QUORUM ?? 2);

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly integrity: IntegrityService,
    private readonly anchors: AnchorService,
  ) {}

  private get pepper(): string {
    return this.config.getOrThrow<string>('VOTER_ID_PEPPER');
  }

  /** 선거 목록. 화면에서 한눈에 상태를 보려면 집계가 같이 필요하다. */
  async listElections() {
    const elections = await this.prisma.election.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, status: true, startsAt: true, endsAt: true,
        talliedAt: true, createdAt: true,
        _count: { select: { candidates: true, voters: true, ballots: true } },
      },
    });
    return elections.map((e) => ({
      id: e.id,
      title: e.title,
      status: e.status,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      talliedAt: e.talliedAt,
      candidateCount: e._count.candidates,
      voterCount: e._count.voters,
      ballotCount: e._count.ballots,
    }));
  }

  /**
   * 선거 한 건의 운영 현황.
   *
   * 투표율은 진행 중에도 보여준다. 후보별 득표는 개표 전까지 어디에도 담지 않는다 —
   * 선관위 화면이라고 예외를 두면 그 화면이 곧 유출 경로가 된다.
   */
  async electionOverview(electionId: string) {
    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
      select: {
        id: true, title: true, description: true, status: true,
        startsAt: true, endsAt: true, talliedAt: true, talliedBy: true,
        invalidVotes: true, ballotPublicKey: true,
        candidates: {
          orderBy: { ballotNumber: 'asc' },
          select: { id: true, ballotNumber: true, name: true, affiliation: true, pledge: true },
        },
      },
    });
    if (!election) throw new BadRequestException('선거를 찾을 수 없습니다.');

    const [eligible, voted, ballots, approvals] = await Promise.all([
      this.prisma.voter.count({ where: { electionId } }),
      this.prisma.voter.count({ where: { electionId, hasVoted: true } }),
      this.prisma.ballot.count({ where: { electionId } }),
      this.prisma.tallyApproval.findMany({
        where: { electionId },
        include: { admin: { select: { name: true } } },
        orderBy: { approvedAt: 'asc' },
      }),
    ]);

    return {
      ...election,
      hasKey: election.ballotPublicKey !== null,
      ballotPublicKey: undefined,
      turnout: {
        eligible,
        voted,
        rate: eligible === 0 ? 0 : Math.round((voted / eligible) * 10000) / 100,
      },
      integrity: { votedVoters: voted, ballots, matched: voted === ballots },
      tally: {
        approvals: approvals.length,
        required: TALLY_QUORUM,
        approvedBy: approvals.map((a) => ({ name: a.admin.name, at: a.approvedAt })),
      },
    };
  }

  /**
   * 선거 생성.
   *
   * 봉인 키쌍을 여기서 만든다. **개인키는 이 함수의 반환값에만 존재하고
   * 어디에도 저장하지 않는다** — 화면에서 한 번 보여주고 끝이다.
   * 잃어버리면 개표가 불가능하므로 UI 가 그 사실을 분명히 알려야 한다.
   */
  async createElection(
    input: {
      title: string;
      description?: string;
      startsAt: string;
      endsAt: string;
      candidates: Array<{
        ballotNumber: number; name: string; affiliation?: string; pledge?: string;
      }>;
    },
    adminId: string,
  ) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('시작/종료 일시가 올바르지 않습니다.');
    }
    if (endsAt <= startsAt) {
      throw new BadRequestException('종료 일시가 시작 일시보다 앞설 수 없습니다.');
    }

    const numbers = input.candidates.map((c) => c.ballotNumber);
    if (new Set(numbers).size !== numbers.length) {
      throw new BadRequestException('기호가 중복됩니다.');
    }

    const { publicKey, privateKey } = generateElectionKeyPair();

    const election = await this.prisma.election.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        startsAt,
        endsAt,
        ballotPublicKey: publicKey,
        candidates: {
          create: input.candidates.map((c) => ({
            ballotNumber: c.ballotNumber,
            name: c.name,
            affiliation: c.affiliation || null,
            pledge: c.pledge || null,
          })),
        },
      },
      select: { id: true, title: true, status: true },
    });

    await this.audit.log({
      electionId: election.id,
      action: 'ELECTION_CREATE',
      actorType: 'ADMIN',
      actorRef: adminId,
      detail: { candidates: input.candidates.length },
    });

    // privateKey 는 여기서만 나온다. 로그에도 남기지 않는다.
    return { election, privateKey, publicKey };
  }

  /** 후보 교체. 투표가 시작된 뒤 후보가 바뀌면 그 선거는 신뢰할 수 없다. */
  async replaceCandidates(
    electionId: string,
    candidates: Array<{
      ballotNumber: number; name: string; affiliation?: string; pledge?: string;
    }>,
    adminId: string,
  ) {
    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
      select: { status: true },
    });
    if (!election) throw new BadRequestException('선거를 찾을 수 없습니다.');
    if (election.status !== 'DRAFT') {
      throw new ConflictException('준비중(DRAFT) 상태에서만 후보를 바꿀 수 있습니다.');
    }

    const numbers = candidates.map((c) => c.ballotNumber);
    if (new Set(numbers).size !== numbers.length) {
      throw new BadRequestException('기호가 중복됩니다.');
    }

    await this.prisma.$transaction([
      this.prisma.candidate.deleteMany({ where: { electionId } }),
      this.prisma.candidate.createMany({
        data: candidates.map((c) => ({
          electionId,
          ballotNumber: c.ballotNumber,
          name: c.name,
          affiliation: c.affiliation || null,
          pledge: c.pledge || null,
        })),
      }),
    ]);

    await this.audit.log({
      electionId, action: 'CANDIDATES_REPLACED', actorType: 'ADMIN', actorRef: adminId,
      detail: { count: candidates.length },
    });
    return { ok: true, count: candidates.length };
  }

  /**
   * 유권자 명부 일괄 등록.
   *
   * DRAFT 상태에서만 허용한다. 투표가 시작된 뒤 명부가 바뀌면
   * 그 선거는 결과를 신뢰할 수 없게 된다.
   */
  async importRoster(params: { electionId: string; rows: RosterRow[]; adminId: string }) {
    const { electionId, rows, adminId } = params;

    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
      select: { status: true },
    });
    if (!election) throw new BadRequestException('선거를 찾을 수 없습니다.');
    if (election.status !== 'DRAFT') {
      throw new ConflictException('준비중(DRAFT) 상태에서만 명부를 등록할 수 있습니다.');
    }

    // 봉인 후에는 못 바꾼다. 바꿀 수 있으면 후보 캠프에 배포한 해시가 의미를 잃는다.
    const seal = await this.integrity.rosterSealState(electionId);
    if (seal.sealed) {
      throw new ConflictException(
        '명부가 이미 확정(봉인)되었습니다. 바꾸려면 새 선거를 만드세요 — ' +
          '봉인 해시를 이미 참관인·후보 캠프에 배포했을 수 있습니다.',
      );
    }

    const seenMember = new Set<string>();
    // 휴대폰이 로그인 키이므로 회원마다 고유해야 한다. 겹치면 그 폰을 쥔 사람이
    // 두 명 몫을 투표할 수 있다. 어느 행끼리 겹쳤는지 알려줘야 선관위가 고칠 수 있다.
    const seenPhone = new Map<string, number>();
    const dupPhones: string[] = [];

    const data = rows.map((r, i) => {
      const line = i + 2; // CSV 헤더 다음이 2행
      if (!r.memberNo?.trim() || !r.phone?.trim() || !r.name?.trim() || !r.birthDate?.trim()) {
        throw new BadRequestException(
          `${line}행: 회원번호/이름/휴대폰/생년월일이 비어 있습니다.`,
        );
      }
      let birthDate: string;
      try {
        birthDate = normalizeBirthDate(r.birthDate);
      } catch (e) {
        throw new BadRequestException(`${line}행: ${(e as Error).message}`);
      }
      const memberNoHash = hashIdentifier(r.memberNo, this.pepper);
      if (seenMember.has(memberNoHash)) {
        throw new BadRequestException(`${line}행: 회원번호가 중복됩니다.`);
      }
      seenMember.add(memberNoHash);

      const phoneE164 = normalizePhone(r.phone);
      const phoneHash = hashIdentifier(phoneE164, this.pepper);
      const first = seenPhone.get(phoneHash);
      if (first !== undefined) {
        dupPhones.push(`${first}행 · ${line}행 (···${phoneE164.slice(-4)})`);
      } else {
        seenPhone.set(phoneHash, line);
      }

      return {
        electionId,
        memberNoHash,
        phoneHash,
        birthDateHash: hashIdentifier(birthDate, this.pepper),
        // 본인확인 서비스가 돌려준 통신사 명의와 대조할 때 쓴다.
        // nameMasked("홍*동")로는 서로 다른 이름이 같은 값이 되어 대조가 안 된다.
        nameHash: hashIdentifier(r.name.trim(), this.pepper),
        phoneLast4: phoneE164.slice(-4),
        nameMasked: maskName(r.name.trim()),
      };
    });

    if (dupPhones.length > 0) {
      throw new BadRequestException(
        `같은 휴대폰번호가 여러 회원에게 등록되어 있습니다 (${dupPhones.length}건). ` +
          '휴대폰은 로그인 수단이라 회원마다 달라야 합니다 — 겹치면 그 번호를 가진 사람이 ' +
          '두 명 몫을 투표할 수 있습니다. 해당 회원의 번호를 확인한 뒤 다시 등록하세요. ' +
          `[${dupPhones.slice(0, 10).join(', ')}${dupPhones.length > 10 ? ' …' : ''}]`,
      );
    }

    // 1만 건 이상이면 청크로 나눠 넣는다.
    const CHUNK = 2000;
    let inserted = 0;
    for (let i = 0; i < data.length; i += CHUNK) {
      const res = await this.prisma.voter.createMany({
        data: data.slice(i, i + CHUNK),
        skipDuplicates: true,
      });
      inserted += res.count;
    }

    await this.audit.log({
      electionId,
      action: 'ROSTER_IMPORT',
      actorType: 'ADMIN',
      actorRef: adminId,
      detail: { submitted: rows.length, inserted },
    });

    return { submitted: rows.length, inserted };
  }

  /** CSV 파싱: memberNo,name,phone 헤더 필요 */
  parseRosterCsv(csv: string): RosterRow[] {
    const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new BadRequestException('CSV 에 데이터가 없습니다.');

    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const idx = {
      memberNo: header.indexOf('memberno'),
      name: header.indexOf('name'),
      phone: header.indexOf('phone'),
      birthDate: header.indexOf('birthdate'),
    };
    if (Object.values(idx).some((i) => i < 0)) {
      throw new BadRequestException(
        'CSV 헤더는 memberNo,name,phone,birthDate 이어야 합니다.',
      );
    }

    return lines.slice(1).map((line) => {
      const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      return {
        memberNo: cols[idx.memberNo],
        name: cols[idx.name],
        phone: cols[idx.phone],
        birthDate: cols[idx.birthDate],
      };
    });
  }

  /**
   * 명부 확정(봉인).
   *
   * 개시 때 굳히는 것만으로는 한 구간이 비어 있다 — **명부를 공개해서 이의신청을 받은
   * 뒤 개시하기 전까지** 바꿔치기하면 아무도 모른다. 그래서 확정 시점에 따로 굳히고,
   * 그 해시를 후보 캠프·참관인에게 배포한다. 개시 때는 이 해시와 대조만 한다.
   *
   * 봉인 이후에는 명부를 바꿀 수 없다.
   */
  async sealRoster(electionId: string, adminId: string) {
    const election = await this.prisma.election.findUnique({
      where: { id: electionId }, select: { status: true },
    });
    if (!election) throw new BadRequestException('선거를 찾을 수 없습니다.');
    if (election.status !== 'DRAFT') {
      throw new ConflictException('준비중(DRAFT) 상태에서만 명부를 확정할 수 있습니다.');
    }

    const already = await this.integrity.rosterSealState(electionId);
    if (already.sealed) {
      throw new ConflictException('명부는 이미 확정되었습니다.');
    }

    const voterCount = await this.prisma.voter.count({ where: { electionId } });
    if (voterCount === 0) throw new BadRequestException('유권자 명부가 비어 있습니다.');

    const cp = await this.integrity.createCheckpoint({
      electionId, kind: 'ROSTER_SEALED', adminId,
    });
    await this.anchors.autoAnchor(electionId, adminId);
    await this.audit.log({
      electionId, action: 'ROSTER_SEALED', actorType: 'ADMIN', actorRef: adminId,
      detail: { voterCount, rosterHash: cp.rosterHash },
    });

    return {
      ok: true,
      voterCount,
      rosterHash: cp.rosterHash,
      checkpointSeq: cp.seq,
      // 이 값을 그대로 배포하라는 뜻이다. 앞자리만 잘라 보내면 대조가 안 된다.
      안내: '이 명부 해시를 후보 캠프·참관인에게 지금 배포하세요. 개시 전에 배포해야 의미가 있습니다.',
    };
  }

  async openElection(electionId: string, adminId: string) {
    const voterCount = await this.prisma.voter.count({ where: { electionId } });
    const candidateCount = await this.prisma.candidate.count({ where: { electionId } });
    if (voterCount === 0) throw new BadRequestException('유권자 명부가 비어 있습니다.');
    if (candidateCount < 1) throw new BadRequestException('후보가 등록되지 않았습니다.');

    // 명부가 확정 시점과 같은지 먼저 본다. 다르면 개시하지 않는다 —
    // 여기서 통과시키면 바꿔치기된 명부로 선거가 시작된다.
    let seal = await this.integrity.rosterSealState(electionId);
    if (seal.sealed && !seal.matches) {
      throw new ConflictException(
        '명부가 확정 당시와 다릅니다. 개시할 수 없습니다. ' +
          '유권자가 추가되거나 삭제되었습니다 — 반드시 원인을 조사하세요.',
      );
    }
    if (!seal.sealed) {
      // 확정 단계를 건너뛴 경우. 지금이라도 굳히되, 이 해시는 사전 배포되지 않았으므로
      // "공개된 명부와 같다"까지는 증명되지 않는다.
      this.logger.warn(
        `선거 ${electionId}: 명부를 사전 확정하지 않고 개시합니다. ` +
          '개시 전에 sealRoster 로 확정하고 해시를 배포하는 것이 맞습니다.',
      );
      await this.integrity.createCheckpoint({ electionId, kind: 'ROSTER_SEALED', adminId });
      seal = await this.integrity.rosterSealState(electionId);
    }

    const res = await this.prisma.election.updateMany({
      where: { id: electionId, status: 'DRAFT' },
      data: { status: 'OPEN' },
    });
    if (res.count === 0) throw new ConflictException('DRAFT 상태의 선거만 개시할 수 있습니다.');

    await this.audit.log({
      electionId, action: 'ELECTION_OPEN', actorType: 'ADMIN', actorRef: adminId,
      detail: { voterCount, candidateCount },
    });

    await this.integrity.createCheckpoint({ electionId, kind: 'BALLOTS', adminId });
    await this.anchors.autoAnchor(electionId, adminId);

    return { ok: true, voterCount, candidateCount, rosterSealedAt: seal.sealedAt };
  }

  async closeElection(electionId: string, adminId: string) {
    const res = await this.prisma.election.updateMany({
      where: { id: electionId, status: 'OPEN' },
      data: { status: 'CLOSED' },
    });
    if (res.count === 0) throw new ConflictException('진행중(OPEN)인 선거만 마감할 수 있습니다.');
    await this.audit.log({ electionId, action: 'ELECTION_CLOSE', actorType: 'ADMIN', actorRef: adminId });

    // 마감 시점의 표 집합을 굳힌다. 개표 전에 표를 넣거나 빼면 여기서 어긋난다.
    await this.integrity.createCheckpoint({ electionId, kind: 'FINAL', adminId });
    await this.anchors.autoAnchor(electionId, adminId);

    return { ok: true };
  }

  /**
   * 개표 승인. 2인 승인(dual control)이 모여야 실제로 개표된다.
   *
   * 관리자 한 명이 혼자 개표를 실행할 수 있으면, 계정 하나가 뚫렸을 때
   * 그 사람이 임의의 시점에 개표를 눌러 결과를 먼저 볼 수 있다.
   * 서로 다른 선관위원 2명의 승인을 요구하면 계정 하나로는 불가능해진다.
   *
   * CLOSED → TALLIED 는 단방향이다. 되돌리는 API 는 만들지 않는다.
   */
  async approveTally(electionId: string, adminId: string, privateKey: string) {
    const election = await this.prisma.election.findUnique({
      where: { id: electionId },
      select: { status: true, ballotPublicKey: true },
    });
    if (!election) throw new BadRequestException('선거를 찾을 수 없습니다.');
    if (!election.ballotPublicKey) {
      throw new ConflictException('이 선거에는 봉인키가 설정되어 있지 않습니다.');
    }
    // 승인을 기록하기 전에 키부터 확인한다. 엉뚱한 키로 정족수를 채워놓고
    // 개표 단계에서 실패하면 승인 기록만 남아 상태가 꼬인다.
    if (!keyPairMatches(election.ballotPublicKey, privateKey)) {
      throw new BadRequestException(
        '개표키가 이 선거의 봉인키와 일치하지 않습니다. 보관 중인 키를 다시 확인하세요.',
      );
    }
    if (election.status === 'TALLIED') {
      throw new ConflictException('이미 개표가 완료되었습니다.');
    }
    if (election.status !== 'CLOSED') {
      throw new ConflictException('마감(CLOSED)된 선거만 개표할 수 있습니다.');
    }

    // 개표 전 무결성이 깨져 있으면 승인 자체를 받지 않는다.
    const integrity = await this.integrityCheck(electionId);
    if (!integrity.matched) {
      throw new ConflictException(
        `무결성 점검 실패: 투표자 ${integrity.votedVoters}명 / 표 ${integrity.ballots}장. ` +
          '원인을 규명하기 전에는 개표할 수 없습니다.',
      );
    }

    // @@unique([electionId, adminId]) 가 같은 사람의 중복 승인을 막는다.
    try {
      await this.prisma.tallyApproval.create({ data: { electionId, adminId } });
    } catch {
      throw new ConflictException('이미 개표를 승인하셨습니다. 다른 위원의 승인이 필요합니다.');
    }

    await this.audit.log({
      electionId, action: 'TALLY_APPROVED', actorType: 'ADMIN', actorRef: adminId,
    });

    const approvals = await this.prisma.tallyApproval.findMany({
      where: { electionId },
      include: { admin: { select: { name: true } } },
      orderBy: { approvedAt: 'asc' },
    });

    if (approvals.length < TALLY_QUORUM) {
      return {
        tallied: false,
        approvals: approvals.length,
        required: TALLY_QUORUM,
        approvedBy: approvals.map((a) => a.admin.name),
        message: `승인 ${approvals.length}/${TALLY_QUORUM}. 다른 선관위원의 승인을 기다립니다.`,
      };
    }

    // ── 정족수 충족 — 실제 개표 ──
    // status 조건을 다시 걸어 동시 승인에서도 한 번만 실행되게 한다.
    const claimed = await this.prisma.election.updateMany({
      where: { id: electionId, status: 'CLOSED' },
      data: { talliedAt: new Date(), talliedBy: adminId },
    });
    if (claimed.count === 0) {
      throw new ConflictException('이미 개표가 완료되었습니다.');
    }

    const { counts, invalid, opened } = await this.openAndCount(
      electionId, election.ballotPublicKey, privateKey,
    );

    // 집계만 저장한다. 복호화된 개별 표는 저장하지 않는다 —
    // 저장하는 순간 봉인으로 얻은 것이 전부 사라진다.
    // 기존 행을 지우고 다시 쓰지 않는다. 바로 위 updateMany 가 status='CLOSED' 를
    // 조건으로 걸어 개표를 한 번만 통과시키므로 남은 행이 있을 수 없고,
    // 지우지 않으면 앱 DB 계정에서 TallyResult 의 DELETE 권한을 통째로 뺄 수 있다.
    await this.prisma.$transaction([
      this.prisma.tallyResult.createMany({
        data: [...counts.entries()].map(([candidateId, votes]) => ({
          electionId, candidateId, votes,
        })),
      }),
      this.prisma.election.update({
        where: { id: electionId },
        data: { status: 'TALLIED', invalidVotes: invalid },
      }),
    ]);

    await this.audit.log({
      electionId, action: 'TALLY', actorType: 'ADMIN', actorRef: adminId,
      detail: {
        approvedBy: approvals.map((a) => a.adminId),
        ballots: integrity.ballots, opened, invalid,
      },
    });

    // 결과를 굳힌다. 개표 후 득표수를 고치면 이 해시와 어긋난다.
    await this.integrity.createCheckpoint({ electionId, kind: 'RESULTS', adminId });
    await this.anchors.autoAnchor(electionId, adminId);

    return {
      tallied: true,
      approvals: approvals.length,
      required: TALLY_QUORUM,
      approvedBy: approvals.map((a) => a.admin.name),
      opened,
      invalid,
      message:
        invalid === 0
          ? '개표가 완료되었습니다.'
          : `개표가 완료되었습니다. 다만 열 수 없는 표가 ${invalid}건 있었습니다. ` +
            '원인을 조사하고, 당락에 영향을 줄 수 있는 규모인지 확인하세요.',
    };
  }

  /**
   * 봉인된 표를 열어 후보별로 센다.
   *
   * 개인키와 복호화된 표는 이 함수 안에서만 존재하고 밖으로 나가지 않는다.
   * 표는 무작위 순서로 읽는다 — 삽입 순서대로 읽으면 그 순서 자체가
   * 나중에 투표 순서와 대조될 수 있다.
   */
  private async openAndCount(
    electionId: string,
    publicKey: string,
    privateKey: string,
  ): Promise<{ counts: Map<string | null, number>; invalid: number; opened: number }> {
    const counts = new Map<string | null, number>();
    const valid = new Set(
      (await this.prisma.candidate.findMany({
        where: { electionId }, select: { id: true },
      })).map((c) => c.id),
    );

    const CHUNK = 5000;
    let cursor: string | undefined;
    let opened = 0;
    let damaged = 0;

    for (;;) {
      const batch = await this.prisma.ballot.findMany({
        where: { electionId },
        select: { id: true, sealedVote: true },
        orderBy: { id: 'asc' }, // id 는 무작위 UUID 라 투표 순서를 드러내지 않는다
        take: CHUNK,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;

      for (const b of batch) {
        // 봉인을 브라우저가 하므로, 조작된 클라이언트가 쓰레기를 봉인해 보낼 수 있다.
        // 그런 표를 만났다고 개표를 멈추면 유권자 한 명이 표 하나로 선거 전체를
        // 막을 수 있다. 그래서 무효표로 세고 계속하되, 개수를 반드시 남긴다.
        // 조용히 버리지 않는 이유는 그것 자체가 조작 수단이 되기 때문이다.
        let choice: string | null;
        try {
          choice = openBallot(privateKey, publicKey, b.sealedVote);
        } catch {
          damaged++;
          continue;
        }
        if (choice !== null && !valid.has(choice)) {
          // 열리기는 했는데 이 선거의 후보가 아니다.
          damaged++;
          continue;
        }
        counts.set(choice, (counts.get(choice) ?? 0) + 1);
        opened++;
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < CHUNK) break;
    }

    return { counts, invalid: damaged, opened };
  }

  /** 현재 개표 승인 현황 */
  async tallyStatus(electionId: string) {
    const [election, approvals] = await Promise.all([
      this.prisma.election.findUnique({
        where: { id: electionId },
        select: { status: true, talliedAt: true },
      }),
      this.prisma.tallyApproval.findMany({
        where: { electionId },
        include: { admin: { select: { name: true } } },
        orderBy: { approvedAt: 'asc' },
      }),
    ]);
    if (!election) throw new BadRequestException('선거를 찾을 수 없습니다.');
    return {
      status: election.status,
      talliedAt: election.talliedAt,
      approvals: approvals.length,
      required: TALLY_QUORUM,
      approvedBy: approvals.map((a) => ({ name: a.admin.name, at: a.approvedAt })),
    };
  }

  /**
   * 무결성 점검 — 개표 전 반드시 돌린다.
   * "투표했다고 표시된 사람 수" 와 "실제 표 수"가 다르면 어딘가 잘못된 것이다.
   */
  async integrityCheck(electionId: string) {
    const [votedVoters, ballots, chain] = await Promise.all([
      this.prisma.voter.count({ where: { electionId, hasVoted: true } }),
      this.prisma.ballot.count({ where: { electionId } }),
      this.integrity.verifyChain(electionId),
    ]);
    return {
      votedVoters,
      ballots,
      // 표 수 대조는 DB 안에서만 보는 것이라, 공격자가 양쪽을 같이 고치면 통과한다.
      // 그래서 해시 사슬 검증(chain)을 함께 본다 — 이쪽은 그 방법으로 못 속인다.
      matched: votedVoters === ballots,
      diff: ballots - votedVoters,
      chain: {
        ok: chain.ok,
        checkpoints: chain.checkpoints,
        problems: chain.problems,
        head: chain.head,
      },
    };
  }
}
