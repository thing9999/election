import { useEffect, useState } from 'react';
import './styles.css';
import { setToken, setUnauthorizedHandler, type AdminRole } from './lib/api';
import Login from './pages/Login';
import Elections from './pages/Elections';
import ElectionDetail from './pages/ElectionDetail';
import CreateElection from './pages/CreateElection';

type View = { name: 'list' } | { name: 'detail'; id: string } | { name: 'create' };

interface Session {
  role: AdminRole;
  name: string;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>({ name: 'list' });
  const [expired, setExpired] = useState(false);

  // 토큰은 메모리에만 있으므로 만료·비활성화 시 화면을 로그인으로 되돌린다.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      setView({ name: 'list' });
      setExpired(true);
    });
  }, []);

  const logout = () => {
    setToken(null);
    setSession(null);
    setView({ name: 'list' });
  };

  if (!session) {
    return (
      <>
        {expired && (
          <div className="alert warn" style={{ margin: 0, borderRadius: 0, textAlign: 'center' }}>
            세션이 만료되었습니다. 다시 로그인해 주세요.
          </div>
        )}
        <Login
          onSuccess={({ token, role, name }) => {
            setToken(token);
            setSession({ role, name });
            setExpired(false);
          }}
        />
      </>
    );
  }

  return (
    <>
      <header className="topbar">
        <h1>선거관리위원회</h1>
        <div className="spacer" />
        <div className="who">
          <span>{session.name}</span>
          <span className="badge role" style={{ background: 'rgba(255,255,255,.18)', color: '#fff' }}>
            {session.role === 'COMMISSIONER' ? '선관위원' : '참관인'}
          </span>
        </div>
        <button onClick={logout}>로그아웃</button>
      </header>

      {view.name === 'list' && (
        <Elections
          role={session.role}
          onOpen={(id) => setView({ name: 'detail', id })}
          onCreate={() => setView({ name: 'create' })}
        />
      )}

      {view.name === 'detail' && (
        <ElectionDetail
          id={view.id}
          role={session.role}
          onBack={() => setView({ name: 'list' })}
        />
      )}

      {view.name === 'create' && (
        <CreateElection
          onDone={(id) => setView({ name: 'detail', id })}
          onCancel={() => setView({ name: 'list' })}
        />
      )}
    </>
  );
}
