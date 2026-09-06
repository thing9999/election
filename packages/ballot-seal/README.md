# ballot-seal

투표지 봉인 규격. **브라우저가 봉인하고 서버가 개봉하므로 양쪽이 같은 형식을 봐야 합니다.**
사본을 두면 갈라지는 순간 아무도 모르게 개표가 깨지므로, 한 파일만 둡니다.

- `seal.ts` — 봉인 (Web Crypto 만 사용. 브라우저와 Node 양쪽에서 동일하게 실행)
- 개봉은 서버 전용이라 `apps/api/src/common/ballot-crypto.ts` 에 있습니다.

이 디렉터리에 `package.json` 을 두지 않은 것은 의도된 것입니다 —
`apps/web` 은 ESM, `apps/api` 는 CommonJS 라 어느 한쪽 모듈 형식을 선언하면
반대쪽에서 불러올 수 없습니다. 상대 경로로 소스를 직접 가져다 각자 컴파일합니다.
