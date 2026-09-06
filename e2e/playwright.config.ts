import { defineConfig } from '@playwright/test';
import { join } from 'path';

const ROOT = join(__dirname, '..');

/**
 * 눈으로 보는 검증.
 *
 *   npm run test:ui
 *
 * scripts/e2e.ts 는 HTTP 로만 두드리므로 **화면이 실제로 그렇게 동작하는지**는
 * 증명하지 못한다. 특히 봉인은 브라우저에서 일어나므로, 진짜 브라우저에서
 * 진짜 Web Crypto 로 돌아가는 걸 한 번은 봐야 한다.
 *
 * 그래서 이 테스트는 **일부러 headless 가 아니다.** 창을 띄우고 천천히 움직인다.
 * CI 에서 돌릴 거라면 CI=1 로 headless 가 된다.
 */
const VISIBLE = !process.env.CI;

export default defineConfig({
  testDir: __dirname,
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    headless: !VISIBLE,
    // 사람이 따라갈 수 있는 속도로. 검증이 아니라 관찰이 목적이다.
    launchOptions: VISIBLE ? { slowMo: 450 } : {},
    viewport: { width: 1100, height: 900 },
    trace: 'retain-on-failure',
    video: VISIBLE ? 'off' : 'retain-on-failure',
  },

  // DB(`npm run db`) 말고는 미리 띄울 게 없다. 이미 떠 있으면 그대로 쓴다.
  webServer: [
    {
      command: 'npm run start --workspace=apps/api',
      cwd: ROOT,
      url: 'http://127.0.0.1:4000/api/elections/current',
      // 본인확인 경로까지 화면으로 확인할 수 있게 optional 로 띄운다.
      // optional 이면 OTP 경로도 그대로 열려 있어 기존 테스트에 영향이 없다.
      // (:4000 에 이미 다른 설정의 서버가 떠 있으면 그걸 재사용하므로,
      //  본인확인 테스트가 안 되면 그 서버를 먼저 내리세요)
      env: { IDENTITY_VERIFICATION: 'optional', IDENTITY_PROVIDER: 'mock' },
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev --workspace=apps/web',
      cwd: ROOT,
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
