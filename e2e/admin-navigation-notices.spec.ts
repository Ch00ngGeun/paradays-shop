// 역할: 매출 조회 실패·입력 검증·초안 저장 결과에 맞는 알림 심각도(색상)와 알림 의미를 검증함.
import { expect, test } from "@playwright/test";
import { noticeColors, operationRows } from "./admin-navigation-accessibility-fixtures";
import {
  active,
  audits,
  emptyReport,
  pending,
  PENDING_KEY,
  respond,
  select,
  setup,
} from "./admin-navigation-base-fixtures";
import {
  couponField,
  couponWorkspace,
  fillCoupon,
  savedCoupon,
} from "./admin-navigation-coupon-fixtures";
import { completeOverview } from "./admin-navigation-home-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 375, height: 844 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`notice severity: ${viewport.name} ${theme} distinguishes a red unresolved write lock from amber report review`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(
        (value) => localStorage.setItem("paradays-theme", value),
        theme,
      );
      const audit = await setup(page, {
        path: "/admin?section=sales",
        pending: true,
        handleSales: (route) =>
          respond(route, {
            report: { ...emptyReport, warnings: ["ONLINE_PAYMENT_RESULT_PENDING"] },
          }),
      });
      await page
        .getByRole("button", {
          name: "실제 운영 열기 · 실제 매출·일마감 열기",
          exact: true,
        })
        .click();
      const protection = page.getByRole("region", {
        name: "미확정 요청 보호",
        exact: true,
      });
      const blocking = protection.locator('[data-status="blocking"]');
      await expect(blocking).toHaveAttribute("data-severity", "danger");
      await expect(
        protection.getByRole("heading", { name: "처리 결과 확인 필요", exact: true }),
      ).toBeVisible();
      await expect(protection).toContainText(
        "입력 변경·다른 전표 처리·마감을 잠갔습니다",
      );
      await expect(protection.getByRole("alert")).toHaveCount(0);
      await page.getByRole("button", { name: "결과 재조회", exact: true }).click();
      const warning = page
        .getByLabel("마감 경고", { exact: true })
        .locator('[data-status="attention"]');
      await expect(warning).toHaveAttribute("data-severity", "warning");
      await expect(warning).toContainText("온라인 결제 결과가 확인 대기 중입니다");
      const expectedBackgrounds =
        theme === "light"
          ? ["rgb(254, 242, 242)", "rgb(255, 245, 214)"]
          : ["rgb(59, 24, 27)", "rgb(52, 39, 16)"];
      for (const [index, notice] of [blocking, warning].entries()) {
        const colors = await noticeColors(notice);
        expect(colors.background).toBe(expectedBackgrounds[index]);
        expect(colors.ratio).toBeGreaterThanOrEqual(4.5);
        console.log(
          `Notice severity ${viewport.name}/${theme}/${index}: ${JSON.stringify(colors)}`,
        );
      }
      await expect(
        page.locator('#admin-panel-sales [role="status"] > [data-status="neutral"]'),
      ).toBeVisible();
      await expect(
        page.locator('#admin-panel-sales [data-status="blocking"]'),
      ).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "판매 등록 · 새 전표", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "선택일 장부 마감", exact: true }),
      ).toBeDisabled();
      expect(
        await page.evaluate((key) => sessionStorage.getItem(key), PENDING_KEY),
      ).toBe(pending);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      const screenshot = testInfo.outputPath(
        `notice-severity-${viewport.name}-${theme}.png`,
      );
      await page.screenshot({ path: screenshot, fullPage: true });
      console.log(`Notice severity screenshot: ${screenshot}`);
      expect(audit.syntheticWrites).toEqual([]);
    });
  }
}

test("notice severity: an explicit ledger query failure is amber and a successful query returns to neutral", async ({
  page,
}) => {
  let failed = true;
  const audit = await setup(page, {
    path: "/admin?section=sales",
    handleSales: (route) =>
      failed
        ? respond(route, { code: "SYNTHETIC_QUERY_FAILED" }, 503)
        : respond(route, { report: emptyReport }),
  });
  await page
    .getByRole("button", {
      name: "실제 운영 열기 · 실제 매출·일마감 열기",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "장부 조회", exact: true }).click();
  const status = page.locator("#admin-panel-sales").getByRole("status");
  const attention = status.locator('[data-status="attention"]');
  await expect(attention).toContainText("장부를 조회하지 못했습니다");
  expect((await noticeColors(attention)).background).toBe("rgb(255, 245, 214)");
  await expect(page.locator('#admin-panel-sales [data-status="blocking"]')).toHaveCount(
    0,
  );
  failed = false;
  await page.getByRole("button", { name: "장부 조회", exact: true }).click();
  const neutral = status.locator('[data-status="neutral"]');
  await expect(neutral).toContainText("한국 시간 기준 장부를 조회했습니다");
  expect((await noticeColors(neutral)).background).toBe("rgb(241, 243, 245)");
  await expect(status).not.toContainText("완료");
  expect(audit.syntheticWrites).toEqual([]);
});

test("notice severity: validation keeps alert semantics, draft acknowledgements stay neutral and home attention remains honest", async ({
  page,
}) => {
  let uncertain = false;
  const audit = await setup(page, {
    path: "/admin?section=coupons",
    handleOverview: (route) => respond(route, completeOverview),
    handleCouponMutation: (route) =>
      uncertain
        ? respond(route, { code: "SYNTHETIC_UNCERTAIN" }, 503)
        : savedCoupon(route),
  });
  const panel = couponWorkspace(page);
  await panel
    .getByRole("form", { name: "쿠폰 초안 설정", exact: true })
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(
    panel.getByRole("alert").locator('[data-status="warning"]'),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
  await fillCoupon(page);
  await panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }).click();
  const acknowledgement = panel.getByRole("status").locator('[data-status="neutral"]');
  await expect(acknowledgement).toContainText("아직 고객에게 발급되지 않았습니다");
  await expect(acknowledgement).not.toContainText("완료");
  uncertain = true;
  await couponField(page, "쿠폰명 (필수)").fill("[TEST] Recheck draft");
  await panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }).click();
  await expect(
    panel.getByRole("alert").locator('[data-status="warning"]'),
  ).toBeVisible();
  await select(page, "overview");
  const activity = operationRows(page);
  await expect(activity).toHaveCount(1);
  await expect(activity).toHaveAttribute("data-status", "attention");
  const attention = activity.locator('[data-status="attention"]');
  await expect(attention).toHaveAttribute("data-severity", "warning");
  await expect(attention).toContainText("고객 발급 완료가 아닙니다");
  await expect(activity.locator("time")).toContainText("23:00");
  await expect(activity.getByRole("button", { name: /메뉴 보기/ })).toBeEnabled();
  await expect(activity.getByRole("alert")).toHaveCount(0);
  const colors = await noticeColors(attention);
  expect(colors.background).toBe("rgb(255, 245, 214)");
  expect(colors.ratio).toBeGreaterThanOrEqual(4.5);
  const stockTask = page
    .locator("#admin-panel-overview article")
    .filter({ has: page.getByRole("button", { name: "재고 확인", exact: true }) });
  await expect(stockTask.locator('[data-status="attention"]')).toHaveText("확인 필요");
  await expect(stockTask.locator("h3")).toContainText("4");
  await expect(
    page.locator(
      '#admin-panel-overview [data-status="urgent"], #admin-panel-overview [data-status="blocking"]',
    ),
  ).toHaveCount(0);
  expect(audit.syntheticWrites).toHaveLength(2);
  await activity.getByRole("button", { name: /메뉴 보기/ }).click();
  await active(page, "coupons");
});
