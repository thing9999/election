/**
 * 체인에 남긴 고정을 실제로 읽어와 대조한다.
 *
 *   npm run anchor:verify --workspace=apps/api -- --election <선거 id>
 *   npm run anchor:verify --workspace=apps/api -- --election <선거 id> --rpc https://...
 *
 * ── 왜 필요한가 ──
 * "보냈다"는 증거가 아니다. **체인에 올라가 있고 그 내용이 우리 체크포인트와 같다**가 증거다.
 * 선거 후 참관인·후보 캠프가 이 명령으로 직접 확인할 수 있어야 고정이 의미를 갖는다.
 *
 * DB 에서 체크포인트와 고정 기록을 읽고, 체인에서 트랜잭션을 가져와 셋을 맞춰본다.
 * 우리 서버의 값을 믿지 않고 **체인에 실제로 실린 글자**를 기준으로 판단한다.
 */
import 'dotenv/config';
import { JsonRpcProvider, toUtf8String } from 'ethers';
import { parseChainPayload } from '../src/integrity/anchor';
import { ownerPrisma } from './owner-db';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const prisma = ownerPrisma();
let pass = 0, fail = 0;
const ok = (l: string, d = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}${d ? ` \x1b[2m(${d})\x1b[0m` : ''}`); };
const no = (l: string, d: string) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l} \x1b[31m${d}\x1b[0m`); };

async function main() {
  const electionId = arg('election');
  if (!electionId) {
    console.error('\n사용법: npm run anchor:verify --workspace=apps/api -- --election <선거 id>\n');
    process.exit(1);
  }
  const rpc = arg('rpc') ?? process.env.ANCHOR_CHAIN_RPC;
  if (!rpc) {
    console.error('\nRPC 주소가 없습니다. --rpc 로 주거나 ANCHOR_CHAIN_RPC 를 설정하세요.\n');
    process.exit(1);
  }

  const election = await prisma.election.findUnique({
    where: { id: electionId }, select: { title: true, status: true },
  });
  if (!election) {
    console.error(`\n선거를 찾을 수 없습니다: ${electionId}\n`);
    process.exit(1);
  }

  console.log(`\n\x1b[1m블록체인 고정 대조\x1b[0m`);
  console.log(`  선거: ${election.title} (${election.status})`);
  console.log(`  노드: \x1b[2m${rpc}\x1b[0m\n`);

  const checkpoints = await prisma.checkpoint.findMany({
    where: { electionId },
    orderBy: { seq: 'asc' },
    include: { anchors: true },
  });

  if (checkpoints.length === 0) {
    console.error('체크포인트가 하나도 없습니다.\n');
    process.exit(1);
  }

  const provider = new JsonRpcProvider(rpc);
  try {
    const net = await provider.getNetwork();
    console.log(`  체인 id: ${net.chainId}\n`);

    let anchored = 0;
    for (const cp of checkpoints) {
      const chainAnchors = cp.anchors.filter((a) => a.target === 'BLOCKCHAIN');
      const label = `#${cp.seq} ${cp.kind}`;

      if (chainAnchors.length === 0) {
        console.log(`  \x1b[33m-\x1b[0m ${label} \x1b[2m(체인에 고정되지 않음)\x1b[0m`);
        continue;
      }
      anchored++;

      for (const a of chainAnchors) {
        const tx = await provider.getTransaction(a.reference);
        if (!tx) {
          no(`${label} — 체인에서 트랜잭션을 찾을 수 없음`, a.reference);
          continue;
        }

        // 체인에 실제로 실린 글자를 기준으로 본다. DB 의 detail 은 믿지 않는다.
        let text: string;
        try {
          text = toUtf8String(tx.data);
        } catch {
          no(`${label} — 트랜잭션 내용을 읽을 수 없음`, a.reference);
          continue;
        }

        const parsed = parseChainPayload(text);
        if (!parsed) {
          no(`${label} — 내용 형식이 올바르지 않음`, text.slice(0, 40));
          continue;
        }
        if (parsed.electionId !== electionId) {
          no(`${label} — 다른 선거의 고정입니다`, parsed.electionId);
          continue;
        }
        if (parsed.seq !== cp.seq) {
          no(`${label} — 순번이 다릅니다`, `체인 #${parsed.seq}`);
          continue;
        }
        if (parsed.hash !== cp.hash) {
          no(`${label} — \x1b[1m해시가 다릅니다\x1b[0m\x1b[31m — 고정 이후 무언가 바뀌었습니다`,
            `체인 ${parsed.hash.slice(0, 16)}… / DB ${cp.hash.slice(0, 16)}…`);
          continue;
        }

        const conf = await tx.confirmations();
        ok(`${label} — 체인의 값과 일치`,
          `블록 ${tx.blockNumber} · 확정 ${conf}블록 · ${a.reference.slice(0, 18)}…`);
      }
    }

    console.log('');
    if (anchored === 0) {
      console.log('\x1b[33m체인에 고정된 체크포인트가 하나도 없습니다.\x1b[0m');
      console.log('\x1b[2mANCHOR_TARGETS 에 BLOCKCHAIN 이 들어 있었는지 확인하세요.\x1b[0m\n');
      process.exit(1);
    }

    console.log(`\x1b[1m${pass} 일치${fail ? `, \x1b[31m${fail} 불일치` : ''}\x1b[0m`);
    if (fail === 0) {
      console.log('\x1b[2m체인에 남은 값과 지금 DB 의 체크포인트가 같습니다.\x1b[0m');
      console.log('\x1b[2m다만 이것은 "고정 이후 안 바뀌었다"까지입니다 — 고정 이전 단계는 별도로 확인해야 합니다.\x1b[0m\n');
    } else {
      console.log('\x1b[31m체인에 남은 값과 지금 DB 가 다릅니다. 반드시 원인을 조사하세요.\x1b[0m\n');
    }
  } finally {
    provider.destroy();
    await prisma.$disconnect();
  }

  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
