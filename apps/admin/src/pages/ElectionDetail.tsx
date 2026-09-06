import { useCallback, useEffect, useState } from 'react';
import {
  api, type AdminRole, type ElectionOverview, type Results, type ElectionStatus,
} from '../lib/api';

const STEPS: Array<{ k: ElectionStatus; label: string }> = [
  { k: 'DRAFT', label: '1. 준비' },
  { k: 'OPEN', label: '2. 투표' },
  { k: 'CLOSED', label: '3. 마감' },
  { k: 'TALLIED', label: '4. 개표' },
];

const STATUS_LABEL: Record<ElectionStatus, string> = {
  DRAFT: '준비중', OPEN: '진행중', CLOSED: '마감', TALLIED: '개표완료',
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }) : '—';

export default function ElectionDetail({
  id, role, onBack,
}: {
  id: string;
  role: AdminRole;
  onBack: () => void;
}) {
  const [ov, setOv] = useState<ElectionOverview | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [csv, setCsv] = useState('');
  const [tallyKey, setTallyKey] = useState('');
  const [confirmAction, setConfirmAction] = useState<null | 'open' | 'close'>(null);

  const readOnly = role !== 'COMMISSIONER';

  const load = useCallback(async () => {
    try {
      const o = await api.overview(id);
      setOv(o);
      if (o.status === 'TALLIED') setResults(await api.results(id));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<string | void>) => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const m = await fn();
      if (m) setMsg(m);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (err && !ov) return (
    <main>
      <div className="crumb"><button onClick={onBack}>선거 목록</button></div>
      <div className="alert err">{err}</div>
    </main>
  );
  if (!ov) return <main><div className="empty">불러오는 중…</div></main>;

  const stepIdx = STEPS.findIndex((s) => s.k === ov.status);

  return (
    <main>
      <div className="crumb">
        <button onClick={onBack}>선거 목록</button> <span>›</span> <span>{ov.title}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>{ov.title}</h2>
        <span className={`badge ${ov.status}`}>{STATUS_LABEL[ov.status]}</span>
      </div>
      <p className="sub">
        {fmt(ov.startsAt)} ~ {fmt(ov.endsAt)}
        {ov.description && <> · {ov.description}</>}
      </p>

      <div className="stepper">
        {STEPS.map((s, i) => (
          <div key={s.k} className={`st ${i < stepIdx ? 'done' : ''} ${i === stepIdx ? 'now' : ''}`}>
            {s.label}
          </div>
        ))}
      </div>

      {err && <div className="alert err">{err}</div>}
      {msg && <div className="alert ok">{msg}</div>}
      {readOnly && (
        <div className="alert info">
          참관인 계정입니다. 모든 수치를 확인할 수 있지만 아무것도 변경할 수 없습니다.
        </div>
      )}
      {!ov.hasKey && (
        <div className="alert err">
          봉인키가 없는 선거입니다. 투표를 받을 수 없습니다.
        </div>
      )}

      {/* ── 현황 ── */}
      <div className="panel">
        <div className="panel-head"><h3>현황</h3></div>
        <div className="panel-body">
          <div className="stats">
            <div className="stat">
              <div className="k">선거인</div>
              <div className="v mono">{ov.turnout.eligible.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="k">투표</div>
              <div className="v mono">
                {ov.turnout.voted.toLocaleString()}<small>{ov.turnout.rate}%</small>
              </div>
            </div>
            <div className={`stat ${ov.integrity.matched ? 'ok' : 'warn'}`}>
              <div className="k">무결성</div>
              <div className="v" style={{ fontSize: 17 }}>
                {ov.integrity.matched ? '일치' : `불일치 ${ov.integrity.ballots - ov.integrity.votedVoters}`}
              </div>
            </div>
            <div className="stat">
              <div className="k">후보</div>
              <div className="v mono">{ov.candidates.length}</div>
            </div>
          </div>

          {ov.turnout.eligible > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="bar"><i style={{ width: `${Math.min(100, ov.turnout.rate)}%` }} /></div>
              <p className="hint" style={{ marginTop: 6 }}>
                투표율은 진행 중에도 공개됩니다. <strong>후보별 득표는 개표 전까지
                이 화면에도 표시되지 않습니다</strong> — 선관위 화면이라고 예외를 두면
                그 화면이 곧 유출 경로가 됩니다.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── 후보 ── */}
      <div className="panel">
        <div className="panel-head"><h3>후보자</h3></div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th className="num" style={{ width: 70, paddingLeft: 18 }}>기호</th>
                <th>이름</th>
                <th style={{ paddingRight: 18 }}>소속 · 경력</th>
              </tr>
            </thead>
            <tbody>
              {ov.candidates.map((c) => (
                <tr key={c.id}>
                  <td className="num mono" style={{ paddingLeft: 18, fontWeight: 700 }}>
                    {c.ballotNumber}
                  </td>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td style={{ color: 'var(--ink-soft)', paddingRight: 18 }}>
                    {c.affiliation ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 1단계: 명부 ── */}
      {ov.status === 'DRAFT' && !readOnly && (
        <div className="panel">
          <div className="panel-head"><h3>유권자 명부 등록</h3></div>
          <div className="panel-body">
            <p className="hint" style={{ marginBottom: 10 }}>
              CSV 첫 줄은 <code className="mono">memberNo,name,phone,birthDate</code> 여야 합니다.
              휴대폰이 로그인 수단이라 <strong>회원마다 달라야 합니다</strong> — 겹치면 등록이 거부됩니다.
            </p>
            <div className="field">
              <textarea
                className="mono" value={csv} onChange={(e) => setCsv(e.target.value)}
                style={{ minHeight: 150, fontSize: 13 }}
                placeholder={'memberNo,name,phone,birthDate\nM00001,홍길동,010-1234-5678,19750314'}
              />
            </div>
            <div className="actions">
              <button
                className="btn primary" disabled={busy || csv.trim().length === 0}
                onClick={() => act(async () => {
                  const r = await api.uploadRoster(id, csv);
                  setCsv('');
                  return `명부 ${r.inserted.toLocaleString()}명 등록 완료 (제출 ${r.submitted.toLocaleString()}건)`;
                })}
              >
                {busy ? '등록 중…' : '명부 등록'}
              </button>
              <span className="hint">
                명부는 준비중 상태에서만 등록됩니다. 투표 시작 후 명부가 바뀌면
                결과를 신뢰할 수 없기 때문입니다.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── 단계 전환 ── */}
      {!readOnly && (ov.status === 'DRAFT' || ov.status === 'OPEN') && (
        <div className="panel">
          <div className="panel-head"><h3>투표 {ov.status === 'DRAFT' ? '개시' : '마감'}</h3></div>
          <div className="panel-body">
            {ov.status === 'DRAFT' ? (
              <>
                <p className="hint" style={{ marginBottom: 12 }}>
                  개시하면 유권자가 투표할 수 있고, <strong>명부와 후보를 더 이상 바꿀 수 없습니다.</strong>
                </p>
                <button
                  className="btn primary"
                  disabled={busy || ov.turnout.eligible === 0 || ov.candidates.length === 0}
                  onClick={() => setConfirmAction('open')}
                >
                  투표 개시
                </button>
                {ov.turnout.eligible === 0 && (
                  <span className="hint" style={{ marginLeft: 12 }}>명부를 먼저 등록하세요.</span>
                )}
              </>
            ) : (
              <>
                <p className="hint" style={{ marginBottom: 12 }}>
                  마감하면 더 이상 표를 받지 않습니다. 되돌릴 수 없습니다.
                </p>
                <button className="btn danger" disabled={busy} onClick={() => setConfirmAction('close')}>
                  투표 마감
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── 개표 ── */}
      {ov.status === 'CLOSED' && (
        <div className="panel">
          <div className="panel-head">
            <h3>개표</h3>
            <div className="spacer" />
            <span className="badge role">
              승인 {ov.tally.approvals} / {ov.tally.required}
            </span>
          </div>
          <div className="panel-body">
            {!ov.integrity.matched && (
              <div className="alert err">
                무결성 점검 실패 — 투표 처리된 유권자 {ov.integrity.votedVoters}명 /
                실제 표 {ov.integrity.ballots}장. 원인을 규명하기 전에는 개표할 수 없습니다.
              </div>
            )}

            {ov.tally.approvedBy.length > 0 && (
              <div className="alert info">
                승인함: {ov.tally.approvedBy.map((a) => a.name).join(', ')}
                {ov.tally.approvals < ov.tally.required &&
                  ` — 다른 선관위원 ${ov.tally.required - ov.tally.approvals}명의 승인이 더 필요합니다.`}
              </div>
            )}

            {readOnly ? (
              <p className="hint">참관인은 개표를 승인할 수 없습니다.</p>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="pk">개표키</label>
                  <textarea
                    id="pk" className="mono" value={tallyKey}
                    onChange={(e) => setTallyKey(e.target.value.trim())}
                    style={{ minHeight: 72, fontSize: 12.5 }}
                    placeholder="선거 생성 시 보관한 개표키를 붙여넣으세요"
                  />
                  <p className="hint">
                    키는 저장하지 않습니다. 승인할 때마다 다시 입력해야 합니다 —
                    서버에 두면 서버를 뚫은 사람이 곧 표를 열어볼 수 있습니다.
                  </p>
                </div>
                <div className="actions">
                  <button
                    className="btn primary"
                    disabled={busy || tallyKey.length < 100 || !ov.integrity.matched}
                    onClick={() => act(async () => {
                      const r = await api.approveTally(id, tallyKey);
                      setTallyKey('');
                      return r.message;
                    })}
                  >
                    {busy ? '처리 중…' : `개표 승인 (${ov.tally.approvals + 1}/${ov.tally.required})`}
                  </button>
                  <span className="hint">
                    서로 다른 선관위원 {ov.tally.required}명이 각자 승인해야 실제로 개표됩니다.
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── 결과 ── */}
      {ov.status === 'TALLIED' && results && (
        <div className="panel">
          <div className="panel-head">
            <h3>개표 결과</h3>
            <div className="spacer" />
            <span className="hint">{fmt(ov.talliedAt)} 개표</span>
          </div>
          <div className="panel-body">
            <div className="stats" style={{ marginBottom: 16 }}>
              <div className="stat">
                <div className="k">투표율</div>
                <div className="v mono">{results.turnoutRate}<small>%</small></div>
              </div>
              <div className="stat">
                <div className="k">유효표</div>
                <div className="v mono">{results.validBallots.toLocaleString()}</div>
              </div>
              <div className="stat">
                <div className="k">기권</div>
                <div className="v mono">{results.abstained.toLocaleString()}</div>
              </div>
              <div className={`stat ${results.invalid > 0 ? 'warn' : ''}`}>
                <div className="k">무효</div>
                <div className="v mono">{results.invalid.toLocaleString()}</div>
              </div>
            </div>

            {results.invalid > 0 && (
              <div className="alert warn">
                열 수 없는 표가 {results.invalid}건 있었습니다. 형식이 깨졌거나 명부에 없는
                후보가 담긴 표입니다. <strong>당락에 영향을 줄 수 있는 규모인지 확인하고
                원인을 조사하세요.</strong>
              </div>
            )}

            <table>
              <thead>
                <tr>
                  <th className="num" style={{ width: 60, paddingLeft: 18 }}>기호</th>
                  <th>후보</th>
                  <th className="num">득표</th>
                  <th className="num">득표율</th>
                  <th style={{ width: '34%', paddingRight: 18 }} />
                </tr>
              </thead>
              <tbody>
                {results.results.map((c, i) => (
                  <tr key={c.id}>
                    <td className="num mono" style={{ paddingLeft: 18, fontWeight: 700 }}>
                      {c.ballotNumber}
                    </td>
                    <td style={{ fontWeight: i === 0 ? 700 : 500 }}>
                      {c.name}
                      {i === 0 && results.results.length > 1 &&
                        c.votes > results.results[1].votes && (
                        <span className="badge TALLIED" style={{ marginLeft: 8 }}>최다득표</span>
                      )}
                    </td>
                    <td className="num mono">{c.votes.toLocaleString()}</td>
                    <td className="num mono">{c.share}%</td>
                    <td style={{ paddingRight: 18 }}>
                      <div className="bar"><i style={{ width: `${c.share}%` }} /></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 되돌릴 수 없는 행동 확인 ── */}
      {confirmAction && (
        <div className="backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="panel-body">
              <h3>{confirmAction === 'open' ? '투표를 개시합니다' : '투표를 마감합니다'}</h3>
              <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
                {confirmAction === 'open' ? (
                  <>
                    선거인 <strong>{ov.turnout.eligible.toLocaleString()}명</strong>,
                    후보 <strong>{ov.candidates.length}명</strong>으로 투표를 엽니다.
                    개시 후에는 명부와 후보를 바꿀 수 없습니다.
                  </>
                ) : (
                  <>
                    현재 <strong>{ov.turnout.voted.toLocaleString()}명</strong>이 투표했습니다.
                    마감하면 더 이상 표를 받지 않으며 되돌릴 수 없습니다.
                  </>
                )}
              </p>
              <div className="actions" style={{ marginTop: 18 }}>
                <button
                  className={`btn ${confirmAction === 'open' ? 'primary' : 'danger'}`}
                  disabled={busy}
                  onClick={() => {
                    const a = confirmAction;
                    setConfirmAction(null);
                    act(async () => {
                      if (a === 'open') { await api.openElection(id); return '투표가 개시되었습니다.'; }
                      await api.closeElection(id); return '투표가 마감되었습니다.';
                    });
                  }}
                >
                  {confirmAction === 'open' ? '개시' : '마감'}
                </button>
                <button className="btn ghost" onClick={() => setConfirmAction(null)}>취소</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
