import { createHmac, randomInt, timingSafeEqual } from 'crypto';

/**
 * 회원번호·휴대폰번호는 평문으로 저장하지 않는다.
 * pepper 는 DB 가 아닌 별도 시크릿 저장소(KMS 등)에 둔다.
 * DB 만 유출되어도 "이 회원번호가 명부에 있는가"를 확인할 수 없어야 한다.
 */
export function hashIdentifier(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(normalize(value)).digest('hex');
}

/**
 * 생년월일을 YYYYMMDD 로 정규화한다.
 * "1975-03-14", "1975.3.14", "19750314" 모두 받아준다 —
 * 고령 유권자가 구분자를 어떻게 넣든 통과해야 한다.
 */
export function normalizeBirthDate(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length !== 8) {
    throw new Error('생년월일은 8자리(YYYYMMDD)여야 합니다.');
  }
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const now = new Date().getFullYear();
  if (year < 1900 || year > now || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('생년월일이 올바르지 않습니다.');
  }
  return digits;
}

/** "010-1234-5678", "01012345678", "+821012345678" → "+821012345678" */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('82')) return `+${digits}`;
  if (digits.startsWith('0')) return `+82${digits.slice(1)}`;
  return `+82${digits}`;
}

function normalize(v: string): string {
  return v.trim().replace(/\s+/g, '').toUpperCase();
}

/** 6자리 OTP. Math.random 이 아닌 CSPRNG 를 쓴다. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 타이밍 공격 방지 비교 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function maskName(name: string): string {
  if (name.length <= 1) return name;
  if (name.length === 2) return name[0] + '*';
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
}

/** 감사 로그용 - 전체 IP 대신 /24 프리픽스만 남긴다 */
export function ipPrefixOf(ip?: string): string | undefined {
  if (!ip) return undefined;
  const v4 = ip.replace(/^::ffff:/, '');
  const parts = v4.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  return v4.split(':').slice(0, 3).join(':') + '::/48';
}
