import { expect, test, type Page } from "@playwright/test";
import { ACTUAL_MODE, audits, setup } from "./admin-sales-ledger-fixtures";

test.afterEach(async ({ page }) => {
  const state = audits.get(page);
  if (state) {
    expect(state.forbidden).toEqual([]);
    expect(state.unexpected).toEqual([]);
  }
});

const guideRing = (page: Page) => page.locator("[data-modal-layer] svg > rect[rx='8']");

const guideLines = (page: Page) => page.locator("[data-modal-layer] svg > line");

test("sales screen guide shows only the mode step before a mode is chosen", async ({
  page,
}) => {
  await setup(page, { mode: "choose" });
  const open = page.getByRole("button", { name: "화면 도움말", exact: true });
  await open.click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("1/1단계");
  await expect(bubble.getByRole("heading")).toHaveText("연습 또는 실제");
  await expect(guideRing(page)).toHaveCount(1);
  await bubble.getByRole("button", { name: "완료", exact: true }).click();
  await expect(bubble).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("sales screen guide walks the day, a new sale and the daily close in the real ledger", async ({
  page,
}) => {
  await setup(page);
  const open = page.getByRole("button", { name: "화면 도움말", exact: true });
  await open.click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("1/3단계");
  await expect(bubble.getByRole("heading")).toHaveText("날짜 고르기");
  // The day input is underlined right below it.
  const day = page.locator('[data-admin-guide="sales.day"]');
  await expect
    .poll(async () => {
      const target = (await day.boundingBox())!;
      const line = (await guideLines(page).first().boundingBox())!;
      return Math.abs(line.y - (target.y + target.height)) <= 6;
    })
    .toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("판매 적기");
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("하루 마감");
  await expect(bubble.getByRole("button", { name: "완료", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bubble).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("sales screen guide closes when browser Back leaves the menu and reopens after Forward", async ({
  page,
}) => {
  await setup(page);
  const open = page.getByRole("button", { name: "화면 도움말", exact: true });
  await open.click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("1/3단계");
  // Back hides the sales panel; a guide left behind would sit on an empty screen.
  const ledger = page.getByRole("heading", { name: "매출·일마감 관리" });
  await page.goBack();
  await expect(ledger).toBeHidden();
  await expect(bubble).toHaveCount(0);
  await page.goForward();
  await expect(ledger).toBeVisible();
  await expect(bubble).toHaveCount(0);
  await open.click();
  await expect(bubble).toContainText("1/3단계");
  await expect(bubble.getByRole("heading")).toHaveText("날짜 고르기");
});

test("sales guide button stays on one line at 375px and fits 320px in English", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await setup(page, { mode: "choose" });
  const korean = page.getByRole("button", { name: "화면 도움말", exact: true });
  // One line: the button is no taller than its 44px target.
  expect((await korean.boundingBox())!.height).toBeLessThanOrEqual(46);
  // Even squeezed like in a crowded narrow header, the label does not break onto a second line.
  await korean.evaluate((button) => {
    button.style.width = "70px";
  });
  expect((await korean.boundingBox())!.height).toBeLessThanOrEqual(46);
  await korean.evaluate((button) => {
    button.style.width = "";
  });

  await page.setViewportSize({ width: 320, height: 760 });
  await page.getByRole("button", { name: "영어", exact: true }).click();
  const english = page.getByRole("button", { name: "Screen help", exact: true });
  await expect(english).toBeVisible();
  expect((await english.boundingBox())!.height).toBeLessThanOrEqual(46);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: /Open real operations/ }).click();
  await expect(english).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("sales help opens on demand while the stock warnings stay visible", async ({
  page,
}) => {
  await setup(page, { mode: "choose" });
  // The real-operations warning stays; only the pointer to earlier requests moved behind '?'.
  await expect(
    page.getByText("판매를 확정하면 실제 재고가 차감됩니다.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("기존 미확정 요청은 실제 운영에서 확인합니다."),
  ).toHaveCount(0);
  const help = page.getByRole("button", { name: "실제 운영 도움말", exact: true });
  await help.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("기존 미확정 요청은 실제 운영에서 확인합니다.");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(help).toBeFocused();
  // Opening the real ledger still works afterwards.
  await page.getByRole("button", { name: ACTUAL_MODE, exact: true }).click();
  await expect(page.getByRole("heading", { name: "매출·일마감 관리" })).toBeVisible();
});
