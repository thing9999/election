/**
 * 블록체인 고정 검증.
 *
 *   npm run chain:check --workspace=apps/api
 *
 * 진짜 체인 없이 돈다. 확인하는 것은 **우리가 만들어 보내는 트랜잭션**이지
 * 체인의 동작이 아니다 — 가짜 노드가 받은 서명 트랜잭션을 실제로 해독해 내용을 검사한다.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { JsonRpcProvider, Wallet, toUtf8String } from 'ethers';
import {
  BlockchainAnchorProvider, chainPayload, parseChainPayload,
} from '../src/integrity/anchor';
import { startFakeChain } from './fake-chain';

let pass = 0, fail = 0;
const ok = (l: string, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}${d ? ` \x1b[2m(${d})\x1b[0m` : ''}`); };
const no = (l: string, d: string) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l} \x1b[31m${d}\x1b[0m`); };
const check = (l: string, c: boolean, d = '') => (c ? ok(l, d) : no(l, d || '실패'));

async function rejects(l: string, fn: () => Promise<unknown>, expect: RegExp) {
  try {
    await fn();
    no(l, '거부되지 않음');
  } catch (e) {
    const m = (e as Error).message;
    expect.test(m) ? ok(l, m.slice(0, 56)) : no(l, `다른 이유: ${m.slice(0, 70)}`);
  }
}

/** 설정값을 주입한 provider */
function providerWith(values: Record<string, string>) {
  const cfg = { get: (k: string, d?: string) => values[k] ?? d } as unknown as ConfigService;
  return new BlockchainAnchorProvider(cfg);
}

const CP = {
  electionId: '3f2a9c14-77b1-4a3e-9d55-6c0e1b8a4d02',
  seq: 3,
  hash: 'a'.repeat(64),
  kind: 'FINAL',
};

async function main() {
  console.log('\n\x1b[1m블록체인 고정 검증\x1b[0m');

  // ── 1. 체인에 실을 내용 ──
  console.log('\n\x1b[1m1. 체인에 실을 내용\x1b[0m');
  const payload = chainPayload(CP);
  check('사람이 읽을 수 있는 형식', payload.startsWith('KMA1|'), payload.slice(0, 46) + '…');
  check('길이가 짧음 (수수료 무시 가능)', payload.length < 160, `${payload.length}바이트`);
  check('되읽기 가능', JSON.stringify(parseChainPayload(payload)) ===
    JSON.stringify({ electionId: CP.electionId, seq: CP.seq, hash: CP.hash }));
  check('표나 명부가 들어가지 않음',
    !/sealed|voter|ballot|phone/i.test(payload) && payload.split('|').length === 4);
  check('망가진 값은 거부', parseChainPayload('KMA1|x|0|zz') === null);
  check('다른 형식은 거부', parseChainPayload('hello world') === null);

  // ── 2. 실제로 보내본다 ──
  console.log('\n\x1b[1m2. 트랜잭션 전송\x1b[0m');
  const chain = await startFakeChain({ chainId: 1337 });
  const wallet = Wallet.createRandom();

  const base = {
    ANCHOR_TARGETS: 'BLOCKCHAIN',
    ANCHOR_CHAIN_RPC: chain.url,
    ANCHOR_CHAIN_ID: '1337',
    ANCHOR_CHAIN_PRIVATE_KEY: wallet.privateKey,
    ANCHOR_CHAIN_CONFIRMATIONS: '1',
    ANCHOR_CHAIN_EXPLORER: 'https://example.invalid/tx',
    ANCHOR_CHAIN_TRUST_NOTE: '검증자 5곳: 협회 1 · 후보캠프 3 · 외부감사 1',
  };

  const res = await providerWith(base).anchor(CP);
  check('고정 성공', res.target === 'BLOCKCHAIN' && res.reference.startsWith('0x'));
  check('트랜잭션 해시를 대조값으로 남김', /^0x[0-9a-f]{64}$/.test(res.reference));

  const sent = chain.mined.get(res.reference);
  check('가짜 노드가 트랜잭션을 받음', Boolean(sent));

  if (sent) {
    check('우리 지갑이 서명함', sent.from.toLowerCase() === wallet.address.toLowerCase());
    check('자기 자신에게 보냄 (값 이동 아님)', sent.to.toLowerCase() === wallet.address.toLowerCase());
    check('보낸 금액이 0', sent.value === 0n);
    check('체크포인트 해시가 그대로 실림', sent.text === payload);
    check('체인 위에서도 되읽힘',
      parseChainPayload(toUtf8String(sent.data))?.hash === CP.hash);
    check('스마트 컨트랙트를 만들지 않음', sent.to !== '' && sent.to !== null);
  }

  const d = res.detail as Record<string, unknown>;
  check('블록 번호 기록', typeof d.blockNumber === 'number');
  check('체인 id 기록', d.chainId === '1337');
  check('참관인이 눌러볼 주소 제공', String(d.explorer).endsWith(res.reference));
  check('검증자 구성을 함께 남김', String(d.trust).includes('후보캠프'));

  // ── 3. 나중에 읽어서 대조가 되는가 ──
  // "보냈다"는 증거가 아니다. 선거 후 참관인이 체인에서 읽어 대조할 수 있어야 한다.
  console.log('\n\x1b[1m3. 체인에서 되읽어 대조\x1b[0m');
  {
    const rp = new JsonRpcProvider(chain.url);
    try {
      const tx = await rp.getTransaction(res.reference);
      check('체인에서 트랜잭션을 찾음', Boolean(tx));
      if (tx) {
        const back = parseChainPayload(toUtf8String(tx.data));
        check('체인의 값이 우리 체크포인트와 일치',
          back?.hash === CP.hash && back?.seq === CP.seq && back?.electionId === CP.electionId);
        check('보낸 주소가 우리 지갑', tx.from.toLowerCase() === wallet.address.toLowerCase());
        check('체인에 실린 금액이 0', tx.value === 0n);
      }
    } finally {
      rp.destroy();
    }
  }

  // ── 4. 막아야 하는 것 ──
  console.log('\n\x1b[1m4. 막아야 하는 것\x1b[0m');

  await rejects('다른 체인에 연결되면 거부 (엉뚱한 곳에 남기면 아무도 못 찾는다)',
    () => providerWith({ ...base, ANCHOR_CHAIN_ID: '1' }).anchor(CP),
    /연결된 체인이 다릅니다/);

  const broke = await startFakeChain({ chainId: 1337, balance: 0n });
  await rejects('잔액이 0이면 미리 거부 (마감 순간에 실패하면 늦다)',
    () => providerWith({ ...base, ANCHOR_CHAIN_RPC: broke.url }).anchor(CP),
    /잔액이 0/);
  await broke.close();

  await rejects('RPC 주소가 없으면 거부',
    () => providerWith({ ...base, ANCHOR_CHAIN_RPC: '' }).anchor(CP),
    /ANCHOR_CHAIN_RPC/);

  await rejects('지갑 키가 없으면 거부',
    () => providerWith({ ...base, ANCHOR_CHAIN_PRIVATE_KEY: '' }).anchor(CP),
    /ANCHOR_CHAIN_PRIVATE_KEY/);

  // 체인에서 되돌려진 트랜잭션을 "고정됐다"고 기록하면 안 된다.
  // ethers 가 먼저 revert 를 던지고, 우리 쪽 status 검사는 그 뒤를 받는 이중 방어다.
  chain.failNext = true;
  await rejects('되돌려진 트랜잭션을 성공으로 처리하지 않음',
    () => providerWith(base).anchor(CP), /실패했습니다|reverted/);
  chain.failNext = false;

  // 운영에서 개발용 공개 키를 쓰면 기동 자체를 거부한다
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const p = providerWith({
      ...base,
      ANCHOR_CHAIN_PRIVATE_KEY:
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    });
    try {
      p.onModuleInit();
      no('운영에서 개발용 공개 키를 거부', '거부되지 않음');
    } catch (e) {
      check('운영에서 개발용 공개 키를 거부', /개발용으로 공개된 지갑 키/.test((e as Error).message));
    }
    // 끄면 검사도 하지 않는다
    providerWith({ ...base, ANCHOR_TARGETS: 'FILE' }).onModuleInit();
    ok('BLOCKCHAIN 을 안 쓰면 검사도 하지 않음');
  } finally {
    process.env.NODE_ENV = prev;
  }

  await chain.close();
  console.log(`\n\x1b[1m${pass} 통과${fail ? `, \x1b[31m${fail} 실패` : ''}\x1b[0m`);
  console.log('\x1b[2m주의: 이것은 우리 쪽 코드 검증입니다. 실제 체인 연동은 테스트넷에서 한 번 더 확인하세요.\x1b[0m\n');
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
