import { test, expect } from '@playwright/test';

/**
 * 본인확인 경로. 통신사 명의를 대조해 **가족·직원 대리투표**를 막는 것이 목적이다.
 *
 *   npm run test:ui:identity
 *
 * 서버는 IDENTITY_VERIFICATION=optional 로 뜬다 (playwright.config.ts).
 * mock 연동이라 화면이 이름·생년월일·번호를 직접 받는다 — 실제 서비스에서는
 * PASS/NICE 인증 창이 열리고 이 값들이 통신사에서 자동으로 온다.
 */
const MEMBER = { name: '테스트0002', birth: '19520303', phone: '010-0000-0002' };

test('통신사 명의가 다르면 막히고, 본인이면 투표까지 간다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '본인확인' })).toBeVisible();

  await test.step('본인확인 시작', async () => {
    await page.getByRole('button', { name: '본인확인으로 진행' }).click();
    await expect(page.getByLabel('이름')).toBeVisible();
  });

  await test.step('명의자가 다른 사람이면 거부 — 대리투표 차단', async () => {
    // 번호도 생년월일도 맞지만 이름이 다르다 = 가족이 회원 폰을 들고 온 경우
    await page.getByLabel('이름').fill('김가족');
    await page.getByLabel('생년월일').fill(MEMBER.birth);
    await page.getByLabel('휴대폰번호').fill(MEMBER.phone);
    await page.getByRole('button', { name: '확인' }).click();

    await expect(page.getByText(/명의자가 해당 회원 본인이 아닙니다/)).toBeVisible();
    // 막혔으면 투표 화면으로 넘어가지 않아야 한다
    await expect(page.getByRole('heading', { name: '후보자를 선택해 주세요' })).toHaveCount(0);
  });

  await test.step('본인이면 통과해서 투표까지', async () => {
    // 거래는 1회용이라 처음부터 다시 시작한다 (재사용 방지가 동작하는지도 함께 본다)
    await page.reload();
    await page.getByRole('button', { name: '본인확인으로 진행' }).click();
    await page.getByLabel('이름').fill(MEMBER.name);
    await page.getByLabel('생년월일').fill(MEMBER.birth);
    await page.getByLabel('휴대폰번호').fill(MEMBER.phone);
    await page.getByRole('button', { name: '확인' }).click();

    // OTP 를 거치지 않고 바로 투표 화면 — 본인확인 서비스가 이미 문자 인증을 했다
    await expect(page.getByText('님으로 확인되었습니다')).toBeVisible();
    await expect(page.getByRole('heading', { name: '후보자를 선택해 주세요' })).toBeVisible();

    await page.getByRole('radio', { name: /김의준/ }).click();
    await page.getByRole('button', { name: '선택 완료' }).click();
    await page.getByRole('button', { name: '투표 제출' }).click();
    await expect(page.getByRole('heading', { name: '투표가 완료되었습니다' })).toBeVisible();
  });

  if (!process.env.CI) await page.waitForTimeout(2000);
});
