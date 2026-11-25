// 역할: 쿠폰 초안의 미리보기·저장·입력 제한·중복 제출·불확실한 저장과 모바일·테마·화면 안내를 검증함.
import { expect, test } from "@playwright/test";
import { boxOf, guideLines } from "./admin-navigation-accessibility-fixtures";
import { audits, respond, setup } from "./admin-navigation-base-fixtures";
import {
  couponField,
  couponWorkspace,
  fillCoupon,
  savedCoupon,
} from "./admin-navigation-coupon-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("coupon redesign: editing the live ticket never issues a coupon or loads fabricated recipient counts", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, { path: "/admin?section=coupons" });
  const panel = couponWorkspace(page);
  await expect(
    panel.getByRole("heading", { name: "쿠폰 만들기", exact: true }),
  ).toBeVisible();
  const preview = panel.getByRole("complementary", {
    name: "쿠폰 고객 노출 미리보기",
    exact: true,
  });
  await expect(preview).toContainText("초안 예시 · 사용 불가");
  await fillCoupon(page, { code: "test-preview_10", date: "2026-10-30T18:30" });
  await expect(preview).toContainText("10%");
  await expect(preview).toContainText("[TEST] Welcome coupon");
  await expect(preview).toContainText("TEST-PREVIEW_10");
  await expect(preview).toContainText("2026-10-30 18:30 (한국 시간)");
  await expect(preview).toContainText("아직 발급되지 않았습니다");
  // 예전 머리말 도움말 내용은 "혜택 설정" 옆 '?'에 있음.
  await expect(panel.locator("summary", { hasText: /^도움말$/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "혜택 설정 도움말", exact: true }).click();
  const benefitHelp = page.getByRole("dialog", {
    name: "혜택 설정 도움말",
    exact: true,
  });
  await expect(
    benefitHelp.getByText(
      /대상 선택·최소 주문 금액·최대 할인·시작일 설정은 현재 지원하지 않습니다/,
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(benefitHelp).toHaveCount(0);
  await expect(panel.getByText(/발급 완료|수신 대상 0명|대상 고객 0명/)).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /발급하기|지금 발급|고객 발급/ }),
  ).toHaveCount(0);
  const formBox = await panel
    .getByRole("form", { name: "쿠폰 초안 설정", exact: true })
    .boundingBox();
  const previewBox = await preview.boundingBox();
  expect(formBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.x).toBeGreaterThan(formBox!.x + formBox!.width - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("coupon-redesign-desktop-1440.png"),
    fullPage: true,
  });
  expect(audit.syntheticWrites).toEqual([]);
  expect(audit.reads.filter((path) => /coupons|members|campaigns/.test(path))).toEqual(
    [],
  );
});

test("coupon redesign: Enter in the growing coupon name saves only when the save button is enabled", async ({
  page,
}) => {
  const commands: unknown[] = [];
  await setup(page, {
    path: "/admin?section=coupons",
    handleCouponMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await savedCoupon(route);
    },
  });
  const panel = couponWorkspace(page);
  const name = couponField(page, "쿠폰명 (필수)");
  const save = panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true });
  // 이름만 입력하면 양식이 미완성이므로 Enter는 한 줄 입력란처럼 아무 동작도 하지 않음.
  await name.fill("[TEST] Enter coupon");
  await expect(save).toBeDisabled();
  await name.press("Enter");
  await expect(name).toHaveValue("[TEST] Enter coupon");
  await page.waitForTimeout(300);
  expect(commands).toEqual([]);
  await expect(panel.getByText("아직 고객에게 발급되지 않았습니다")).toHaveCount(0);
  // 제출 처리기가 실행되지 않았으므로 오류 알림도 나타나지 않음.
  await expect(panel.getByRole("alert")).toHaveCount(0);

  // 양식을 완성하면 Enter는 이전처럼 저장 버튼을 통해 제출함.
  await fillCoupon(page, { name: "[TEST] Enter coupon", code: "test_enter10" });
  await expect(save).toBeEnabled();
  await name.press("Enter");
  await expect.poll(() => commands.length).toBe(1);
  await expect(name).not.toHaveValue(/\n/);
});

test("coupon redesign: explicit percent and amount draft saves preserve uppercase codes supported fields and KST expiration", async ({
  page,
}) => {
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=coupons",
    handleCouponMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      await savedCoupon(route);
    },
  });
  const panel = couponWorkspace(page);
  await fillCoupon(page, {
    name: "  [TEST] Percent  ",
    code: "  test_percent10  ",
    date: "2026-10-30T18:30",
  });
  await panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({
    name: "[TEST] Percent",
    code: "TEST_PERCENT10",
    discountType: "PERCENT",
    discountValue: 10,
    expiresAt: "2026-10-30T09:30:00.000Z",
  });
  await expect(panel.getByRole("status")).toContainText(
    "아직 고객에게 발급되지 않았습니다",
  );
  await expect(panel.getByText("초안 저장 · 미발급", { exact: true })).toBeVisible();
  await fillCoupon(page, {
    name: "[TEST] Amount",
    code: "test_amount5000",
    type: "amount",
    value: "5000",
    date: "",
  });
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByText("초안 · 미발급", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual({
    name: "[TEST] Amount",
    code: "TEST_AMOUNT5000",
    discountType: "AMOUNT",
    discountValue: 5000,
  });
  expect(audit.syntheticWrites).toEqual(
    Array(2).fill("POST https://api.sales.test/prod/admin/coupons"),
  );
});

test("coupon redesign: invalid codes and noninteger or out-of-range benefits cannot be sent even through form submission", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=coupons" });
  const panel = couponWorkspace(page);
  await fillCoupon(page);
  const form = panel.getByRole("form", { name: "쿠폰 초안 설정", exact: true });
  const value = couponField(page, "할인율 (%) (필수)");
  for (const invalid of ["", " ", "0", "-1", "1.5", "1e2", "1,000", "101", "text"]) {
    await value.fill(invalid);
    await expect(
      panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
    ).toBeDisabled();
    await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
    await expect(panel.getByRole("alert")).toBeVisible();
    expect(audit.syntheticWrites).toEqual([]);
  }
  await value.fill("100");
  await expect(
    panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
  ).toBeEnabled();
  for (const code of [" ", "AB", "bad code", "한글쿠폰", "BAD@CODE", "_BAD"]) {
    await couponField(page, "쿠폰 코드 (필수)").fill(code);
    await expect(
      panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
    ).toBeDisabled();
    await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
    expect(audit.syntheticWrites).toEqual([]);
  }
  await couponField(page, "쿠폰 코드 (필수)").fill("VALID_100");
  await couponField(page, "혜택 유형").selectOption("amount");
  const amount = couponField(page, "할인 금액 (원) (필수)");
  await amount.fill("100000001");
  await expect(
    panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
  ).toBeDisabled();
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  await amount.fill("100000000");
  await expect(
    panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
  ).toBeEnabled();
  await expect(couponField(page, "쿠폰명 (필수)")).toHaveAttribute("maxlength", "120");
  await expect(couponField(page, "쿠폰 코드 (필수)")).toHaveAttribute(
    "maxlength",
    "32",
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("coupon redesign: saving disables edits and synchronous duplicate submissions create only one draft request", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=coupons",
    handleCouponMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await gate;
      await savedCoupon(route);
    },
  });
  await fillCoupon(page);
  const panel = couponWorkspace(page);
  try {
    await panel
      .getByRole("form", { name: "쿠폰 초안 설정", exact: true })
      .evaluate((form: HTMLFormElement) => {
        form.requestSubmit();
        form.requestSubmit();
      });
    await expect.poll(() => commands.length).toBe(1);
    for (const label of [
      "쿠폰명 (필수)",
      "쿠폰 코드 (필수)",
      "혜택 유형",
      "할인율 (%) (필수)",
      "만료 시각 (한국 시간·선택)",
    ])
      await expect(couponField(page, label)).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "저장 중…", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(panel.getByRole("status")).toContainText("초안을 서버에 저장했습니다");
  expect(commands).toHaveLength(1);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/coupons",
  ]);
});

test("coupon redesign: unknown save keeps the entered draft and never claims issuance or local fallback", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=coupons",
    handleCouponMutation: (route) =>
      respond(route, { code: "SYNTHETIC_COUPON_UNAVAILABLE" }, 503),
  });
  await fillCoupon(page, { date: "2026-10-30T18:30" });
  const panel = couponWorkspace(page);
  await panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "쿠폰 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다",
  );
  await expect(panel.getByRole("alert")).toContainText("서버 처리 결과");
  await expect(couponField(page, "쿠폰명 (필수)")).toHaveValue("[TEST] Welcome coupon");
  await expect(couponField(page, "쿠폰 코드 (필수)")).toHaveValue("TEST_WELCOME10");
  await expect(couponField(page, "할인율 (%) (필수)")).toHaveValue("10");
  await expect(couponField(page, "만료 시각 (한국 시간·선택)")).toHaveValue(
    "2026-10-30T18:30",
  );
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "이 화면에 초안 준비", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByText("초안 저장 · 미발급", { exact: true })).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/coupons",
  ]);
});

test("coupon redesign: mobile form and ticket reflow at 375 and 320 with usable controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const audit = await setup(page, { path: "/admin?section=coupons" });
  await fillCoupon(page, {
    name: `SYNTHETIC_${"LONG_COUPON_".repeat(6)}`,
    code: "SYNTHETIC_LONG_COUPON_CODE_123456",
    date: "2026-10-30T18:30",
  });
  const panel = couponWorkspace(page);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const label of [
      "쿠폰명 (필수)",
      "쿠폰 코드 (필수)",
      "혜택 유형",
      "할인율 (%) (필수)",
      "만료 시각 (한국 시간·선택)",
    ])
      expect(
        (await couponField(page, label).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    expect(
      (
        await panel
          .getByRole("button", { name: "쿠폰 초안 저장", exact: true })
          .boundingBox()
      )?.height,
    ).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`coupon-redesign-mobile-${width}.png`),
      fullPage: true,
    });
    await panel
      .getByRole("complementary", { name: "쿠폰 고객 노출 미리보기", exact: true })
      .screenshot({
        path: testInfo.outputPath(`coupon-redesign-mobile-ticket-${width}.png`),
      });
  }
  expect(audit.syntheticWrites).toEqual([]);
});

test("coupon redesign: enabled draft save is readable on hover and keyboard focus in both themes", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=coupons" });
  await fillCoupon(page);
  const action = couponWorkspace(page).getByRole("button", {
    name: "쿠폰 초안 저장",
    exact: true,
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const state of ["hover", "focus"]) {
      await page.mouse.move(0, 0);
      if (state === "hover") await action.hover();
      else {
        await action.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(action).toBeFocused();
        await expect
          .poll(() => action.evaluate((element) => element.matches(":focus-visible")))
          .toBe(true);
      }
      const contrast = await action.evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const rgba = (value: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const ancestors: Element[] = [];
        for (let node: Element | null = element; node; node = node.parentElement)
          ancestors.unshift(node);
        let background = [255, 255, 255];
        for (const ancestor of ancestors) {
          const [red, green, blue, alpha] = rgba(
            getComputedStyle(ancestor).backgroundColor,
          );
          background = [red, green, blue].map(
            (channel, index) =>
              channel * (alpha / 255) + background[index] * (1 - alpha / 255),
          );
        }
        const luminance = (rgb: readonly number[]) => {
          const [red, green, blue] = rgb.map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        const style = getComputedStyle(element);
        const foreground = luminance(rgba(style.color).slice(0, 3));
        const behind = luminance(background);
        return (
          (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05)
        );
      });
      console.log(`Coupon save contrast ${theme}/${state}: ${contrast}`);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(audit.syntheticWrites).toEqual([]);
});

test("screen guide walks the coupon name, discount, preview and save button", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=coupons" });
  const open = couponWorkspace(page).getByRole("button", {
    name: "화면 도움말",
    exact: true,
  });
  await open.click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("1/4단계");
  await expect(bubble.getByRole("heading")).toHaveText("쿠폰 이름 쓰기");
  // 이름 입력란 바로 아래에 밑줄이 그어짐.
  const name = page.locator('[data-admin-guide="coupons.name"]');
  await expect
    .poll(async () => {
      const target = await boxOf(name);
      const line = await boxOf(guideLines(page).first());
      return Math.abs(line.y - (target.y + target.height)) <= 6;
    })
    .toBe(true);
  for (const title of ["할인 정하기", "모습 확인", "쿠폰 저장"]) {
    await page.keyboard.press("ArrowRight");
    await expect(bubble.getByRole("heading")).toHaveText(title);
  }
  await bubble.getByRole("button", { name: "완료", exact: true }).click();
  await expect(bubble).toHaveCount(0);
  await expect(open).toBeFocused();
});
