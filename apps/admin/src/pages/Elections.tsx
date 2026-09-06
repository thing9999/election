import { useEffect, useState } from 'react';
import { api, type ElectionSummary, type AdminRole } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '준비중', OPEN: '진행중', CLOSED: '마감', TALLIED: '개표완료',
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

export default function Elections({
  role, onOpen, onCreate,
}: {
  role: AdminRole;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [rows, setRows] = useState<ElectionSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listElections().then(setRows).catch((e) => setErr(e.message));
  }, []);

  return (
    <main>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2>선거 목록</h2>
          <p className="sub">
            {role === 'AUDITOR'
              ? '참관인 계정입니다. 조회만 가능하며 아무것도 변경할 수 없습니다.'
              : '선거를 선택하면 명부 등록·개시·마감·개표를 진행할 수 있습니다.'}
          </p>
        </div>
        {role === 'COMMISSIONER' && (
          <button className="btn primary" onClick={onCreate}>새 선거 만들기</button>
        )}
      </div>

      {err && <div className="alert err">{err}</div>}

      <div className="panel">
        {rows === null && !err && <div className="empty">불러오는 중…</div>}
        {rows?.length === 0 && (
          <div className="empty">
            등록된 선거가 없습니다.
            {role === 'COMMISSIONER' && ' “새 선거 만들기”로 시작하세요.'}
          </div>
        )}
        {rows && rows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>선거</th>
                  <th>상태</th>
                  <th>투표 기간</th>
                  <th className="num">후보</th>
                  <th className="num">선거인</th>
                  <th className="num" style={{ paddingRight: 18 }}>투표</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => onOpen(e.id)}>
                    <td style={{ paddingLeft: 18, fontWeight: 600 }}>{e.title}</td>
                    <td><span className={`badge ${e.status}`}>{STATUS_LABEL[e.status]}</span></td>
                    <td className="mono" style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
                      {fmt(e.startsAt)}<br />{fmt(e.endsAt)}
                    </td>
                    <td className="num mono">{e.candidateCount}</td>
                    <td className="num mono">{e.voterCount.toLocaleString()}</td>
                    <td className="num mono" style={{ paddingRight: 18 }}>
                      {e.ballotCount.toLocaleString()}
                      {e.voterCount > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                          {Math.round((e.ballotCount / e.voterCount) * 1000) / 10}%
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
