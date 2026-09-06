import { useEffect, useState } from 'react';
import { api, setVoteToken, type Election, type Candidate } from './lib/api';
import { sealBallot } from '../../../packages/ballot-seal/seal';

// 비워두면 서버가 진행 중인 선거를 알려준다. 특정 선거를 지정할 때만 채운다.
const ELECTION_ID = import.meta.env.VITE_ELECTION_ID ?? '';

type Step = 'identify' | 'idcheck' | 'otp' | 'ballot' | 'confirm' | 'done';

export default function App() {
  const [election, setElection] = useState<Election | null>(null);
  const [step, setStep] = useState<Step>('identify');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [phone, setPhone] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; token: string; phoneLast4: string } | null>(null);
  // 이름은 인증을 통과한 뒤에야 서버가 알려준다 (통과 전에 주면 명부가 새어나간다).
  const [voterName, setVoterName] = useState<string | null>(null);
  const [code, setCode] = useState('');
  // 이 선거가 어떤 인증 경로를 여는지. 서버가 정한다 — 화면이 임의로 고를 수 없다.
  const [methods, setMethods] = useState<{
    identity: 'off' | 'optional' | 'required'; otp: boolean;
  }>({ identity: 'off', otp: true });
  const [idTx, setIdTx] = useState<string | null>(null);
  const [idName, setIdName] = useState('');
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [abstain, setAbstain] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    api.getElection(ELECTION_ID || undefined).then(setElection).catch((e) => setError(e.message));
    // 실패해도 기본값(OTP)으로 계속 간다. 인증 경로를 못 읽었다고 투표를 막을 이유는 없다.
    api.getAuthMethods().then(setMethods).catch(() => {});
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !election) return <Shell><Alert>{error}</Alert></Shell>;
  if (!election) return <Shell><p style={s.muted}>불러오는 중…</p></Shell>;

  return (
    <Shell>
      <header style={s.header}>
        <h1 style={s.h1}>{election.title}</h1>
        {election.description && <p style={s.muted}>{election.description}</p>}
      </header>

      <Steps current={step} />
      {error && <Alert>{error}</Alert>}

      {/* ── 1단계: 본인 확인 ── */}
      {step === 'identify' && methods.identity !== 'off' && (
        <div style={s.card}>
          <h2 style={s.h2}>본인확인</h2>
          <p style={s.muted}>
            휴대폰 명의가 회원 본인인지 통신사에 확인합니다.
            가족이나 직원이 대신 투표하는 것을 막기 위한 절차입니다.
          </p>
          <button
            style={s.primary}
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.identityBegin(election.id);
                // 실제 서비스는 자기 화면으로 보낸다. mock 은 보낼 곳이 없어 직접 받는다.
                if (r.redirectUrl) { window.location.href = r.redirectUrl; return; }
                setIdTx(r.txId);
                setStep('idcheck');
              })
            }
          >
            {busy ? '연결 중…' : '본인확인으로 진행'}
          </button>
          {methods.otp && (
            <p style={{ ...s.muted, fontSize: 13, marginTop: 4 }}>
              아래 방법으로도 인증하실 수 있습니다.
            </p>
          )}
        </div>
      )}

      {step === 'identify' && methods.otp && (
        <form
          style={s.card}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await api.requestOtp(election.id, phone, birthDate);
              setChallenge({ id: r.challengeId, token: r.challengeToken, phoneLast4: r.phoneLast4 });
              setStep('otp');
            });
          }}
        >
          <h2 style={s.h2}>본인 확인</h2>
          <p style={s.muted}>협회 회원명부에 등록된 정보를 입력해 주세요.</p>

          <label style={s.label}>
            휴대폰번호
            <input
              style={{ ...s.input, fontSize: 24, letterSpacing: '0.05em' }}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="010-1234-5678"
              inputMode="tel"
              autoComplete="tel"
              autoFocus
              required
            />
          </label>

          <label style={s.label}>
            생년월일
            <input
              style={{ ...s.input, fontSize: 24, letterSpacing: '0.05em' }}
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
              placeholder="19750314"
              inputMode="numeric"
              autoComplete="bday"
              maxLength={8}
              required
            />
            <span style={{ ...s.muted, fontSize: 13, fontWeight: 400 }}>
              8자리로 입력해 주세요 (예: 1975년 3월 14일 → 19750314)
            </span>
          </label>

          <button style={s.primary} disabled={busy || phone.length < 9 || birthDate.length !== 8}>
            {busy ? '전송 중…' : '인증번호 받기'}
          </button>
        </form>
      )}

      {/* ── 1b단계: 본인확인 결과 입력 (mock 전용) ── */}
      {step === 'idcheck' && (
        <form
          style={s.card}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              if (!idTx) throw new Error('본인확인 거래가 없습니다. 처음부터 다시 진행해 주세요.');
              const r = await api.identityComplete(election.id, idTx, {
                name: idName, birthDate, phone,
              });
              setVoteToken(r.accessToken);
              setVoterName(r.nameMasked);
              setIdTx(null);
              setStep('ballot');
            });
          }}
        >
          <h2 style={s.h2}>본인확인</h2>
          <p style={{ ...s.muted, color: '#b45309' }}>
            지금은 시험용 연동입니다. 실제 선거에서는 이 화면 대신 PASS·NICE 등의
            인증 창이 열리고, 통신사 등록 명의가 자동으로 확인됩니다.
          </p>

          <label style={s.label}>
            이름
            <input
              style={{ ...s.input, fontSize: 24 }}
              value={idName}
              onChange={(e) => setIdName(e.target.value)}
              placeholder="홍길동"
              autoFocus
              required
            />
          </label>

          <label style={s.label}>
            생년월일
            <input
              style={{ ...s.input, fontSize: 24, letterSpacing: '0.05em' }}
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
              placeholder="19750314"
              inputMode="numeric"
              maxLength={8}
              required
            />
          </label>

          <label style={s.label}>
            휴대폰번호
            <input
              style={{ ...s.input, fontSize: 24, letterSpacing: '0.05em' }}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="010-1234-5678"
              inputMode="tel"
              required
            />
          </label>

          <button
            style={s.primary}
            disabled={busy || !idName.trim() || phone.length < 9 || birthDate.length !== 8}
          >
            {busy ? '확인 중…' : '확인'}
          </button>
        </form>
      )}

      {/* ── 2단계: 인증번호 ── */}
      {step === 'otp' && challenge && (
        <form
          style={s.card}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await api.verifyOtp(challenge.id, code, challenge.token);
              setVoteToken(r.accessToken);
              setVoterName(r.nameMasked);
              setStep('ballot');
            });
          }}
        >
          <h2 style={s.h2}>인증번호 입력</h2>
          <p style={s.muted}>
            <strong>***-****-{challenge.phoneLast4}</strong> 으로 6자리 인증번호를 보냈습니다.
            3분 안에 입력해 주세요.
          </p>

          <input
            style={{ ...s.input, fontSize: 32, letterSpacing: '0.4em', textAlign: 'center' }}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
          />
          <button style={s.primary} disabled={busy || code.length !== 6}>
            {busy ? '확인 중…' : '확인'}
          </button>
        </form>
      )}

      {/* ── 3단계: 투표용지 ── */}
      {step === 'ballot' && (
        <div style={s.card}>
          {voterName && (
            <div style={s.whoami}>
              <strong>{voterName}</strong> 님으로 확인되었습니다
            </div>
          )}
          <h2 style={s.h2}>후보자를 선택해 주세요</h2>
          <p style={s.muted}>한 명만 선택할 수 있으며, 제출 후에는 변경할 수 없습니다.</p>

          <div role="radiogroup" aria-label="후보자 목록">
            {election.candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={!abstain && picked?.id === c.id}
                onClick={() => {
                  setPicked(c);
                  setAbstain(false);
                }}
                style={{
                  ...s.candidate,
                  ...(!abstain && picked?.id === c.id ? s.candidateOn : {}),
                }}
              >
                <span style={s.badge}>{c.ballotNumber}</span>
                <span style={{ textAlign: 'left' }}>
                  <strong style={{ fontSize: 22 }}>{c.name}</strong>
                  {c.affiliation && <div style={s.muted}>{c.affiliation}</div>}
                </span>
              </button>
            ))}

            <button
              type="button"
              role="radio"
              aria-checked={abstain}
              onClick={() => {
                setAbstain(true);
                setPicked(null);
              }}
              style={{ ...s.candidate, ...(abstain ? s.candidateOn : {}) }}
            >
              <span style={{ ...s.badge, background: '#6b7280' }}>기권</span>
              <span style={{ textAlign: 'left' }}>선택하지 않고 기권합니다</span>
            </button>
          </div>

          <button
            type="button"
            style={s.primary}
            onClick={() => setStep('confirm')}
            disabled={busy || (!picked && !abstain)}
          >
            선택 완료
          </button>
        </div>
      )}

      {/* ── 4단계: 최종 확인 (되돌릴 수 없는 행동 앞에는 반드시 확인 화면) ── */}
      {step === 'confirm' && (
        <div style={s.card}>
          <h2 style={s.h2}>제출 전 최종 확인</h2>
          <div style={s.confirmBox}>
            {picked ? (
              <>
                <span style={s.badge}>{picked.ballotNumber}</span>
                <strong style={{ fontSize: 26 }}>{picked.name}</strong>
              </>
            ) : (
              <strong style={{ fontSize: 26 }}>기권</strong>
            )}
          </div>
          <p style={{ ...s.muted, color: '#b91c1c' }}>
            제출하면 되돌릴 수 없고, 다시 투표하실 수 없습니다.
          </p>
          <p style={{ ...s.muted, fontSize: 13 }}>
            선택하신 내용은 <strong>이 기기에서 암호화된 뒤</strong> 전송됩니다.
            서버는 누구를 선택하셨는지 알 수 없습니다.
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button style={s.secondary} onClick={() => setStep('ballot')} disabled={busy}>
              다시 선택
            </button>
            <button
              style={s.primary}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!election.ballotPublicKey) {
                    throw new Error('선거 봉인키를 받지 못했습니다. 새로고침 후 다시 시도해 주세요.');
                  }
                  // 여기서 봉인한다. 이 줄 이후로 나가는 것은 133바이트뿐이고,
                  // 어떤 후보를 골랐는지는 서버도 알 수 없다.
                  const sealed = await sealBallot(election.ballotPublicKey, picked?.id ?? null);
                  const r = await api.castSealedBallot(sealed);
                  setReceipt(r.confirmationCode);
                  setVoteToken(null); // 제출 직후 세션 폐기
                  setStep('done');
                })
              }
            >
              {busy ? '봉인해서 제출 중…' : '투표 제출'}
            </button>
          </div>
        </div>
      )}

      {/* ── 완료 ── */}
      {step === 'done' && (
        <div style={{ ...s.card, textAlign: 'center' }}>
          <div style={{ fontSize: 56, lineHeight: 1 }}>✓</div>
          <h2 style={s.h2}>투표가 완료되었습니다</h2>
          <p style={s.muted}>참여해 주셔서 감사합니다.</p>
          <div style={s.receipt}>
            <div style={s.muted}>투표 확인번호</div>
            <strong style={{ fontSize: 24, letterSpacing: '0.15em' }}>{receipt}</strong>
          </div>
          <p style={{ ...s.muted, fontSize: 13 }}>
            확인번호는 투표 참여 사실만 증명하며, 선택하신 후보는 담겨 있지 않습니다. 비밀투표
            원칙에 따라 어떤 방법으로도 조회할 수 없습니다.
          </p>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={s.page}>
      <main style={s.main}>{children}</main>
    </div>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" style={s.alert}>
      {children}
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const labels: [Step, string][] = [
    ['identify', '본인 확인'],
    ['otp', '인증'],
    ['ballot', '후보 선택'],
    ['done', '완료'],
  ];
  const order = labels.map(([k]) => k);
  const normalized: Step =
    current === 'confirm' ? 'ballot' : current === 'idcheck' ? 'otp' : current;
  const idx = order.indexOf(normalized);
  return (
    <ol style={s.steps}>
      {labels.map(([k, label], i) => (
        <li key={k} style={{ ...s.step, ...(i <= idx ? s.stepOn : {}) }}>
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

/* 유권자 다수가 고령이다. 기본 글자 크기를 키우고 터치 영역을 크게 잡았다. */
const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#f3f4f6',
    padding: '24px 16px',
    fontFamily: 'Pretendard, -apple-system, Malgun Gothic, sans-serif',
    color: '#111827',
  },
  main: { maxWidth: 560, margin: '0 auto' },
  header: { marginBottom: 20 },
  h1: { fontSize: 26, fontWeight: 700, margin: '0 0 6px' },
  h2: { fontSize: 20, fontWeight: 700, margin: '0 0 8px' },
  muted: { color: '#6b7280', fontSize: 15, margin: '4px 0' },
  card: {
    background: '#fff',
    borderRadius: 14,
    padding: 24,
    boxShadow: '0 1px 3px rgba(0,0,0,.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 16, fontWeight: 600 },
  input: {
    fontSize: 20,
    padding: '14px 16px',
    border: '2px solid #d1d5db',
    borderRadius: 10,
    fontFamily: 'inherit',
  },
  primary: {
    fontSize: 19,
    fontWeight: 700,
    padding: 16,
    background: '#1d4ed8',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
    flex: 1,
  },
  secondary: {
    fontSize: 19,
    fontWeight: 700,
    padding: 16,
    background: '#e5e7eb',
    color: '#111827',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
    flex: 1,
  },
  candidate: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    width: '100%',
    padding: 18,
    marginBottom: 10,
    background: '#fff',
    border: '2px solid #d1d5db',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 16,
  },
  candidateOn: { borderColor: '#1d4ed8', background: '#eff6ff' },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
    height: 44,
    borderRadius: 22,
    background: '#1d4ed8',
    color: '#fff',
    fontSize: 20,
    fontWeight: 700,
  },
  confirmBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: 20,
    background: '#f9fafb',
    border: '2px solid #1d4ed8',
    borderRadius: 12,
  },
  receipt: { padding: 16, background: '#f9fafb', borderRadius: 10 },
  whoami: {
    padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe',
    borderRadius: 8, fontSize: 15, color: '#1e40af',
  },
  alert: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#b91c1c',
    padding: 14,
    borderRadius: 10,
    marginBottom: 14,
    fontSize: 15,
  },
  steps: {
    display: 'flex',
    gap: 6,
    listStyle: 'none',
    padding: 0,
    margin: '0 0 16px',
    fontSize: 13,
  },
  step: {
    flex: 1,
    padding: '8px 4px',
    textAlign: 'center',
    background: '#e5e7eb',
    color: '#6b7280',
    borderRadius: 6,
  },
  stepOn: { background: '#1d4ed8', color: '#fff' },
};
