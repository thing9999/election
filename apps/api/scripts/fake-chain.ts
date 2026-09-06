import { createServer, type Server } from 'http';
import { Transaction, keccak256, toUtf8String } from 'ethers';

/**
 * 검증용 가짜 JSON-RPC 노드.
 *
 * ── 무엇을 테스트하려는 것인가 ──
 * Besu 나 이더리움이 제대로 동작하는지는 우리가 테스트할 일이 아니다.
 * 확인해야 할 것은 **우리가 만들어 보내는 트랜잭션이 맞는가**이다 —
 * 올바른 지갑으로 서명했는지, 체크포인트 해시가 그대로 실렸는지,
 * 값을 옮기지 않는지(0원), 그리고 나중에 읽어서 대조가 되는지.
 *
 * 그래서 진짜 체인 대신 이 가짜 노드를 세우고, 받은 서명 트랜잭션을 **실제로 해독해서**
 * 내용을 검사한다. 체인 없이도 우리 쪽 실수는 전부 잡힌다.
 *
 * 운영에서는 절대 쓰지 않는다. 검증 스크립트에서만 부른다.
 */

export interface FakeChain {
  url: string;
  chainId: number;
  /** 채굴된 트랜잭션. 해시 → 해독한 내용 */
  mined: Map<string, {
    from: string; to: string; value: bigint; data: string; text: string;
    /** 서명. 실제 노드는 r/s/v 를 돌려주므로 여기서도 그대로 돌려준다 */
    sig: { r: string; s: string; v: number } | null;
    nonce: number; chainId: bigint; type: number;
  }>;
  /** 다음 트랜잭션을 실패시킨다 (실패 처리 검증용) */
  failNext: boolean;
  close(): Promise<void>;
}

const hex = (n: number | bigint) => '0x' + BigInt(n).toString(16);

export async function startFakeChain(opts: {
  chainId?: number;
  balance?: bigint;
} = {}): Promise<FakeChain> {
  const chainId = opts.chainId ?? 1337;
  let balance = opts.balance ?? 10n ** 18n;
  let blockNumber = 100;
  let nonce = 0;

  const mined: FakeChain['mined'] = new Map();
  const state = { failNext: false };

  const handle = (method: string, params: any[]): any => {
    switch (method) {
      case 'eth_chainId': return hex(chainId);
      case 'net_version': return String(chainId);
      case 'eth_blockNumber': return hex(blockNumber);
      case 'eth_getBalance': return hex(balance);
      case 'eth_getTransactionCount': return hex(nonce);
      case 'eth_gasPrice': return hex(1_000_000_000);
      case 'eth_maxPriorityFeePerGas': return hex(1_000_000_000);
      case 'eth_estimateGas': return hex(30_000);

      case 'eth_getBlockByNumber':
        return {
          number: hex(blockNumber), hash: '0x' + '11'.repeat(32),
          parentHash: '0x' + '22'.repeat(32), timestamp: hex(Math.floor(Date.now() / 1000)),
          gasLimit: hex(30_000_000), gasUsed: hex(21_000),
          baseFeePerGas: hex(1_000_000_000), miner: '0x' + '00'.repeat(20),
          extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000',
          transactions: [],
        };

      case 'eth_sendRawTransaction': {
        // 여기가 핵심 — 받은 서명 트랜잭션을 실제로 해독한다.
        const tx = Transaction.from(params[0]);
        const txHash = keccak256(params[0]);
        let text = '';
        try { text = toUtf8String(tx.data); } catch { text = ''; }
        mined.set(txHash, {
          from: tx.from ?? '', to: tx.to ?? '', value: tx.value, data: tx.data, text,
          sig: tx.signature
            ? { r: tx.signature.r, s: tx.signature.s, v: tx.signature.v }
            : null,
          nonce: tx.nonce, chainId: tx.chainId, type: tx.type ?? 2,
        });
        nonce++;
        blockNumber++;
        return txHash;
      }

      case 'eth_getTransactionReceipt': {
        const h = params[0];
        if (!mined.has(h)) return null;
        return {
          transactionHash: h, blockNumber: hex(blockNumber), blockHash: '0x' + '33'.repeat(32),
          transactionIndex: '0x0', from: mined.get(h)!.from, to: mined.get(h)!.to,
          cumulativeGasUsed: hex(21_000), gasUsed: hex(21_000), effectiveGasPrice: hex(1_000_000_000),
          contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256),
          status: state.failNext ? '0x0' : '0x1', type: '0x2',
        };
      }

      case 'eth_getTransactionByHash': {
        const h = params[0];
        const t = mined.get(h);
        if (!t) return null;
        // 실제 노드가 돌려주는 필드를 맞춘다. 서명(r/s/v)이 빠지면 ethers 가 거부한다.
        return {
          hash: h, blockNumber: hex(blockNumber), blockHash: '0x' + '33'.repeat(32),
          transactionIndex: '0x0', from: t.from, to: t.to, value: hex(t.value),
          data: t.data, input: t.data, nonce: hex(t.nonce), gas: hex(30_000),
          gasPrice: hex(1_000_000_000),
          maxFeePerGas: hex(2_000_000_000), maxPriorityFeePerGas: hex(1_000_000_000),
          chainId: hex(t.chainId), type: hex(t.type), accessList: [],
          r: t.sig?.r ?? '0x' + '11'.repeat(32),
          s: t.sig?.s ?? '0x' + '22'.repeat(32),
          v: hex(t.sig?.v ?? 27),
          yParity: hex((t.sig?.v ?? 27) - 27),
        };
      }

      default:
        throw new Error(`가짜 노드가 모르는 메서드입니다: ${method}`);
    }
  };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload: any;
      try { payload = JSON.parse(body); } catch { payload = null; }
      const one = (p: any) => {
        try {
          return { jsonrpc: '2.0', id: p.id, result: handle(p.method, p.params ?? []) };
        } catch (e) {
          return { jsonrpc: '2.0', id: p.id, error: { code: -32000, message: (e as Error).message } };
        }
      };
      const out = Array.isArray(payload) ? payload.map(one) : one(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    chainId,
    mined,
    get failNext() { return state.failNext; },
    set failNext(v: boolean) { state.failNext = v; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
