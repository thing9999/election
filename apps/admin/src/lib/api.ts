/**
 * 선관위 API 클라이언트.
 *
 * 토큰은 메모리에만 둔다. localStorage 에 넣으면 XSS 한 번으로 선거 전체가 넘어가고,
 * 공용 PC 에서 브라우저를 닫아도 남는다. 새로고침하면 다시 로그인해야 하지만
 * 선관위 화면은 그게 맞다.
 */

const BASE = '/api';

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setToken = (t: string | null) => { token = t; };
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function request<T>(path: string, init?: RequestInit, bearer?: string): Promise<T> {
  const auth = bearer ?? token;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...init?.headers,
    },
  });

  // 세션이 끊기면(30분 만료, 계정 비활성화) 바로 로그인 화면으로 되돌린다.
  if (res.status === 401 && auth === token && token !== null) {
    token = null;
    onUnauthorized?.();
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(body.message) ? body.message.join('\n') : body.message;
    throw new Error(msg ?? `요청을 처리하지 못했습니다. (HTTP ${res.status})`);
  }
  return body as T;
}

export type ElectionStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'TALLIED';
export type AdminRole = 'COMMISSIONER' | 'AUDITOR';

export interface ElectionSummary {
  id: string;
  title: string;
  status: ElectionStatus;
  startsAt: string;
  endsAt: string;
  talliedAt: string | null;
  candidateCount: number;
  voterCount: number;
  ballotCount: number;
}

export interface Candidate {
  id: string;
  ballotNumber: number;
  name: string;
  affiliation: string | null;
  pledge: string | null;
}

export interface ElectionOverview {
  id: string;
  title: string;
  description: string | null;
  status: ElectionStatus;
  startsAt: string;
  endsAt: string;
  talliedAt: string | null;
  invalidVotes: number;
  hasKey: boolean;
  candidates: Candidate[];
  turnout: { eligible: number; voted: number; rate: number };
  integrity: { votedVoters: number; ballots: number; matched: boolean };
  tally: {
    approvals: number;
    required: number;
    approvedBy: Array<{ name: string; at: string }>;
  };
}

export interface Results {
  election: { id: string; title: string; talliedAt: string | null };
  eligible: number;
  totalBallots: number;
  validBallots: number;
  abstained: number;
  invalid: number;
  turnoutRate: number;
  results: Array<{
    id: string; ballotNumber: number; name: string;
    affiliation: string | null; votes: number; share: number;
  }>;
}

export interface CandidateInput {
  ballotNumber: number;
  name: string;
  affiliation?: string;
  pledge?: string;
}

export const api = {
  // ── 인증 ──
  login: (loginId: string, password: string) =>
    request<{ pendingToken: string; totpRegistered: boolean; name: string }>(
      '/admin/auth/login',
      { method: 'POST', body: JSON.stringify({ loginId, password }) },
    ),

  enrollTotp: (pendingToken: string) =>
    request<{ secret: string; qrDataUrl: string }>(
      '/admin/auth/totp/enroll', { method: 'POST' }, pendingToken,
    ),

  verifyTotp: (pendingToken: string, code: string) =>
    request<{ accessToken: string; role: AdminRole; name: string }>(
      '/admin/auth/totp/verify',
      { method: 'POST', body: JSON.stringify({ code }) },
      pendingToken,
    ),

  changePassword: (current: string, next: string) =>
    request<{ ok: boolean }>('/admin/auth/password', {
      method: 'POST', body: JSON.stringify({ current, next }),
    }),

  // ── 선거 ──
  listElections: () => request<ElectionSummary[]>('/admin/elections'),

  overview: (id: string) => request<ElectionOverview>(`/admin/elections/${id}/overview`),

  createElection: (input: {
    title: string; description?: string; startsAt: string; endsAt: string;
    candidates: CandidateInput[];
  }) =>
    request<{
      election: { id: string; title: string; status: ElectionStatus };
      privateKey: string;
      publicKey: string;
    }>('/admin/elections', { method: 'POST', body: JSON.stringify(input) }),

  replaceCandidates: (id: string, candidates: CandidateInput[]) =>
    request<{ ok: boolean; count: number }>(`/admin/elections/${id}/candidates`, {
      method: 'POST', body: JSON.stringify({ candidates }),
    }),

  uploadRoster: (id: string, csv: string) =>
    request<{ submitted: number; inserted: number }>(`/admin/elections/${id}/roster`, {
      method: 'POST', body: JSON.stringify({ csv }),
    }),

  openElection: (id: string) =>
    request<{ ok: boolean; voterCount: number; candidateCount: number }>(
      `/admin/elections/${id}/open`, { method: 'POST' },
    ),

  closeElection: (id: string) =>
    request<{ ok: boolean }>(`/admin/elections/${id}/close`, { method: 'POST' }),

  integrity: (id: string) =>
    request<{ votedVoters: number; ballots: number; matched: boolean; diff: number }>(
      `/admin/elections/${id}/integrity`,
    ),

  approveTally: (id: string, privateKey: string) =>
    request<{
      tallied: boolean; approvals: number; required: number;
      approvedBy: string[]; opened?: number; invalid?: number; message: string;
    }>(`/admin/elections/${id}/tally`, {
      method: 'POST', body: JSON.stringify({ privateKey }),
    }),

  results: (id: string) => request<Results>(`/elections/${id}/results`),
};
