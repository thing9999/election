import {
  generateKeyPairSync,
  diffieHellman,
  createPublicKey,
  createPrivateKey,
  hkdfSync,
  createDecipheriv,
  timingSafeEqual,
  type KeyObject,
} from 'crypto';

/**
 * 투표지 개봉 (서버 측).
 *
 * **이 파일에 봉인 기능은 없다.** 봉인은 브라우저가 한다
 * (apps/web/src/lib/seal.ts). 서버가 봉인하면 평문이 TLS 종단·요청 로그·
 * 서버 메모리를 거치게 되고, 서버를 뚫은 사람은 개인키를 찾을 필요도 없이
 * 요청 핸들러에서 들어오는 표를 실시간으로 볼 수 있다.
 *
 * 곡선은 P-256 을 쓴다. X25519 가 더 현대적이지만 브라우저 Web Crypto 지원이
 * 최근이라 구형 기기에서 안 된다. 유권자 연령대를 생각하면 호환성이 우선이고,
 * P-256 을 쓰면 브라우저에 암호 라이브러리를 하나도 싣지 않아도 된다 —
 * 유권자가 믿어야 할 코드가 그만큼 줄어든다.
 *
 *   봉인된 표 = 일회용공개키(65) || nonce(12) || 암호문+태그(56) = 133 바이트
 */

const EPHEMERAL_PUBKEY_LEN = 65; // P-256 비압축 점: 0x04 || X(32) || Y(32)
const NONCE_LEN = 12;
const CIPHERTEXT_LEN = 56; // 평문 40 + GCM 태그 16

/**
 * 평문은 항상 40바이트다. 길이가 다르면 암호문 길이만 보고도 기권인지 구분된다.
 *   [0]      1 = 후보 선택, 0 = 기권
 *   [1..37]  후보 UUID (ASCII 36바이트)
 *   [37..40] 패딩
 */
const UUID_LEN = 36;

export const SEALED_BALLOT_LEN = EPHEMERAL_PUBKEY_LEN + NONCE_LEN + CIPHERTEXT_LEN; // 133

/** HKDF info. 브라우저 쪽과 반드시 같아야 한다. */
export const HKDF_INFO_PREFIX = 'kma-ballot-v1';

export interface ElectionKeyPair {
  /** base64url, 65바이트 비압축 점. 브라우저에 그대로 내려보낸다 */
  publicKey: string;
  /** base64url, PKCS8 DER. 서버에 저장하지 않는다 */
  privateKey: string;
}

/** 선거 생성 시 1회. 개인키는 즉시 오프라인으로 옮기고 서버에서 지운다. */
export function generateElectionKeyPair(): ElectionKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: rawPublicOf(publicKey).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

/** 개인키가 이 공개키의 짝인지 확인. 개표 때 엉뚱한 키로 시작하는 걸 먼저 걸러낸다. */
export function keyPairMatches(publicKeyB64: string, privateKeyB64: string): boolean {
  try {
    const derived = rawPublicOf(createPublicKey(importPrivate(privateKeyB64)));
    const given = Buffer.from(publicKeyB64, 'base64url');
    return derived.length === given.length && timingSafeEqual(derived, given);
  } catch {
    return false;
  }
}

/**
 * 봉인 해제.
 *
 * 실패하는 경우가 셋이다. 어느 쪽이든 예외를 던지고, 호출자가
 * "무효표로 세되 개표는 계속한다"를 결정한다 —
 * 여기서 조용히 null 을 돌려주면 훼손과 기권이 구분되지 않는다.
 *   1) 길이가 다르다        → 애초에 형식이 아니다
 *   2) 인증 태그 불일치      → 저장된 뒤 변조됐거나 남의 키로 봉인됐다
 *   3) 후보 UUID 가 이상하다 → 호출자가 명부와 대조해서 판단
 */
export function openBallot(
  electionPrivateKeyB64: string,
  electionPublicKeyB64: string,
  sealed: Uint8Array,
): string | null {
  if (sealed.length !== SEALED_BALLOT_LEN) {
    throw new Error(`봉인된 표의 길이가 올바르지 않습니다: ${sealed.length}`);
  }

  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.length);
  const ephemeralPub = buf.subarray(0, EPHEMERAL_PUBKEY_LEN);
  const nonce = buf.subarray(EPHEMERAL_PUBKEY_LEN, EPHEMERAL_PUBKEY_LEN + NONCE_LEN);
  const sealedBody = buf.subarray(EPHEMERAL_PUBKEY_LEN + NONCE_LEN);
  const ciphertext = sealedBody.subarray(0, sealedBody.length - 16);
  const tag = sealedBody.subarray(sealedBody.length - 16);

  const shared = diffieHellman({
    privateKey: importPrivate(electionPrivateKeyB64),
    publicKey: importRawPublic(ephemeralPub),
  });
  const key = deriveKey(shared, ephemeralPub, Buffer.from(electionPublicKeyB64, 'base64url'));

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  // 태그가 안 맞으면 여기서 예외가 난다.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (plaintext[0] === 0) return null; // 기권
  if (plaintext[0] !== 1) throw new Error('알 수 없는 투표지 형식입니다.');

  const uuid = plaintext.subarray(1, 1 + UUID_LEN).toString('ascii');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error('투표지에 담긴 값이 UUID 형식이 아닙니다.');
  }
  return uuid;
}

// ── 내부 ──

/**
 * ECDH 결과를 그대로 키로 쓰지 않고 HKDF 로 한 번 뽑는다.
 * salt 에 일회용 공개키를, info 에 선거 공개키를 넣어
 * 다른 선거의 표를 이 선거로 옮겨 붙이는 걸 막는다.
 */
function deriveKey(shared: Buffer, ephemeralPub: Buffer, electionPub: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      ephemeralPub,
      Buffer.concat([Buffer.from(HKDF_INFO_PREFIX), electionPub]),
      32,
    ),
  );
}

/** KeyObject → 65바이트 비압축 점 */
function rawPublicOf(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

/** 65바이트 비압축 점 → KeyObject */
function importRawPublic(raw: Buffer): KeyObject {
  if (raw.length !== EPHEMERAL_PUBKEY_LEN || raw[0] !== 0x04) {
    throw new Error('일회용 공개키 형식이 올바르지 않습니다.');
  }
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

function importPrivate(b64: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(b64, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
}
