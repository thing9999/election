/**
 * 투표지 봉인 — 브라우저에서 실행되는 유일한 암호 코드.
 *
 * ─────────────────────────────────────────────────────────────
 * 이 파일은 유권자가 신뢰해야 하는 코드입니다. 그래서 일부러
 *   · 짧게 (60줄 남짓)
 *   · 라이브러리 없이 (브라우저 내장 Web Crypto 만 사용)
 *   · 난독화 없이
 * 썼습니다. 후보 캠프·참관인 누구나 읽고 검증할 수 있어야 합니다.
 *
 * 숨기는 것은 방어가 되지 않습니다. 공격자는 코드를 읽는 게 아니라
 * 바꿔치기하기 때문입니다. 그에 대한 방어는 난독화가 아니라
 * 빌드 해시를 사전 공고해서 누구나 대조할 수 있게 만드는 것입니다.
 * ─────────────────────────────────────────────────────────────
 *
 * 봉인된 표 = 일회용공개키(65) || nonce(12) || 암호문+태그(56) = 133 바이트
 *
 * 서버는 이 133바이트만 받습니다. 어떤 후보를 골랐는지 서버는 알 수 없고,
 * 선거 개인키(오프라인 보관)를 가진 선관위만 개표 때 열 수 있습니다.
 */

const HKDF_INFO_PREFIX = 'kma-ballot-v1';
const PLAINTEXT_LEN = 40;
const UUID_LEN = 36;

export const SEALED_BALLOT_LEN = 133;

/**
 * 후보 선택을 봉인한다.
 *
 * @param electionPublicKeyB64 선거 공개키 (base64url, 65바이트 비압축 P-256 점)
 * @param candidateId          후보 UUID, 기권이면 null
 * @returns base64 문자열 — 이대로 서버에 보낸다
 */
export async function sealBallot(
  electionPublicKeyB64: string,
  candidateId: string | null,
): Promise<string> {
  // ── 1. 평문 40바이트 구성 ──
  // 선택이든 기권이든 길이가 같아야 한다. 길이가 다르면
  // 암호문 크기만 재고도 기권 여부를 알 수 있다.
  const plaintext = new Uint8Array(PLAINTEXT_LEN);
  if (candidateId !== null) {
    if (candidateId.length !== UUID_LEN) throw new Error('후보 ID 형식이 올바르지 않습니다.');
    plaintext[0] = 1;
    for (let i = 0; i < UUID_LEN; i++) plaintext[1 + i] = candidateId.charCodeAt(i);
  }

  const electionPubRaw = base64UrlToBytes(electionPublicKeyB64);
  const electionKey = await crypto.subtle.importKey(
    'raw', electionPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );

  // ── 2. 이 표 하나만을 위한 일회용 키쌍 ──
  // 고정 키로 암호화하면 같은 후보를 찍은 표는 암호문도 같아진다.
  // 그러면 내용을 못 읽어도 암호문을 묶어 세는 것만으로 집계가 나온다.
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
  );
  const ephemeralPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  // ── 3. 키 합의 → AES 키 유도 ──
  // extractable: false 로 만들었으므로 일회용 개인키는 JS 가 꺼내볼 수 없고,
  // 이 함수가 끝나면 참조가 사라져 회수된다. 되살릴 방법이 없다.
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: electionKey }, ephemeral.privateKey, 256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const aesRaw = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemeralPub,
      // 선거 공개키를 섞어 다른 선거로 표를 옮겨 붙이지 못하게 한다.
      info: concat(textBytes(HKDF_INFO_PREFIX), electionPubRaw),
    },
    hkdfKey, 256,
  );
  const aesKey = await crypto.subtle.importKey('raw', aesRaw, 'AES-GCM', false, ['encrypt']);

  // ── 4. 암호화 ──
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext),
  );

  // ── 5. 조립 ──
  const sealed = concat(ephemeralPub, nonce, ciphertext);
  if (sealed.length !== SEALED_BALLOT_LEN) {
    throw new Error(`봉인 결과 길이가 예상과 다릅니다: ${sealed.length}`);
  }
  return bytesToBase64(sealed);
}

// ── 작은 유틸 ──

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function textBytes(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(s));
}

function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
