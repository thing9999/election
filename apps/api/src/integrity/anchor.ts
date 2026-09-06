import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JsonRpcProvider, Wallet, hexlify, toUtf8Bytes } from 'ethers';
import { ConfigService } from '@nestjs/config';
import { SmsService } from '../auth/sms.service';
import { appendFileSync } from 'fs';
import { join } from 'path';

/**
 * 체크포인트 해시를 외부에 고정한다.
 *
 * ── 왜 필요한가 ──
 * 해시 사슬만으로는 부족하다. DB 를 통째로 쥔 공격자는 표를 고친 다음
 * 체크포인트도 처음부터 다시 계산해 끼워넣으면 그만이다. 사슬은 "내부적으로
 * 앞뒤가 맞는가"만 보장한다.
 *
 * 그래서 사슬의 머리를 **협회가 나중에 바꿀 수 없는 곳**에 남긴다.
 * 그 시점 이후로는 "우리가 안 고쳤다"가 아니라 "고쳤다면 대조에서 드러난다"가 된다.
 *
 * ── 대상별 성격 ──
 * OBSERVERS  참관인·후보 캠프에 발송. 무료, 즉시, **사람이 증인**이 된다.
 *            기술적으로 가장 약해 보이지만 실제 분쟁에서 가장 강하다 —
 *            이해관계가 다른 여러 사람이 같은 값을 들고 있기 때문이다.
 * FILE       외부 저장소(S3 Object Lock 등). 같은 DB 밖에 두는 것이 핵심.
 * TSA        RFC 3161 공인 타임스탬프. 법적 효력이 있고 저렴하다.
 * BLOCKCHAIN 퍼블릭 체인에 해시 기록. 특정 기관을 믿지 않아도 되고 영구 검증 가능.
 *            **표를 올리는 게 아니라 해시만 올린다** — 몇 건이라 비용도 적다.
 *
 * 한 곳만 고르지 말고 성격이 다른 둘 이상을 쓰는 게 맞다.
 */

export interface AnchorResult {
  target: string;
  /** 나중에 대조할 수 있는 값 (트랜잭션 해시, 파일 경로, 발송 기록 id 등) */
  reference: string;
  detail?: Record<string, unknown>;
}

export interface AnchorProvider {
  readonly target: string;
  anchor(input: { electionId: string; seq: number; hash: string; kind: string }): Promise<AnchorResult>;
}

/**
 * 파일 추가 기록. 로컬 개발과, 외부 저장소로 실어 나르기 전 단계용.
 *
 * 이 파일이 서버 안에 있는 한 공격자도 고칠 수 있으므로, 그 자체로는 고정이 아니다.
 * 반드시 append-only 외부 저장소(S3 Object Lock 등)로 복제해야 의미가 생긴다.
 */
@Injectable()
export class FileAnchorProvider implements AnchorProvider {
  readonly target = 'FILE';
  private readonly logger = new Logger(FileAnchorProvider.name);

  async anchor(input: { electionId: string; seq: number; hash: string; kind: string }) {
    const path = join(process.cwd(), 'checkpoints.log');
    const line = JSON.stringify({ ...input, at: new Date().toISOString() });
    appendFileSync(path, line + '\n', 'utf8');
    this.logger.log(`체크포인트 #${input.seq} 기록: ${path}`);
    return { target: this.target, reference: path, detail: { line } };
  }
}

/**
 * 참관인 발송.
 *
 * 기술적으로는 문자 한 통이지만, **실제 분쟁에서 가장 강한 고정이다.**
 * 이해관계가 다른 여러 사람이 같은 해시를 각자 손전화에 들고 있으면,
 * 협회가 서버를 통째로 뜯어고쳐도 맞춰보는 순간 드러난다.
 * 협회 권한이 그 5대의 전화기에는 닿지 않기 때문이다.
 *
 * 지켜야 할 것:
 *   · 선거 **시작 전에** 수신자 명단을 확정하고 공개할 것.
 *     사후에 명단을 고를 수 있으면 유리한 사람에게만 보낼 수 있다.
 *   · 해시 **전문**을 그대로 보낼 것. 앞자리만 보내면 대조가 안 된다.
 *   · 발송 실패를 조용히 넘기지 말 것. 받은 사람이 없으면 고정이 아니다.
 */
@Injectable()
export class ObserverAnchorProvider implements AnchorProvider {
  readonly target = 'OBSERVERS';
  private readonly logger = new Logger(ObserverAnchorProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sms: SmsService,
  ) {}

  async anchor(input: { electionId: string; seq: number; hash: string; kind: string }) {
    const raw = this.config.get<string>('ANCHOR_OBSERVERS', '');
    const recipients = raw.split(',').map((s) => s.trim()).filter(Boolean);

    if (recipients.length === 0) {
      throw new Error(
        'ANCHOR_OBSERVERS 가 비어 있습니다. 참관인·후보 캠프 연락처를 ' +
          '선거 시작 전에 확정해서 넣으세요.',
      );
    }

    const text =
      `[협회장선거] 무결성 체크포인트 #${input.seq} (${input.kind})\n` +
      `${input.hash}\n` +
      '이 값을 보관하셨다가 선거 후 공개된 값과 대조해 주세요.';

    const sent: string[] = [];
    const failed: { to: string; error: string }[] = [];
    for (const to of recipients) {
      try {
        await this.sms.sendObserverAnchor(to, text);
        sent.push(to);
      } catch (e) {
        failed.push({ to, error: (e as Error).message });
      }
    }

    if (sent.length === 0) {
      throw new Error(`참관인 ${recipients.length}명 전원에게 발송 실패했습니다.`);
    }
    if (failed.length > 0) {
      // 일부라도 갔으면 고정은 성립하지만, 못 받은 사람은 검증에 참여할 수 없다.
      this.logger.error(
        `참관인 ${failed.length}명에게 발송 실패 (성공 ${sent.length}명). ` +
          '못 받은 분께 별도 경로로 전달하세요.',
      );
    }

    return {
      target: this.target,
      reference: `observers:${sent.length}/${recipients.length}`,
      detail: { sent: sent.length, failed: failed.length, total: recipients.length },
    };
  }
}

/**
 * 체인에 실을 내용. 블록 탐색기에서 사람이 눈으로 읽을 수 있어야 한다 —
 * 참관인이 대조하는 것이 이 고정의 존재 이유이기 때문이다.
 *
 *   KMA1|<선거 id>|<체크포인트 순번>|<체크포인트 해시>
 *
 * 약 110바이트. 선거당 3~5건이므로 수수료는 실질적으로 문제가 되지 않는다.
 */
export const CHAIN_PAYLOAD_PREFIX = 'KMA1';

export function chainPayload(input: { electionId: string; seq: number; hash: string }): string {
  return [CHAIN_PAYLOAD_PREFIX, input.electionId, input.seq, input.hash].join('|');
}

export function parseChainPayload(text: string):
  | { electionId: string; seq: number; hash: string }
  | null {
  const parts = text.split('|');
  if (parts.length !== 4 || parts[0] !== CHAIN_PAYLOAD_PREFIX) return null;
  const seq = Number(parts[2]);
  if (!Number.isInteger(seq) || seq < 1) return null;
  if (!/^[0-9a-f]{64}$/.test(parts[3])) return null;
  return { electionId: parts[1], seq, hash: parts[3] };
}

/** 개발 도구가 흔히 쓰는 시드 지갑. 운영에서 이 키가 보이면 즉시 멈춘다. */
const WELL_KNOWN_DEV_KEYS = new Set([
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // Hardhat/Anvil #0
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // #1
  '0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63', // Besu dev 계정
]);

/**
 * 퍼블릭/컨소시엄 블록체인 고정.
 *
 * ── 무엇을 올리나 ──
 * **해시뿐이다.** 표도 명부도 올라가지 않는다. 표를 체인에 올리면 되돌릴 수 없는 실수가 된다 —
 * 블록 타임스탬프가 초 단위로 영구 기록되어, 우리가 castAtHour 로 일부러 지운 시각 정보를
 * 체인이 되살려 준다. 게다가 개표키가 언젠가 유출되면 그때 전 국민이 개별 표를 열어볼 수 있고,
 * 우리 DB 와 달리 지울 방법이 없다.
 *
 * ── 스마트 컨트랙트를 쓰지 않는 이유 ──
 * 트랜잭션의 data 필드에 해시를 싣는 것으로 충분하다. 컨트랙트를 두면 그 코드가
 * 새로운 공격 표면이 되고, 참관인이 검증할 대상도 하나 더 늘어난다.
 * 여기서는 자기 주소로 0원을 보내면서 data 만 싣는다.
 *
 * ── 지갑 개인키 ──
 * 이 키가 털리면 **가짜 고정을 만들 수 있다.** 개표키와 같은 등급으로 취급해야 한다.
 * 다만 개표키와 달리 투표 기간 내내 온라인이어야 하므로(단계 전환마다 서명),
 * 가능하면 KMS/HSM 에 두고 서명만 위임하라. loadPrivateKey() 가 그 자리다.
 *
 * ── 프라이빗 체인을 쓸 때 ──
 * 협회가 검증자를 전부 운영하면 **보장이 0이다.** 원장을 다시 쓸 수 있으므로
 * 우리 DB 에 체크포인트를 다시 만드는 것과 다르지 않다. 의미가 생기려면 검증자를
 * 이해관계가 다른 곳들이 나눠 운영해야 한다 — 그건 사실상 "참관인이 노드를 돌리는 것"이다.
 * ANCHOR_CHAIN_TRUST_NOTE 에 그 구성을 적어두면 고정 기록에 함께 남는다.
 */
@Injectable()
export class BlockchainAnchorProvider implements AnchorProvider, OnModuleInit {
  readonly target = 'BLOCKCHAIN';
  private readonly logger = new Logger(BlockchainAnchorProvider.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    if (!this.enabled) return;
    const key = this.config.get<string>('ANCHOR_CHAIN_PRIVATE_KEY') ?? '';
    if (
      process.env.NODE_ENV === 'production' &&
      WELL_KNOWN_DEV_KEYS.has(key.toLowerCase())
    ) {
      throw new Error(
        '개발용으로 공개된 지갑 키가 설정되어 있습니다. 운영에서는 기동할 수 없습니다.',
      );
    }
  }

  /** ANCHOR_TARGETS 에 BLOCKCHAIN 이 들어 있는가 */
  private get enabled(): boolean {
    return (this.config.get<string>('ANCHOR_TARGETS') ?? '')
      .split(',').map((x) => x.trim().toUpperCase()).includes('BLOCKCHAIN');
  }

  /**
   * 개인키를 가져온다. **여기가 KMS/HSM 을 붙이는 자리다.**
   * 지금은 환경변수에서 읽는다 — 운영에서는 시크릿 매니저나 KMS 서명으로 바꾸고,
   * 프로세스 메모리에 원문이 오래 머물지 않게 하라.
   */
  protected async loadPrivateKey(): Promise<string> {
    const key = this.config.get<string>('ANCHOR_CHAIN_PRIVATE_KEY');
    if (!key) {
      throw new Error(
        'ANCHOR_CHAIN_PRIVATE_KEY 가 비어 있습니다. 고정용 지갑을 만들고 잔액을 채운 뒤 넣으세요.',
      );
    }
    return key;
  }

  async anchor(input: {
    electionId: string; seq: number; hash: string; kind: string;
  }): Promise<AnchorResult> {
    const rpc = this.config.get<string>('ANCHOR_CHAIN_RPC');
    if (!rpc) {
      throw new Error('ANCHOR_CHAIN_RPC 가 비어 있습니다. 노드의 JSON-RPC 주소를 넣으세요.');
    }

    const expectedChainId = this.config.get<string>('ANCHOR_CHAIN_ID');
    const confirmations = Number(this.config.get<string>('ANCHOR_CHAIN_CONFIRMATIONS') ?? 2);
    const timeoutMs = Number(this.config.get<string>('ANCHOR_CHAIN_TIMEOUT_MS') ?? 180_000);

    const provider = new JsonRpcProvider(rpc);
    try {
      const net = await provider.getNetwork();

      // 엉뚱한 체인에 고정하면 나중에 아무도 못 찾는다. 설정한 체인이 맞는지 먼저 본다.
      if (expectedChainId && net.chainId.toString() !== String(expectedChainId).trim()) {
        throw new Error(
          `연결된 체인이 다릅니다: 기대 ${expectedChainId}, 실제 ${net.chainId}. ` +
            'ANCHOR_CHAIN_RPC 를 확인하세요.',
        );
      }

      const wallet = new Wallet(await this.loadPrivateKey(), provider);

      // 잔액이 없으면 마감 순간에 실패한다. 미리 알려주는 편이 낫다.
      const balance = await provider.getBalance(wallet.address);
      if (balance === 0n) {
        throw new Error(
          `고정용 지갑 ${wallet.address} 의 잔액이 0 입니다. 수수료를 미리 채워두세요.`,
        );
      }

      const payload = chainPayload(input);
      const tx = await wallet.sendTransaction({
        to: wallet.address,          // 자기 자신에게. 값을 옮기는 것이 목적이 아니다
        value: 0n,
        data: hexlify(toUtf8Bytes(payload)),
      });

      this.logger.log(`체크포인트 #${input.seq} 고정 전송: ${tx.hash} (확정 대기 ${confirmations}블록)`);
      const receipt = await tx.wait(confirmations, timeoutMs);
      if (!receipt) throw new Error(`트랜잭션이 ${timeoutMs}ms 안에 확정되지 않았습니다: ${tx.hash}`);
      if (receipt.status === 0) throw new Error(`트랜잭션이 실패했습니다: ${tx.hash}`);

      return {
        target: this.target,
        reference: tx.hash,
        detail: {
          chainId: net.chainId.toString(),
          blockNumber: receipt.blockNumber,
          from: wallet.address,
          payload,
          confirmations,
          // 검증자 구성을 함께 남긴다. 프라이빗 체인이면 이 값이 곧 신뢰의 근거다.
          trust: this.config.get<string>('ANCHOR_CHAIN_TRUST_NOTE') ?? null,
          explorer: this.explorerUrl(tx.hash),
        },
      };
    } finally {
      provider.destroy();
    }
  }

  /** 참관인이 눌러볼 수 있는 주소. 프라이빗 체인이면 자체 탐색기 주소를 넣는다. */
  private explorerUrl(txHash: string): string | null {
    const base = this.config.get<string>('ANCHOR_CHAIN_EXPLORER');
    return base ? `${base.replace(/\/$/, '')}/${txHash}` : null;
  }
}
