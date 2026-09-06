const BASE = '/api';

let voteToken: string | null = null;
export const setVoteToken = (t: string | null) => { voteToken = t; };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(voteToken ? { Authorization: `Bearer ${voteToken}` } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message ?? '요청을 처리하지 못했습니다.');
  }
  return body as T;
}

export interface Candidate {
  id: string;
  ballotNumber: number;
  name: string;
  affiliation: string | null;
  pledge: string | null;
  photoUrl: string | null;
}

export interface Election {
  id: string;
  title: string;
  description: string | null;
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'TALLIED';
  startsAt: string;
  endsAt: string;
  /** 표를 봉인할 때 쓰는 선거 공개키. 공개해도 안전한 값이다. */
  ballotPublicKey: string | null;
  candidates: Candidate[];
}

export const api = {
  /** id 를 주면 그 선거, 없으면 지금 진행 중인 선거 */
  getElection: (id?: string) =>
    request<Election>(id ? `/elections/${id}` : '/elections/current'),

  /** 이 선거가 어떤 인증 경로를 여는지. 화면 구성이 여기에 달려 있다 */
  getAuthMethods: () =>
    request<{ identity: 'off' | 'optional' | 'required'; otp: boolean }>('/auth/methods'),

  /** 본인확인 시작. redirectUrl 이 있으면 그리로 보낸다 (mock 은 null) */
  identityBegin: (electionId: string) =>
    request<{ txId: string; redirectUrl: string | null; provider: string }>(
      '/auth/identity/begin',
      { method: 'POST', body: JSON.stringify({ electionId }) },
    ),

  /** 본인확인 결과를 서버에 넘겨 명부와 대조하고 투표 세션을 받는다 */
  identityComplete: (electionId: string, txId: string, payload: unknown) =>
    request<{ accessToken: string; electionId: string; nameMasked: string }>(
      '/auth/identity/complete',
      { method: 'POST', body: JSON.stringify({ electionId, txId, payload }) },
    ),

  requestOtp: (electionId: string, phone: string, birthDate: string) =>
    request<{ challengeId: string; challengeToken: string; phoneLast4: string; expiresInSec: number }>(
      '/auth/otp/request',
      { method: 'POST', body: JSON.stringify({ electionId, phone, birthDate }) },
    ),

  verifyOtp: (challengeId: string, code: string, challengeToken?: string) =>
    request<{ accessToken: string; electionId: string; nameMasked: string }>('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId, code, challengeToken }),
    }),

  /** 이미 봉인된 133바이트(base64)를 보낸다. 후보 ID 는 서버로 나가지 않는다. */
  castSealedBallot: (sealedVote: string) =>
    request<{ completedAt: string; confirmationCode: string }>('/vote', {
      method: 'POST',
      body: JSON.stringify({ sealedVote }),
    }),

  getTurnout: (id: string) =>
    request<{ eligible: number; voted: number; turnoutRate: number }>(`/elections/${id}/turnout`),
};
