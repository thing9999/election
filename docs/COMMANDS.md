# 명령어 매뉴얼

이 저장소에서 쓰는 모든 명령입니다. **위험한 명령에는 표시**를 해뒀습니다.

- 명령은 전부 **저장소 최상위 폴더**에서 실행합니다
- `--workspace=apps/api` 가 붙은 것은 API 폴더의 스크립트를 호출한다는 뜻입니다
- 인자를 넘길 때는 **워크스페이스 스크립트를 직접** 부르고 `--` 를 한 번 더 넣습니다
  (예: `npm run totp --workspace=apps/api -- --id wi1`)

---

## 빠른 참조

| 하고 싶은 일 | 명령 |
|---|---|
| DB 켜기 | `npm run db` |
| 전부 띄우기 | `npm run dev` |
| 관리자만 띄우기 | `npm run dev:admin` |
| 시험 데이터 넣기 | `npm run seed` |
| 검증 전부 돌리기 | `npm run check` |
| 브라우저로 눈으로 보기 | `npm run test:ui` |
| 관리자 계정 만들기 | `npm run admin:create --workspace=apps/api -- --id kim --name 김위원` |
| 인증 앱 코드 확인 | `npm run totp --workspace=apps/api -- --id kim` |

---

## 1. 처음 한 번만

### 1-1. 설치

```bash
npm install
```

### 1-2. 환경 파일 만들기

```bash
cp apps/api/.env.example apps/api/.env
```

그다음 `apps/api/.env` 에서 아래 두 값을 채웁니다. **비워두면 서버가 뜨지 않습니다.**

```bash
openssl rand -hex 32     # VOTER_ID_PEPPER 용
openssl rand -hex 32     # JWT_SECRET 용
```

> `VOTER_ID_PEPPER` 는 명부 해시에 쓰는 값입니다. **이 값이 바뀌면 기존 명부로 로그인할 수 없습니다.**
> 운영에서는 DB 와 다른 곳(KMS 등)에 보관하세요.

### 1-3. DB 띄우기 — 터미널 1

```bash
npm run db
```

Docker 없이 `node_modules` 안의 PostgreSQL 을 그대로 띄웁니다 (`127.0.0.1:5433`).
데이터는 `apps/api/.pgdata` 에만 쌓입니다. **이 터미널은 계속 켜둡니다.**

출력된 `DATABASE_URL` / `DIRECT_URL` 두 줄을 `.env` 에 붙여넣습니다.

### 1-4. 스키마와 DB 권한 — 터미널 2

```bash
npm run prisma:deploy --workspace=apps/api
```

스키마를 적용하고 **앱 전용 DB 계정을 만들어 권한을 깎습니다.**
출력된 `DATABASE_URL` 로 `.env` 의 `DATABASE_URL` 만 교체합니다 (`DIRECT_URL` 은 소유자 그대로).

```bash
npm run privilege:check --workspace=apps/api    # 실제로 막혔는지 확인
```

### 1-5. 시험 데이터

```bash
npm run seed
```

유권자 1,000명, 후보 3명, 관리자 계정(`wi1`·`wi2`·`gam1`)이 만들어집니다.
**개표키가 한 번 출력되니 복사해 두세요.**

---

## 2. 개발 중 매일 쓰는 것

```bash
npm run db          # 터미널 1 — DB (계속 켜둠)
npm run dev         # 터미널 2 — API + 유권자 화면 + 관리자 화면
```

| 명령 | 띄우는 것 | 주소 |
|---|---|---|
| `npm run dev` | 전부 | API `:4000` · 유권자 `:5173` · 관리자 `:5174` |
| `npm run dev:voter` | API + 유권자 화면 | `:4000` · `:5173` |
| `npm run dev:admin` | API + 관리자 화면 | `:4000` · `:5174` |

개별로 띄우려면 `npm run start:api` / `start:voter` / `start:admin` 을 씁니다.

### 시험 데이터 다시 넣기

```bash
npm run seed                                          # 유권자 1,000명 (기본)
VOTER_COUNT=10000 npm run seed --workspace=apps/api   # 1만 명
```

> `seed` 는 **기존 시험 선거를 지우고 새로 만듭니다.** 실제 데이터가 있는 DB 에서 돌리지 마세요.

시험 계정: 휴대폰 `010-0000-0001` / 생년월일 `19510202` / 이름 `테스트0001`
인증번호는 문자 대신 `apps/api/.dev-otp/` 폴더에 파일로 떨어집니다.

---

## 3. 검증

### 전부 한 번에

```bash
npm run check
```

**DB(`npm run db`) 말고는 미리 띄울 것이 없습니다.** API 빌드·기동·시드·정리까지 스크립트가 합니다.
검증 8종 208개 항목이 순서대로 돌고, 하나가 실패해도 나머지를 계속 진행합니다.

| 순서 | 묶음 | 항목 |
|---|---|---|
| 1 | DB 권한 분리 | 19 |
| 2 | 봉인 · 개표키 분산 | 20 |
| 3 | 변조 탐지 | 16 |
| 4 | 본인확인 · 완료문자 · 명부확정 | 30 |
| 5 | 전 과정 E2E | 66 |
| 6 | 관리자 화면 API | 24 |
| 7 | 감사 로그 반출 | 3 |
| 8 | 블록체인 고정 | 30 |

### E2E 만

```bash
npm run test:e2e

# 빌드 건너뛰기 (앞서 한 번 빌드했다면 빠릅니다)
npm run e2e:env --workspace=apps/api -- --no-build
```

> 인자를 넘길 때는 **워크스페이스 스크립트를 직접** 불러야 합니다.
> `npm run test:e2e -- --no-build` 는 중첩된 `npm run` 을 거치면서 인자가 끊겨 전달되지 않습니다.

### 브라우저를 띄워서 눈으로

```bash
npm run test:ui            # 투표 전 과정 — 창이 뜨고 천천히 클릭합니다
npm run test:ui:identity   # 본인확인 (대리투표 차단까지)
```

`CI=1` 을 앞에 붙이면 창 없이 돌고 실패 시 영상·트레이스를 남깁니다.

### 개별 검증

```bash
npm run crypto:check    --workspace=apps/api   # 봉인 규격 + 개표키 분산
npm run tamper:check    --workspace=apps/api   # 조작 탐지
npm run identity:check  --workspace=apps/api   # 본인확인 · 완료문자 · 명부확정
npm run privilege:check --workspace=apps/api   # DB 권한
npm run audit:check     --workspace=apps/api   # 감사 로그 반출
npm run chain:check     --workspace=apps/api   # 블록체인 고정 (가짜 노드로, 체인 불필요)
npm run e2e             --workspace=apps/api   # 전 과정
npm run admin:check     --workspace=apps/api   # 관리자 API
```

| 검증 | DB | API 서버 |
|---|---|---|
| `crypto:check` · `chain:check` | 불필요 | 불필요 |
| `tamper:check` · `identity:check` · `privilege:check` · `audit:check` | **필요** | 불필요 |
| `e2e` · `admin:check` | **필요** | **필요** |

> `npm run e2e --workspace=apps/api` 를 그냥 돌리면 **429(요청 제한)** 가 납니다. 유권자 40명을 연속 인증하기 때문입니다.
> `npm run test:e2e` 를 쓰세요 — 검증용으로만 제한을 풀고 끝나면 정리합니다.

### 부하 측정

```bash
VOTER_COUNT=10000 npm run seed --workspace=apps/api
LOAD_N=500 npm run load --workspace=apps/api
```

| 환경변수 | 뜻 | 기본값 |
|---|---|---|
| `LOAD_N` | 동시에 던질 표 수 | 300 |
| `LOAD_LOGIN_CONCURRENCY` | 동시 로그인 수 | 25 |

---

## 4. 관리자 계정

**계정을 만드는 화면이나 API 는 일부러 없습니다.** 서버 접근 권한이 있는 사람만 만들 수 있습니다.

```bash
npm run admin:create --workspace=apps/api -- --id kim  --name 김위원 --role COMMISSIONER
npm run admin:create --workspace=apps/api -- --id lee  --name 이참관 --role AUDITOR
```

| 인자 | 뜻 | 기본값 |
|---|---|---|
| `--id` | 로그인 아이디 (필수) | — |
| `--name` | 표시 이름 (필수) | — |
| `--role` | `COMMISSIONER`(선관위원) 또는 `AUDITOR`(참관인) | `COMMISSIONER` |

임시 비밀번호가 **한 번만 출력되고 다시 볼 수 없습니다.**
비밀번호를 인자로 받지 않는 것은 셸 기록과 프로세스 목록에 남기 때문입니다.

### 인증 앱 코드 확인 (개발용)

```bash
npm run totp --workspace=apps/api -- --id kim
```

지금 유효한 6자리 코드를 출력합니다. **운영에서는 쓰지 마세요** — 2차 인증의 의미가 사라집니다.

---

## 5. 개표키

선거 생성 시 개표키가 **한 번만** 표시됩니다. 놓치면 개표가 영구히 불가능합니다.

### 나누기 — 선거 생성 직후

```bash
npm run key:split --workspace=apps/api -- --n 5 --k 3 --public-key <선거 공개키>
```

| 인자 | 뜻 | 기본값 |
|---|---|---|
| `--n` | 조각 개수 | 5 |
| `--k` | 복원에 필요한 개수 | 3 |
| `--public-key` | 선거 공개키 (넣으면 짝이 맞는지 확인) | 없음 |

조각을 **한 사람에게 하나씩** 나눠주고, **전달 경로도 나누고**, **원본 개표키를 파기**합니다.

### 합치기 — 개표 당일

```bash
npm run key:combine --workspace=apps/api -- --public-key <선거 공개키>
```

조각을 한 줄씩 붙여넣고 다 넣으면 빈 줄을 입력합니다.
복원된 키는 **화면에만** 나오고 저장되지 않습니다.

> 두 명령 모두 **네트워크를 쓰지 않고 DB 에 붙지 않습니다.** 인터넷이 끊긴 노트북에서 돌려도 됩니다.
> 서버가 조각을 받으면 그 순간 서버가 개표키를 아는 것이 되어 분산의 의미가 사라집니다.

---

## 5-2. 블록체인 고정

`ANCHOR_TARGETS` 에 `BLOCKCHAIN` 을 넣으면 개시·마감·개표 때 자동으로 고정됩니다.
따로 실행할 명령은 없습니다. 아래는 확인용입니다.

```bash
# 우리가 보내는 트랜잭션이 맞는지 (가짜 노드로 확인, 실제 체인 불필요)
npm run chain:check --workspace=apps/api

# 선거 후 대조 — 체인에서 읽어와 지금 DB 와 맞춰봅니다
npm run anchor:verify --workspace=apps/api -- --election <선거 id>
npm run anchor:verify --workspace=apps/api -- --election <선거 id> --rpc https://...
```

| 인자 | 뜻 |
|---|---|
| `--election` | 선거 id (필수) |
| `--rpc` | 쓸 노드 주소. 없으면 `ANCHOR_CHAIN_RPC` |

`--rpc` 로 **자기가 믿는 노드**를 지정할 수 있습니다. 참관인이 협회 노드를 거치지 않고
확인할 수 있어야 하기 때문입니다.

일치하면 종료코드 0, 하나라도 다르면 1 입니다.

> 실제 체인에 붙이기 전에 **테스트넷에서 한 번 리허설**하세요.
> `chain:check` 는 우리 쪽 코드만 검증합니다 — 노드 접속·수수료·확정 시간은 대신해 주지 않습니다.

---

## 6. DB 관리

```bash
npm run db                                        # 띄우기
npm run db:local --workspace=apps/api -- --reset  # ⚠ 데이터를 전부 지우고 다시 초기화
```

### 스키마 변경 후

```bash
npm run prisma:deploy --workspace=apps/api    # 마이그레이션 + 권한 재적용
```

> **권한 재적용이 함께 묶여 있습니다.** 새로 만든 테이블은 아무 권한도 없는 상태로 시작하므로
> (fail closed), 재적용하지 않으면 앱이 그 테이블을 읽지 못합니다.
> 새 테이블이 있으면 `scripts/db-privileges.ts` 의 권한 표에 먼저 적어야 하고,
> 안 적으면 **스크립트가 멈춥니다** — 모르는 채로 열어주지 않습니다.

```bash
npm run prisma:generate --workspace=apps/api  # 타입 다시 생성
npm run db:privileges   --workspace=apps/api  # 권한만 다시 적용
npm run privilege:check --workspace=apps/api  # 실제로 막혔는지 확인
```

| 환경변수 | 뜻 | 기본값 |
|---|---|---|
| `APP_DB_ROLE` | 앱 전용 계정 이름 | `kma_app` |
| `APP_DB_PASSWORD` | 비밀번호 (비우면 만들어서 한 번 출력) | 없음 |

> `prisma generate` 는 **API 서버를 먼저 끄고** 실행하세요. 실행 중이면 파일이 잠겨 실패합니다.

---

## 7. 빌드

```bash
npm run build                        # API + 유권자 + 관리자 전부
npm run build --workspace=apps/api   # API 만
```

---

## 8. 자주 막히는 곳

| 증상 | 원인과 해결 |
|---|---|
| `VOTER_ID_PEPPER 가 비어 있습니다` | `.env` 를 안 채웠습니다. 1-2 참조 |
| `DB 에 연결할 수 없습니다` | `npm run db` 를 안 띄웠습니다 |
| `429 Too Many Requests` | `npm run e2e --workspace=apps/api` 대신 `npm run test:e2e` 를 쓰세요 |
| 포트 4000 이 이미 사용 중 | 이전 서버가 남아 있습니다. `npm run check` / `test:e2e` 는 알아서 정리합니다 |
| `prisma generate` 실패 | API 서버를 먼저 끄세요 |
| 로그인이 갑자기 전부 실패 | `VOTER_ID_PEPPER` 가 바뀌었습니다. 되돌리거나 `npm run seed` 로 명부를 다시 만드세요 |
| 관리자 TOTP 가 계속 거부됨 | 같은 코드를 두 번 쓸 수 없습니다(정상 동작). 30초 기다렸다 새 코드로 |
| `명부가 이미 확정(봉인)되었습니다` | 확정 후에는 명부를 못 바꿉니다. 새 선거를 만드세요 |

### 포트를 직접 정리해야 할 때

```powershell
Get-NetTCPConnection -LocalPort 4000 -State Listen | ForEach-Object { taskkill /PID $_.OwningProcess /T /F }
```

---

## 9. 위험한 명령

| 명령 | 무슨 일이 일어나나 |
|---|---|
| `npm run db:local --workspace=apps/api -- --reset` | **DB 데이터를 전부 삭제**하고 초기화합니다 |
| `npm run seed` | **기존 시험 선거를 삭제**하고 새로 만듭니다 |
| `npm run check` / `test:e2e` | 시드를 다시 깔고, 포트 4000 의 프로세스를 종료합니다 |
| `npm run totp --workspace=apps/api` | 2차 인증 코드를 그대로 출력합니다. 개발 전용 |

**운영 DB 를 가리키는 `.env` 로는 위 명령을 실행하지 마세요.**

---

## 10. 운영 배포 시 확인

`npm run check` 는 개발 환경 기준입니다. 운영에서는 아래를 별도로 확인하세요.

- [ ] `SMS_PROVIDER` 가 `mock` 이 아닌가
- [ ] `IDENTITY_PROVIDER` 가 `mock` 이 아닌가 (본인확인을 쓴다면)
- [ ] `DATABASE_URL` 이 권한을 깎은 계정인가 (`DIRECT_URL` 과 다른가)
- [ ] `DIRECT_URL` 이 앱 서버에 없는가
- [ ] `ANCHOR_TARGETS` 에 `FILE` 말고 다른 것이 있는가
- [ ] `AUDIT_SINKS` 가 켜져 있고, 반출본이 **서버 밖으로** 복제되는가
- [ ] `TALLY_QUORUM` 이 2 이상인가
- [ ] (블록체인을 쓴다면) `ANCHOR_CHAIN_ID` 가 실제 체인과 맞는가
- [ ] (블록체인을 쓴다면) 고정용 지갑에 **잔액이 있는가**
- [ ] (블록체인을 쓴다면) 지갑 키가 개발 도구의 공개 시드 키가 아닌가
- [ ] `E2E_RELAXED_THROTTLE` 이 설정되어 있지 않은가
      (설정된 채 `NODE_ENV=production` 이면 서버가 기동을 거부합니다)

---

## 부록. 직접 부를 일이 드문 것

| 명령 | 언제 쓰나 |
|---|---|
| `npm run start --workspace=apps/api` | 빌드된 API 를 실행합니다 (`node dist/main.js`). 운영 기동과 브라우저 테스트가 내부적으로 씁니다 |
| `npm run check:env --workspace=apps/api` | `npm run check` 가 부르는 실체입니다. 인자를 넘길 때만 직접 부르세요 |
| `npm run prisma:migrate --workspace=apps/api` | 스키마를 바꾸고 **새 마이그레이션 파일을 만들 때**. 대화형이라 CI 에서는 못 씁니다. 적용만 할 때는 `prisma:deploy` 를 쓰세요 |
| `npm run e2e:env --workspace=apps/api` | `npm run test:e2e` 가 부르는 실체입니다 (`--no-build` · `--all` 지원) |

> `prisma:migrate` 로 만든 마이그레이션은 **`apps/api/prisma/migrations/` 안에 생기는지 확인**하세요.
> 실행 위치에 따라 저장소 최상위에 만들어지는 경우가 있습니다.

관련 문서: [06. 관리자와 운영](06-admin-operations.md) · [08. 남은 것](08-remaining.md)
