/**
 * 실제 체인(테스트넷) 리허설.
 *
 *   npm run chain:testnet --workspace=apps/api -- --new       지갑 새로 만들기
 *   npm run chain:testnet --workspace=apps/api                드라이런 (서명까지, 전송 안 함)
 *   npm run chain:testnet --workspace=apps/api -- --send      실제 전송  ⚠ 되돌릴 수 없음
 *
 * ── 왜 따로 두나 ──
 * chain:check 는 가짜 노드로 **우리 코드**를 검증한다. 그것으로 확인되지 않는 것이 남는다:
 * 노드가 실제로 우리 트랜잭션을 받아주는지, 수수료가 얼마나 드는지, 확정에 얼마나 걸리는지.
 * 그건 진짜 체인에서 한 번 해봐야 안다.
 *
 * ── 전송은 되돌릴 수 없다 ──
 * 퍼블릭 체인에 올린 것은 지울 수 없다. 그래서 기본은 드라이런이고,
 * --send 를 명시해야만 실제로 나간다. 올라가는 것은 체크포인트 해시뿐이지만,
 * **표나 명부는 어떤 경우에도 올리지 않는다** — 올리면 영구히 되돌릴 수 없다.
 */
import 'dotenv/config';
import { JsonRpcProvider, Wallet, formatEther, hexlify, toUtf8Bytes, toUtf8String } from 'ethers';
import { chainPayload, parseChainPayload } from '../src/integrity/anchor';
import { ownerPrisma } from './owner-db';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);

/** 기본은 Sepolia. 다른 체인/Besu 는 --rpc 로 지정한다. */
const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const RPC = arg('rpc') ?? process.env.ANCHOR_CHAIN_RPC ?? DEFAULT_RPC;

const c = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  no: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const KNOWN: Record<string, { name: string; explorer: string; faucet: string }> = {
  '11155111': {
    name: 'Sepolia 테스트넷',
    explorer: 'https://sepolia.etherscan.io/tx/',
    faucet: 'https://sepoliafaucet.com  ·  https://www.alchemy.com/faucets/ethereum-sepolia',
  },
  '17000': {
    name: 'Holesky 테스트넷',
    explorer: 'https://holesky.etherscan.io/tx/',
    faucet: 'https://holesky-faucet.pk910.de',
  },
  '1': { name: '\x1b[31mEthereum 메인넷\x1b[0m', explorer: 'https://etherscan.io/tx/', faucet: '—' },
};

async function main() {
  // ── 지갑 새로 만들기 ──
  if (has('new')) {
    const w = Wallet.createRandom();
    console.log(`\n${c.b('고정용 지갑을 새로 만들었습니다')}\n`);
    console.log(`  주소      ${c.b(w.address)}`);
    console.log(`  개인키    ${w.privateKey}\n`);
    console.log(c.warn('  이 키는 여기서만 출력됩니다.'));
    console.log(c.dim('  .env 의 ANCHOR_CHAIN_PRIVATE_KEY 에 넣으세요.'));
    console.log(c.dim('  테스트넷 전용으로만 쓰고, 운영에서는 KMS/HSM 으로 옮기세요.\n'));
    console.log(`  다음: 이 주소로 테스트넷 코인을 받으세요 (faucet).\n`);
    return;
  }

  console.log(`\n${c.b('실제 체인 리허설')}`);
  console.log(`  노드  ${c.dim(RPC)}`);

  const provider = new JsonRpcProvider(RPC);
  try {
    const net = await provider.getNetwork();
    const id = net.chainId.toString();
    const known = KNOWN[id];
    console.log(`  체인  ${known ? known.name : '알 수 없는 체인'} ${c.dim(`(chainId ${id})`)}`);

    if (id === '1' && has('send')) {
      throw new Error('메인넷에 리허설을 보내지 마세요. 테스트넷을 쓰세요.');
    }

    const pk = process.env.ANCHOR_CHAIN_PRIVATE_KEY;
    if (!pk) {
      console.log(`\n${c.warn('ANCHOR_CHAIN_PRIVATE_KEY 가 비어 있습니다.')}`);
      console.log('  먼저 지갑을 만드세요:');
      console.log(c.dim('    npm run chain:testnet --workspace=apps/api -- --new\n'));
      process.exit(1);
    }

    const wallet = new Wallet(pk, provider);
    const balance = await provider.getBalance(wallet.address);
    console.log(`  지갑  ${wallet.address}`);
    console.log(`  잔액  ${formatEther(balance)} ETH`);

    // ── 무엇을 올릴 것인가 ──
    const prisma = ownerPrisma();
    let cp: { electionId: string; seq: number; hash: string; kind: string };
    const electionId = arg('election');
    const row = await prisma.checkpoint.findFirst({
      where: electionId ? { electionId } : {},
      orderBy: { createdAt: 'desc' },
    });
    if (row) {
      cp = { electionId: row.electionId, seq: row.seq, hash: row.hash, kind: row.kind };
      console.log(`\n  ${c.dim(`DB 의 최근 체크포인트를 씁니다: #${row.seq} ${row.kind}`)}`);
    } else {
      cp = {
        electionId: '00000000-0000-0000-0000-000000000000',
        seq: 1, hash: '0'.repeat(64), kind: 'REHEARSAL',
      };
      console.log(`\n  ${c.dim('체크포인트가 없어 예시 값을 씁니다.')}`);
    }
    await prisma.$disconnect();

    const payload = chainPayload(cp);
    console.log(`\n${c.b('체인에 실을 내용')}`);
    console.log(`  ${payload}`);
    console.log(`  ${c.dim(`${toUtf8Bytes(payload).length}바이트 · 해시뿐입니다. 표도 명부도 올라가지 않습니다.`)}`);

    // ── 비용 ──
    const req = {
      to: wallet.address,
      value: 0n,
      data: hexlify(toUtf8Bytes(payload)),
    };
    const gas = await provider.estimateGas({ ...req, from: wallet.address });
    const fee = await provider.getFeeData();
    const perTx = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);

    console.log(`\n${c.b('예상 비용')}`);
    console.log(`  가스        ${gas.toString()}`);
    console.log(`  건당        ${formatEther(perTx)} ETH`);
    console.log(`  선거 1회    ${formatEther(perTx * 4n)} ETH ${c.dim('(체크포인트 4건 기준)')}`);

    if (balance < perTx) {
      console.log(`\n${c.warn('잔액이 부족합니다.')}`);
      if (known?.faucet && known.faucet !== '—') {
        console.log(`  아래에서 이 주소로 받으세요:`);
        console.log(`    ${c.b(wallet.address)}`);
        console.log(`    ${known.faucet}\n`);
      }
    }

    // ── 서명까지만 (전송 안 함) ──
    if (!has('send')) {
      const populated = await wallet.populateTransaction(req);
      const signed = await wallet.signTransaction(populated);
      console.log(`\n${c.b('드라이런 — 서명까지 마쳤고 전송하지 않았습니다')}`);
      console.log(`  서명된 트랜잭션 ${signed.length / 2 - 1}바이트`);
      console.log(`  ${c.dim(signed.slice(0, 74) + '…')}`);
      console.log(`\n  실제로 보내려면 ${c.b('--send')} 를 붙이세요.`);
      console.log(c.dim('  퍼블릭 체인에 올린 것은 지울 수 없습니다.\n'));
      return;
    }

    // ── 실제 전송 ──
    if (balance === 0n) throw new Error('잔액이 0 입니다. faucet 에서 먼저 받으세요.');

    console.log(`\n${c.b('전송합니다')} ${c.dim('(되돌릴 수 없습니다)')}`);
    const tx = await wallet.sendTransaction(req);
    console.log(`  트랜잭션  ${tx.hash}`);
    if (known) console.log(`  탐색기    ${known.explorer}${tx.hash}`);
    console.log(`  ${c.dim('확정 대기 중…')}`);

    const started = Date.now();
    const receipt = await tx.wait(1, 300_000);
    const took = ((Date.now() - started) / 1000).toFixed(1);
    if (!receipt) throw new Error('확정되지 않았습니다.');
    if (receipt.status === 0) throw new Error('트랜잭션이 되돌려졌습니다.');

    console.log(`\n  ${c.ok('확정')} 블록 ${receipt.blockNumber} · ${took}초 소요`);
    console.log(`  실제 수수료 ${formatEther(receipt.gasUsed * receipt.gasPrice)} ETH`);

    // ── 되읽어 대조 ──
    const back = await provider.getTransaction(tx.hash);
    const text = back ? toUtf8String(back.data) : '';
    const parsed = parseChainPayload(text);
    const same = parsed?.hash === cp.hash && parsed?.seq === cp.seq;
    console.log(`\n${c.b('되읽어 대조')}`);
    console.log(`  체인의 값  ${text.slice(0, 60)}…`);
    console.log(`  ${same ? c.ok('✓ 우리 체크포인트와 일치합니다') : c.no('✗ 값이 다릅니다')}`);
    console.log('');
  } finally {
    provider.destroy();
  }
}

main().catch((e) => {
  console.error(`\n\x1b[31m${(e as Error).message}\x1b[0m\n`);
  process.exit(1);
});
