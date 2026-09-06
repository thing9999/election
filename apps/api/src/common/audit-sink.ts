import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { appendFile, readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * 감사 로그 외부 반출.
 *
 * ── 왜 필요한가 ──
 * 감사 로그가 같은 DB 에 있으면, DB 를 쥔 사람이 흔적까지 지울 수 있다.
 * 앱 계정에서는 DELETE 권한을 뺐지만(db-privileges) 소유자 계정은 여전히 지울 수 있고,
 * 무엇보다 **지워졌다는 사실 자체를 알 방법이 없다.** 로그가 원래 몇 줄이었는지
 * 아무도 모르기 때문이다.
 *
 * 그래서 DB 밖으로 한 벌 더 내보내고, 줄마다 **이전 줄의 해시를 물린다.**
 * 중간 한 줄만 지워도 그 뒤가 전부 어긋나므로, 조용히 지우는 것이 불가능해진다.
 *
 * ── 한계 ──
 * 파일이 같은 서버 안에 있으면 공격자가 파일도 같이 고칠 수 있다. 사슬을 통째로
 * 다시 만들면 되기 때문이다(무결성 체크포인트와 같은 한계).
 * **append-only 외부 저장소(S3 Object Lock 등)로 실어 날라야** 비로소 의미가 생긴다.
 * AUDIT_EXPORT_URL 로 외부 수집기에 동시 전송하는 경로를 함께 둔 이유가 그것이다.
 */

const GENESIS = '0'.repeat(64);

export interface AuditRecord {
  id: string;
  at: string;
  electionId: string | null;
  action: string;
  actorType: string;
  actorRef: string | null;
  detail: Record<string, unknown>;
  ipPrefix: string | null;
}

export interface ExportedLine extends AuditRecord {
  /** 이 줄을 쓴 프로세스. 사슬은 **인스턴스별로** 이어진다 */
  instance: string;
  seq: number;
  prevHash: string;
  hash: string;
}

/** 줄 하나의 해시. 필드 순서를 고정해 다시 계산할 수 있게 한다. */
export function lineHash(instance: string, prevHash: string, r: AuditRecord): string {
  return createHash('sha256')
    .update([
      'kma-audit-v2', instance, prevHash, r.id, r.at, r.electionId ?? '-', r.action,
      r.actorType, r.actorRef ?? '-', JSON.stringify(r.detail ?? {}), r.ipPrefix ?? '-',
    ].join('\n'))
    .digest('hex');
}

/**
 * 내보낸 파일의 사슬을 검증한다. 스크립트에서도 쓴다.
 * 반환: 줄 수, 마지막 해시, 발견한 문제.
 */
export function verifyExportedChain(text: string): {
  ok: boolean; lines: number; head: string; problems: string[];
} {
  const problems: string[] = [];
  const rows = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let prev = GENESIS;
  let n = 0;

  for (const [i, raw] of rows.entries()) {
    let line: ExportedLine;
    try {
      line = JSON.parse(raw);
    } catch {
      problems.push(`${i + 1}번째 줄을 읽을 수 없습니다 (JSON 아님).`);
      continue;
    }
    n++;
    if (line.seq !== n) problems.push(`${n}번 줄의 순번이 ${line.seq} 입니다 — 줄이 빠졌거나 순서가 바뀌었습니다.`);
    if (line.prevHash !== prev) problems.push(`${n}번 줄의 이전 해시가 어긋납니다 — 앞줄이 바뀌었거나 지워졌습니다.`);
    if (lineHash(line.instance, line.prevHash, line) !== line.hash) {
      problems.push(`${n}번 줄의 내용이 기록된 해시와 다릅니다 — 그 줄이 수정되었습니다.`);
    }
    prev = line.hash;
  }

  return { ok: problems.length === 0, lines: n, head: prev, problems };
}

export interface AuditSink {
  readonly name: string;
  write(line: ExportedLine): Promise<void>;
}

/**
 * 파일 반출. 한 줄에 하나씩(JSONL).
 *
 * **파일은 프로세스마다 따로 쓴다.** 여러 인스턴스가 한 파일에 append 하면
 * 서로의 사슬이 끼어들어 전부 깨진다 — 각자 자기 prevHash 를 물고 쓰기 때문이다.
 * 확장할 때(인스턴스를 늘릴 때) 조용히 터지는 종류의 버그라, 처음부터 갈라둔다.
 * 검증은 파일별로 하고, 모아서 볼 때만 합친다.
 *
 * 이 파일들 자체는 반드시 외부 저장소로 복제해야 한다 — 여기 있는 채로는 고칠 수 있다.
 */
@Injectable()
export class FileAuditSink implements AuditSink {
  readonly name = 'FILE';
  private readonly logger = new Logger(FileAuditSink.name);
  readonly dir: string;
  private resolvedPath: string | null = null;

  constructor(config: ConfigService) {
    this.dir = config.get<string>('AUDIT_EXPORT_DIR') || join(process.cwd(), 'audit-export');
  }

  /** 인스턴스별 파일 경로 */
  pathFor(instance: string): string {
    if (!this.resolvedPath) {
      mkdirSync(this.dir, { recursive: true });
      this.resolvedPath = join(this.dir, `audit-${instance}.jsonl`);
    }
    return this.resolvedPath;
  }

  async write(line: ExportedLine) {
    await appendFile(this.pathFor(line.instance), JSON.stringify(line) + '\n', 'utf8');
  }
}

/** 외부 수집기 전송. 같은 서버 밖으로 나가야 진짜 반출이다. */
@Injectable()
export class HttpAuditSink implements AuditSink {
  readonly name = 'HTTP';
  private readonly logger = new Logger(HttpAuditSink.name);

  constructor(private readonly config: ConfigService) {}

  async write(line: ExportedLine) {
    const url = this.config.get<string>('AUDIT_EXPORT_URL');
    if (!url) throw new Error('AUDIT_EXPORT_URL 이 비어 있습니다.');
    const token = this.config.get<string>('AUDIT_EXPORT_TOKEN');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(line),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`수집기 응답 ${res.status}`);
  }
}

/**
 * 사슬을 유지하며 모든 sink 에 내보낸다.
 *
 * 쓰기는 **반드시 한 줄씩 순서대로** 일어나야 한다. 동시에 쓰면 같은 prevHash 를
 * 두 줄이 물어 사슬이 갈라진다. 그래서 프라미스 체인으로 직렬화한다.
 * 투표 경로(546표/초)는 이 큐를 기다리지 않는다 — 넣기만 하고 지나간다.
 */
@Injectable()
export class AuditExportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditExportService.name);
  private readonly sinks: AuditSink[] = [];
  private queue: Promise<void> = Promise.resolve();
  private prevHash = GENESIS;
  private seq = 0;
  private failures = 0;

  /**
   * 이 프로세스의 식별자. 사슬은 인스턴스별로 이어진다.
   * 운영에서 인스턴스를 고정 이름으로 두고 싶으면 AUDIT_INSTANCE_ID 를 준다 —
   * 재시작해도 같은 파일에 이어 써서 사슬이 끊기지 않는다.
   */
  readonly instance: string =
    process.env.AUDIT_INSTANCE_ID || `${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly config: ConfigService,
    private readonly file: FileAuditSink,
    private readonly http: HttpAuditSink,
  ) {}

  async onModuleInit() {
    const names = (this.config.get<string>('AUDIT_SINKS') ?? '')
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

    for (const n of names) {
      const sink = [this.file, this.http].find((x) => x.name === n);
      if (sink) this.sinks.push(sink);
      else this.logger.error(`알 수 없는 감사 로그 반출 대상: ${n}`);
    }

    if (this.sinks.length === 0) {
      // 조용히 넘기지 않는다. 반출이 없다는 건 로그를 지울 수 있다는 뜻이다.
      this.logger.warn(
        '감사 로그 외부 반출이 꺼져 있습니다 (AUDIT_SINKS 비어 있음). ' +
          'DB 를 쥔 사람이 로그를 지워도 알 수 없습니다.',
      );
      return;
    }

    // 이어서 쓰려면 마지막 줄의 해시를 알아야 한다. (같은 인스턴스 id 로 재시작한 경우)
    if (this.sinks.includes(this.file)) {
      const path = this.file.pathFor(this.instance);
      if (existsSync(path)) {
        const state = verifyExportedChain(await readFile(path, 'utf8'));
        this.seq = state.lines;
        this.prevHash = state.head;
        if (!state.ok) {
          this.logger.error(
            `기존 감사 로그 반출 파일의 사슬이 깨져 있습니다 (${state.problems.length}건). ` +
              `이어서 쓰지만 반드시 조사하세요: ${path}`,
          );
        }
        this.logger.log(`감사 로그 반출 이어쓰기: ${state.lines}줄 (${path})`);
      }
    }
    this.logger.log(
      `감사 로그 반출 대상: ${this.sinks.map((s) => s.name).join(', ')} · 인스턴스 ${this.instance}`,
    );
  }

  /** 큐에 넣고 즉시 반환한다. 반출 실패가 투표를 막아서는 안 된다. */
  enqueue(record: AuditRecord) {
    if (this.sinks.length === 0) return;

    this.queue = this.queue.then(async () => {
      const seq = this.seq + 1;
      const prevHash = this.prevHash;
      const line: ExportedLine = {
        ...record, instance: this.instance, seq, prevHash,
        hash: lineHash(this.instance, prevHash, record),
      };

      let anyOk = false;
      for (const sink of this.sinks) {
        try {
          await sink.write(line);
          anyOk = true;
        } catch (e) {
          this.failures++;
          this.logger.error(`감사 로그 반출 실패 (${sink.name}, 누적 ${this.failures}건): ${(e as Error).message}`);
        }
      }
      // 한 곳이라도 나갔을 때만 사슬을 전진시킨다. 전부 실패했는데 번호를 올리면
      // 나중에 성공한 줄들이 존재하지 않는 앞줄을 가리키게 된다.
      if (anyOk) {
        this.seq = seq;
        this.prevHash = line.hash;
      }
    }).catch((e) => {
      this.logger.error(`감사 로그 반출 큐 오류: ${(e as Error).message}`);
    });
  }

  /**
   * 종료 시 큐를 비운다.
   *
   * 반출은 비동기라 종료 순간 아직 안 나간 줄이 남을 수 있고, 그만큼 검증 사각이 된다.
   * 정상 종료(SIGTERM)에서는 여기서 다 비운다 — main.ts 의 enableShutdownHooks 가
   * 이걸 불러준다. **강제 종료(SIGKILL)에서는 막을 방법이 없다.**
   */
  async onModuleDestroy() {
    if (this.sinks.length === 0) return;
    const before = this.seq;
    await this.flush();
    if (this.seq > before) {
      this.logger.log(`종료 전 감사 로그 ${this.seq - before}줄 반출 완료`);
    }
  }

  /** 큐가 빌 때까지 기다린다 */
  async flush(): Promise<void> {
    await this.queue;
  }

  status() {
    return {
      sinks: this.sinks.map((s) => s.name),
      exported: this.seq,
      head: this.prevHash,
      failures: this.failures,
      instance: this.instance,
      path: this.sinks.includes(this.file) ? this.file.pathFor(this.instance) : null,
      dir: this.sinks.includes(this.file) ? this.file.dir : null,
    };
  }
}
