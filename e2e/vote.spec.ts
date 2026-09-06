import { test, expect, type Page } from '@playwright/test';
import { readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

/**
 * 유권자 한 명이 실제 브라우저에서 투표하는 전 과정.
 *
 * 시드 계정: 010-0000-0001 / 19510202  (prisma/seed.ts)
 * 인증번호는 mock SMS 가 파일로 떨궈두므로 그걸 읽는다.
 */
const PHONE = '010-0000-0001';
const BIRTH = '19510202';
const CANDIDATE = '김의준';

const OTP_FILE = join(__dirname, '..', 'apps', 'api', '.dev-otp', '821000000001.txt');

/** mock SMS 가 인증번호를 떨굴 때까지 기다린다 */
async function readOtp(page: Page): Promise<string> {
  for (let i = 0; i < 40; i++) {
    if (existsSync(OTP_FILE)) {
      const code = readFileSync(OTP_FILE, 'utf8').trim();
      if (/^\d{6}$/.test(code)) return code;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `인증번호 파일을 찾지 못했습니다: ${OTP_FILE}\n` +
      '  SMS_PROVIDER 가 mock 인지, 시드가 실행됐는지 확인하세요 (npm run seed).',
  );
}

test('유권자가 투표를 마치고, 서버로 나간 것은 봉인된 133바이트뿐이다', async ({ page }) => {
  // 실제로 나간 요청 본문을 붙잡는다. 화면만 보면 "봉인해서 보냈다"를 믿는 수밖에 없다.
  let sent: { sealedVote?: string } | null = null;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/vote')) {
      try { sent = JSON.parse(req.postData() ?? '{}'); } catch { /* 무시 */ }
    }
  });

  await test.step('선거 화면 진입', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('협회장 선거');
  });

  await test.step('본인 확인 — 휴대폰 + 생년월일', async () => {
    // 지난 실행의 인증번호가 남아 있으면 그걸 읽어버린다
    rmSync(OTP_FILE, { force: true });
    await page.getByLabel('휴대폰번호').fill(PHONE);
    await page.getByLabel('생년월일').fill(BIRTH);
    await page.getByRole('button', { name: '인증번호 받기' }).click();
    await expect(page.getByRole('heading', { name: '인증번호 입력' })).toBeVisible();
    // 인증 전에는 이름을 보여주지 않는다 (명부가 새어나가면 안 된다)
    await expect(page.locator('body')).not.toContainText('님으로 확인되었습니다');
  });

  await test.step('인증번호 입력', async () => {
    const code = await readOtp(page);
    await page.locator('form input').fill(code);
    await page.getByRole('button', { name: '확인' }).click();
    // 인증을 통과한 뒤에야 마스킹된 이름을 알려준다
    await expect(page.getByText('님으로 확인되었습니다')).toBeVisible();
  });

  await test.step('후보 선택', async () => {
    await page.getByRole('radio', { name: new RegExp(CANDIDATE) }).click();
    await page.getByRole('button', { name: '선택 완료' }).click();
    await expect(page.getByRole('heading', { name: '제출 전 최종 확인' })).toBeVisible();
    await expect(page.getByText(CANDIDATE)).toBeVisible();
  });

  await test.step('제출 — 이 순간 브라우저가 봉인한다', async () => {
    await page.getByRole('button', { name: '투표 제출' }).click();
    await expect(page.getByRole('heading', { name: '투표가 완료되었습니다' })).toBeVisible();
  });

  await test.step('나간 것이 정말 봉인된 133바이트인지', async () => {
    expect(sent, '/api/vote 요청을 잡지 못했습니다').not.toBeNull();
    const body = sent as { sealedVote?: string };

    // 후보 id 나 이름이 평문으로 나갔다면 봉인이 의미가 없다
    const raw = JSON.stringify(body);
    expect(raw, '후보 이름이 평문으로 전송됨').not.toContain(CANDIDATE);
    expect(Object.keys(body), '예상 밖의 필드가 함께 전송됨').toEqual(['sealedVote']);

    const bytes = Buffer.from(body.sealedVote ?? '', 'base64');
    expect(bytes.length, '봉인 길이가 규격과 다름').toBe(133);

    console.log(`\n  서버로 나간 것: ${bytes.length}바이트`);
    console.log(`  ${bytes.toString('hex').slice(0, 64)}…\n`);
  });

  await test.step('확인번호에는 후보가 담겨 있지 않다', async () => {
    const receipt = (await page.getByText(/^[A-Z2-9]{8}$/).first().innerText()).trim();
    expect(receipt).toHaveLength(8);
    expect(receipt).not.toContain(CANDIDATE);
    console.log(`  투표 확인번호: ${receipt}\n`);
  });

  // 결과를 눈으로 볼 시간
  if (!process.env.CI) await page.waitForTimeout(2500);
});
