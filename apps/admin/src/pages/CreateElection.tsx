import { useState } from 'react';
import { api, type CandidateInput } from '../lib/api';

const blank = (n: number): CandidateInput => ({ ballotNumber: n, name: '', affiliation: '' });

/** datetime-local 값 → ISO. 브라우저는 로컬시각을 주므로 그대로 Date 로 넘긴다. */
const toIso = (local: string) => (local ? new Date(local).toISOString() : '');

export default function CreateElection({
  onDone, onCancel,
}: {
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [cands, setCands] = useState<CandidateInput[]>([blank(1), blank(2)]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 생성 직후 개표키를 한 번 보여준다. 확인하기 전에는 넘어갈 수 없다.
  const [created, setCreated] = useState<{ id: string; privateKey: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const setCand = (i: number, patch: Partial<CandidateInput>) =>
    setCands((cs) => cs.map((c, k) => (k === i ? { ...c, ...patch } : c)));

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api.createElection({
        title: title.trim(),
        description: description.trim() || undefined,
        startsAt: toIso(startsAt),
        endsAt: toIso(endsAt),
        candidates: cands.map((c) => ({
          ballotNumber: c.ballotNumber,
          name: c.name.trim(),
          affiliation: c.affiliation?.trim() || undefined,
        })),
      });
      setCreated({ id: r.election.id, privateKey: r.privateKey });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const valid =
    title.trim().length >= 2 && startsAt && endsAt &&
    cands.every((c) => c.name.trim().length > 0);

  return (
    <main>
      <div className="crumb">
        <button onClick={onCancel}>선거 목록</button> <span>›</span> <span>새 선거</span>
      </div>
      <h2>새 선거 만들기</h2>
      <p className="sub">
        만들면 준비중(DRAFT) 상태로 시작합니다. 명부를 등록한 뒤 개시해야 투표가 열립니다.
      </p>

      {err && <div className="alert err">{err}</div>}

      <div className="panel">
        <div className="panel-head"><h3>선거 정보</h3></div>
        <div className="panel-body">
          <div className="field">
            <label htmlFor="t">선거명</label>
            <input id="t" type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="제42대 협회장 선거" />
          </div>
          <div className="field">
            <label htmlFor="d">설명 <span className="hint" style={{ display: 'inline' }}>(선택)</span></label>
            <input id="d" type="text" value={description}
              onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="s">투표 시작</label>
              <input id="s" type="datetime-local" value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="e">투표 종료</label>
              <input id="e" type="datetime-local" value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>후보자</h3>
          <div className="spacer" />
          <button className="btn ghost sm"
            onClick={() => setCands((cs) => [...cs, blank(cs.length + 1)])}>
            후보 추가
          </button>
        </div>
        <div className="panel-body">
          {cands.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
              <div style={{ width: 74, flex: '0 0 auto' }}>
                <label>기호</label>
                <input type="number" min={1} max={99} value={c.ballotNumber} className="mono"
                  onChange={(e) => setCand(i, { ballotNumber: Number(e.target.value) })} />
              </div>
              <div style={{ flex: 1 }}>
                <label>이름</label>
                <input type="text" value={c.name}
                  onChange={(e) => setCand(i, { name: e.target.value })} />
              </div>
              <div style={{ flex: 1.4 }}>
                <label>소속 · 경력</label>
                <input type="text" value={c.affiliation ?? ''}
                  onChange={(e) => setCand(i, { affiliation: e.target.value })} />
              </div>
              <button
                className="btn ghost sm" disabled={cands.length <= 1}
                style={{ flex: '0 0 auto', marginBottom: 1 }}
                onClick={() => setCands((cs) => cs.filter((_, k) => k !== i))}
              >
                삭제
              </button>
            </div>
          ))}
          <p className="hint">후보는 준비중 상태에서만 바꿀 수 있습니다.</p>
        </div>
      </div>

      <div className="actions">
        <button className="btn primary" disabled={!valid || busy} onClick={submit}>
          {busy ? '생성 중…' : '선거 만들기'}
        </button>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>취소</button>
        {!valid && <span className="hint">선거명·기간·후보 이름을 모두 채워 주세요.</span>}
      </div>

      {/* ── 개표키: 이 화면을 놓치면 개표를 못 한다 ── */}
      {created && (
        <div className="backdrop" role="dialog" aria-modal="true" aria-labelledby="keytitle">
          <div className="modal">
            <div className="panel-body">
              <h3 id="keytitle">개표키를 지금 보관하세요</h3>
              <div className="alert warn" style={{ marginTop: 10 }}>
                이 키는 <strong>다시 볼 수 없습니다.</strong> 서버에 저장하지 않기 때문입니다.
                잃어버리면 <strong>개표가 영구히 불가능합니다.</strong>
              </div>

              <div className="keybox">{created.privateKey}</div>

              <div className="actions" style={{ marginBottom: 12 }}>
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(created.privateKey)
                      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
                      .catch(() => setErr('복사에 실패했습니다. 직접 선택해서 복사해 주세요.'));
                  }}
                >
                  {copied ? '복사됨' : '복사'}
                </button>
              </div>

              <p className="hint" style={{ marginBottom: 4 }}>보관 요령</p>
              <ul style={{ fontSize: 13.5, color: 'var(--ink-soft)', margin: '0 0 10px', paddingLeft: 18 }}>
                <li>이 서버나 같은 사무실 PC에 파일로 두지 마세요 — 서버가 뚫리면 의미가 없습니다</li>
                <li>인쇄해서 봉인 보관하거나, 오프라인 매체에 넣어 금고에 두세요</li>
                <li>개표 당일에만 꺼내 씁니다. 개표는 선관위원 2명의 승인이 함께 있어야 실행됩니다</li>
              </ul>

              <label className="check">
                <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
                <span>안전한 곳에 보관했고, 다시 볼 수 없다는 것을 확인했습니다.</span>
              </label>

              <button
                className="btn primary" style={{ width: '100%' }} disabled={!saved}
                onClick={() => onDone(created.id)}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
