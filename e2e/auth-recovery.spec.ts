// 역할: 로그인 복구가 무실발송·접근 가능한 이메일 전용 모달로 동작하는지 브라우저에서 확인합니다.
import { expect, test, type Page } from "@playwright/test";

async function openRecovery(page: Page) {
  await blockExternalAuthRequests(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("paradays-locale", "en");
  });
  await page.goto("/login");

  const trigger = page.getByRole("button", { name: "Forgot your password?" });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Reset password" });
  await expect(dialog).toBeVisible();

  return { dialog, trigger };
}

async function blockExternalAuthRequests(page: Page) {
  const externalAuthRequests: string[] = [];

  await page.route(/https?:\/\/[^/]+/i, async (route) => {
    const hostname = new URL(route.request().url()).hostname;

    if (/amazonaws|cognito|firebase|googleapis/i.test(hostname)) {
      externalAuthRequests.push(route.request().url());
      await route.abort();
      return;
    }

    await route.continue();
  });

  return externalAuthRequests;
}

test("login keeps recovery details out of the page and shows an email-only dialog", async ({
  page,
}) => {
  const externalAuthRequests = await blockExternalAuthRequests(page);

  await page.addInitScript(() => {
    window.localStorage.setItem("paradays-locale", "en");
  });
  await page.goto("/login");

  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Find ID/i })).toHaveCount(0);

  const trigger = page.getByRole("button", { name: "Forgot your password?" });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Reset password" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      "Your PARADAYS login ID is the email used to sign up. Check your signup email.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "SMS verification is not available right now. Reset your password with your signup email.",
    ),
  ).toBeVisible();
  await expect(dialog.getByLabel("Email")).toBeFocused();
  await expect(
    dialog.getByText(
      "Online account recovery is not available right now. Try again after setup is complete or contact support.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Request password reset code" }),
  ).toBeDisabled();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  expect(externalAuthRequests).toEqual([]);
});

test("recovery keeps the Korean SMS-unavailable notice exact", async ({ page }) => {
  const externalAuthRequests = await blockExternalAuthRequests(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("paradays-locale", "ko");
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "비밀번호를 잊으셨나요?" }).click();

  const dialog = page.getByRole("dialog", { name: "비밀번호 재설정" });
  await expect(
    dialog.getByText(
      "문자 인증은 현재 제공하지 않습니다. 가입 이메일로 비밀번호를 재설정해 주세요.",
    ),
  ).toBeVisible();
  expect(externalAuthRequests).toEqual([]);
});

test("recovery dialog closes through its controls and restores trigger focus", async ({
  page,
}) => {
  const { dialog, trigger } = await openRecovery(page);

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page
    .locator("[data-account-recovery-scrim]")
    .click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("recovery dialog traps focus and remains within a 320px viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const { dialog } = await openRecovery(page);

  await dialog.getByRole("heading", { name: "Reset password" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByLabel("Email")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});
