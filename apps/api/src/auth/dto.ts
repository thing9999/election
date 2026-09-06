import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class RequestOtpDto {
  @IsUUID()
  electionId!: string;

  @Matches(/^[0-9+\-\s()]{9,20}$/, { message: '휴대폰번호 형식이 올바르지 않습니다.' })
  phone!: string;

  /** 생년월일 8자리. 구분자(- . /)는 있어도 된다 */
  @Matches(/^[0-9\-.\/\s]{8,12}$/, { message: '생년월일은 8자리(예: 19750314)로 입력해 주세요.' })
  birthDate!: string;
}

export class VerifyOtpDto {
  @IsUUID()
  challengeId!: string;

  @Matches(/^[0-9]{6}$/, { message: '인증번호는 6자리 숫자입니다.' })
  code!: string;

  /**
   * 인증번호 요청 때 서버가 준 토큰. 그대로 돌려주면 된다.
   * 투표 완료 문자를 보낼 번호가 여기 들어 있다 — 없으면 문자만 못 갈 뿐 투표는 된다.
   */
  @IsOptional()
  @IsString()
  challengeToken?: string;
}

export class IdentityBeginDto {
  @IsUUID()
  electionId!: string;
}

export class IdentityCompleteDto {
  @IsUUID()
  electionId!: string;

  @IsUUID()
  txId!: string;

  /**
   * 본인확인 서비스가 콜백으로 준 결과.
   * 실제 서비스에서는 암호문이고, mock 에서는 { name, birthDate, phone } 이다.
   * 형태가 서비스마다 다르므로 여기서 구조를 못박지 않는다 — provider 가 검증한다.
   */
  @IsOptional()
  payload?: unknown;
}
