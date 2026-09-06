import { useState } from 'react';
import { api, type AdminRole } from '../lib/api';

type Stage = 'password' | 'enroll' | 'totp';

/**
 * 선관위 로그인. 비밀번호만으로는 아무 권한도 나오지 않는다 —
 * pendingToken 은 TOTP 단계에서만 쓰이고, 관리자 API 는 전부 401 이다.
 */
export default function Login({
  onSuccess,
}: {
  onSuccess: (t: { token: string; role: AdminRole; name: string }) => void;
}) {
  const [stage, setStage] = useState<Stage>('password');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState('');
  const [qr, setQr] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setErr(null); setBusy(true);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="login">
        <div className="brand">
          <div className="t">선거관리위원회</div>
          <div className="s">협회장 선거 전자투표 관리</div>
        </div>

        <div className="panel">
          <div className="panel-body">
            {err && <div className="alert err">{err}</div>}

            {stage === 'password' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    const r = await api.login(loginId, password);
                    setPending(r.pendingToken);
                    if (r.totpRegistered) {
                      setStage('totp');
                    } else {
                      setQr(await api.enrollTotp(r.pendingToken));
                      setStage('enroll');
                    }
                  });
                }}
              >
                <div className="field">
                  <label htmlFor="lid">아이디</label>
                  <input
                    id="lid" type="text" value={loginId} autoFocus autoComplete="username"
                    onChange={(e) => setLoginId(e.target.value)} required
                  />
                </div>
                <div className="field">
                  <label htmlFor="pw">비밀번호</label>
                  <input
                    id="pw" type="password" value={password} autoComplete="current-password"
                    onChange={(e) => setPassword(e.target.value)} required
                  />
                </div>
                <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
                  {busy ? '확인 중…' : '다음'}
                </button>
                <p className="hint" style={{ marginTop: 12 }}>
                  비밀번호 다음에 2차 인증이 필요합니다. 5회 틀리면 30분간 잠깁니다.
                </p>
              </form>
            )}

            {stage === 'enroll' && qr && (
              <div>
                <h3>2차 인증 등록</h3>
                <p className="hint" style={{ marginBottom: 14 }}>
                  이 계정은 아직 2차 인증이 등록되지 않았습니다. 인증 앱(Google
                  Authenticator, Authy 등)으로 아래 QR을 스캔한 뒤 표시되는 6자리를
                  입력하세요. <strong>등록 후에는 다시 바꿀 수 없습니다.</strong>
                </p>
                <div style={{ textAlign: 'center', margin: '14px 0' }}>
                  <img
                    src={qr.qrDataUrl} alt="2차 인증 등록용 QR 코드"
                    width={190} height={190}
                    style={{ border: '1px solid var(--line)', borderRadius: 4 }}
                  />
                </div>
                <div className="hint">QR을 못 읽으면 이 키를 직접 입력하세요</div>
                <div className="keybox">{qr.secret}</div>
                <button className="btn ghost" style={{ width: '100%' }} onClick={() => setStage('totp')}>
                  등록했습니다
                </button>
              </div>
            )}

            {stage === 'totp' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    const r = await api.verifyTotp(pending, code);
                    onSuccess({ token: r.accessToken, role: r.role, name: r.name });
                  });
                }}
              >
                <h3>인증번호 입력</h3>
                <p className="hint" style={{ marginBottom: 14 }}>
                  인증 앱에 표시된 6자리 숫자를 입력하세요.
                </p>
                <div className="field">
                  <input
                    className="mono" type="text" value={code} autoFocus inputMode="numeric"
                    autoComplete="one-time-code" maxLength={6}
                    style={{ fontSize: 26, letterSpacing: '0.35em', textAlign: 'center' }}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    required
                  />
                </div>
                <button
                  className="btn primary" style={{ width: '100%' }}
                  disabled={busy || code.length !== 6}
                >
                  {busy ? '확인 중…' : '로그인'}
                </button>
                <p className="hint" style={{ marginTop: 12 }}>
                  같은 번호는 한 번만 쓸 수 있습니다. 방금 쓴 번호가 화면에 남아 있으면
                  다음 번호가 나올 때까지 기다려 주세요.
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
