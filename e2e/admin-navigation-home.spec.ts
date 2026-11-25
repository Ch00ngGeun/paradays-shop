import { expect, test } from "@playwright/test";
import {
  active,
  audits,
  ORIGIN,
  respond,
  returnProduct,
  sections,
  select,
  setup,
} from "./admin-navigation-base-fixtures";
import {
  checkHomePrivateCreateHistory,
  completeOverview,
  expectNoHomePrivateReads,
  overviewMetric,
} from "./admin-navigation-home-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("home redesign: desktop presents three primary metrics and persistent accessible navigation without invented totals", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, {
    handleOverview: (route) => respond(route, completeOverview),
  });
  await expect(overviewMetric(page, "오늘 매출").locator("strong")).toHaveText(
    /139,000/,
  );
  await expect(overviewMetric(page, "오늘 주문(건)").locator("strong")).toHaveText(
    /^3(?:건)?$/,
  );
  await expect(overviewMetric(page, "판매 상품 수량(개)").locator("strong")).toHaveText(
    /^5(?:개)?$/,
  );
  await expect(overviewMetric(page, "신규 회원").locator("strong")).toHaveText(
    /^2(?:명)?$/,
  );
  await expect(overviewMetric(page, "등록 쿠폰").locator("strong")).toHaveText("7");
  await expect(overviewMetric(page, "등록 쿠폰")).toContainText("초안 포함");
  await expect(overviewMetric(page, "마케팅 대상").locator("strong")).toHaveText("11");
  await expect(overviewMetric(page, "오늘 매출")).toContainText("온라인 결제완료");
  await expect(
    page.getByRole("heading", { name: "운영 현황", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("집계 기준", { exact: false }).first()).toContainText(
    "KST",
  );
  for (const [, label] of sections) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    await expect(tab).toBeVisible();
    const size = await tab.boundingBox();
    expect(size!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(
    page.getByRole("button", { name: "운영 메뉴 열기", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "운영 바로가기", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1,240,000원", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "최근 운영 기록", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("아직 이 화면에서 수행한 작업이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("일마감 미완료", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "주문 취소·반품 재고 관리" }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
  expectNoHomePrivateReads(audit);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  const screenshot = testInfo.outputPath("home-redesign-desktop-1440.png");
  await page.screenshot({ path: screenshot });
  console.log(`Home redesign desktop screenshot: ${screenshot}`);
  for (const [name, id] of [
    ["입고 검토 시작", "ocr"],
    ["재고 확인", "inventory"],
    ["매출·마감 확인", "sales"],
  ] as const) {
    const action = page.getByRole("button", { name, exact: true });
    const size = await action.boundingBox();
    expect(size!.height).toBeGreaterThanOrEqual(44);
    await action.click();
    await active(page, id);
    await page.goBack();
    await active(page, "overview");
  }
  await page.getByText("집계 기준·개인정보 안내", { exact: true }).click();
  const help = page
    .locator("details[open]")
    .filter({ has: page.getByText("집계 기준·개인정보 안내", { exact: true }) });
  await expect(help).toContainText("오프라인을 포함한 매출은 매출·일마감에서");
  await expect(help).toContainText(
    "오늘 주문은 오늘(KST) 생성된 주문 건수로 결제 여부와 무관",
  );
  await expect(help).toContainText(
    "현재 결제완료(PAID) 상태이며 오늘(KST) 결제된 온라인 주문",
  );
  await expect(help).toContainText("등록 쿠폰에는 초안과 일시중지 쿠폰도 포함");
  await expect(help).toContainText(
    "회원 정보와 수신 동의는 관리자 권한을 확인한 API에서만",
  );
  await expect(help).toContainText("채널별 발송 가능 수신자 수가 아닙니다");
  await checkHomePrivateCreateHistory(page, audit);
});

test("home redesign: legitimate zero is distinct from a missing optional aggregation", async ({
  page,
}) => {
  const audit = await setup(page, {
    handleOverview: (route) =>
      respond(route, {
        ...completeOverview,
        todayOrderCount: 0,
        todayPaidRevenue: 0,
        todaySoldItemCount: 0,
        todayNewMemberCount: 0,
      }),
  });
  await expect(overviewMetric(page, "오늘 매출").locator("strong")).toHaveText(
    /^(?:₩|￦)?0(?:원)?$/,
  );
  await expect(overviewMetric(page, "오늘 주문(건)").locator("strong")).toHaveText(
    /^0(?:건)?$/,
  );
  await expect(overviewMetric(page, "판매 상품 수량(개)").locator("strong")).toHaveText(
    /^0(?:개)?$/,
  );
  await expect(overviewMetric(page, "신규 회원").locator("strong")).toHaveText(
    /^0(?:명)?$/,
  );
  expect(audit.syntheticWrites).toEqual([]);
  expectNoHomePrivateReads(audit);
});

test("home redesign: old overview responses keep absent revenue sales units and new members pending rather than zero", async ({
  page,
}) => {
  const audit = await setup(page);
  for (const label of ["오늘 매출", "판매 상품 수량(개)", "신규 회원"]) {
    const metric = overviewMetric(page, label);
    await expect(metric.locator("strong")).toHaveText("—");
    await expect(metric).toContainText("집계 준비 중");
  }
  await expect(overviewMetric(page, "오늘 주문(건)").locator("strong")).toHaveText(
    /^0(?:건)?$/,
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("home redesign: a failed overview fetch shows unavailable values without sample data or automatic writes", async ({
  page,
}) => {
  const audit = await setup(page, {
    handleOverview: (route) =>
      route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_UNAVAILABLE" },
        headers: { "access-control-allow-origin": "*" },
      }),
  });
  for (const label of [
    "오늘 매출",
    "오늘 주문(건)",
    "판매 상품 수량(개)",
    "신규 회원",
  ]) {
    const metric = overviewMetric(page, label);
    await expect(metric.locator("strong")).toHaveText("—");
    await expect(metric).toContainText("지표 조회 실패 · 연결·권한 확인 필요");
  }
  await expect(
    page.getByRole("alert").filter({ hasText: "운영 지표를 불러오지 못했습니다" }),
  ).toBeVisible();
  await expect(page.getByText("SYNTHETIC_UNAVAILABLE", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1,240,000원", { exact: true })).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([]);
});

test("home redesign: slow overview remains loading until its own fixture resolves", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const audit = await setup(page, {
    waitForIdle: false,
    handleOverview: async (route) => {
      await gate;
      await respond(route, completeOverview);
    },
  });
  try {
    await expect(overviewMetric(page, "오늘 매출").locator("strong")).toHaveText("…");
    await expect(overviewMetric(page, "오늘 매출")).toContainText("불러오는 중");
  } finally {
    release();
  }
  await expect(overviewMetric(page, "오늘 매출").locator("strong")).toHaveText(
    /139,000/,
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("home redesign: desktop keyboard navigation and store return preserve the explicit destination and menu", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?returnTo=%2Fproducts%3Fslug%3Dsynthetic-deck",
  });
  const overview = page.getByRole("tab", { name: "홈(운영현황)", exact: true });
  await overview.focus();
  await expect(overview).toBeFocused();
  await overview.press("End");
  await active(page, "ocr");
  await page.getByRole("tab", { name: "입고 OCR", exact: true }).press("Home");
  await active(page, "overview");
  await select(page, "brands");
  const back = page.getByRole("link", { name: "스토어로 돌아가기", exact: true });
  const destination = new URL((await back.getAttribute("href"))!, ORIGIN);
  expect(destination.pathname).toBe("/products");
  expect(destination.searchParams.get("slug")).toBe("synthetic-deck");
  expect(destination.searchParams.get("adminSection")).toBe("brands");
  expect(audit.syntheticWrites).toEqual([]);
});

test("home redesign: mobile drawer is explicit dismissible and keeps the page within 375 CSS pixels", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const audit = await setup(page, {
    handleOverview: (route) => respond(route, completeOverview),
  });
  const opener = page.getByRole("button", { name: "운영 메뉴 열기", exact: true });
  await expect(opener).toBeVisible();
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("tab", { name: "홈(운영현황)", exact: true }),
  ).not.toBeVisible();
  await opener.click();
  await expect(page.getByRole("tablist")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(9);
  await expect(
    page.getByRole("tab", { name: "홈(운영현황)", exact: true }),
  ).toBeFocused();
  const drawer = page.locator("#ops-menu-drawer");
  const first = drawer.getByRole("button", { name: "메뉴 닫기", exact: true });
  const last = drawer.getByRole("link", { name: "스토어로 돌아가기", exact: true });
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(opener).toBeFocused();
  await select(page, "inventory");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await page.goBack();
  await active(page, "overview");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(audit.syntheticWrites).toEqual([]);
  expectNoHomePrivateReads(audit);
  const screenshot = testInfo.outputPath("home-redesign-mobile-375.png");
  await page.screenshot({ path: screenshot });
  console.log(`Home redesign mobile screenshot: ${screenshot}`);
  await checkHomePrivateCreateHistory(page, audit);
});

for (const width of [1440, 375]) {
  test(`home redesign: ${width}px product-admin-store-admin round trip preserves original detail menu and catalog filter`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const audit = await setup(page, { path: "/", storefrontProduct: true });
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (width < 768) await menu.click();
    else await menu.press("ArrowDown");
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const dropdown = page.locator("#store-menu-dropdown");
    await dropdown.getByRole("button", { name: "데크", exact: true }).press("Enter");
    await expect(
      dropdown.getByRole("button", { name: "데크", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await menu.press("Enter");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    const filter = await page.evaluate(() =>
      sessionStorage.getItem("paradays:catalog-filters:v1"),
    );
    expect(filter).not.toBeNull();
    const list = page.getByRole("list", { name: "PARADAYS products" });
    await expect(list).not.toHaveAttribute("aria-busy", "true");
    await list
      .getByRole("link", {
        name: `${returnProduct.name} 상품상세 보기`,
        exact: true,
      })
      .click();
    await page.waitForURL(
      (url) =>
        url.pathname === "/products" &&
        url.searchParams.get("slug") === returnProduct.slug,
    );
    await expect(
      page.getByRole("heading", { name: returnProduct.name, exact: true }),
    ).toBeVisible();
    const detail = new URL(page.url());
    await page.getByRole("link", { name: "관리자페이지", exact: true }).click();
    await active(page, "overview");
    await select(page, "inventory");
    await page.getByRole("link", { name: "스토어로 돌아가기", exact: true }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === detail.pathname &&
        url.searchParams.get("slug") === detail.searchParams.get("slug") &&
        url.searchParams.get("adminSection") === "inventory",
    );
    const returned = new URL(page.url());
    expect(returned.pathname).toBe(detail.pathname);
    expect(returned.searchParams.get("slug")).toBe(detail.searchParams.get("slug"));
    expect(returned.searchParams.get("adminSection")).toBe("inventory");
    await expect(
      page.getByRole("heading", { name: returnProduct.name, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => sessionStorage.getItem("paradays:catalog-filters:v1")),
    ).toBe(filter);
    await page.getByRole("link", { name: "관리자페이지", exact: true }).click();
    await active(page, "inventory");
    expect(audit.syntheticWrites).toEqual([]);
  });
}

for (const viewport of [
  { width: 320, height: 900 },
  { width: 1024, height: 768 },
  { width: 1440, height: 500 },
]) {
  test(`home redesign: ${viewport.width}x${viewport.height} reflow keeps navigation and return link reachable`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const audit = await setup(page, {
      handleOverview: (route) => respond(route, completeOverview),
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const name of ["새 상품", "입고 검토 시작", "재고 확인", "매출·마감 확인"]) {
      const size = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(size!.height).toBeGreaterThanOrEqual(44);
      expect(size!.x).toBeGreaterThanOrEqual(0);
      expect(size!.x + size!.width).toBeLessThanOrEqual(viewport.width);
    }
    await page.screenshot({
      path: testInfo.outputPath(
        `home-redesign-${viewport.width}x${viewport.height}-layout.png`,
      ),
    });
    const drawer = page.locator("#ops-menu-drawer");
    if (viewport.width < 1024) {
      await page.getByRole("button", { name: "운영 메뉴 열기", exact: true }).click();
      // The drawer moves focus to the selected tab on the next frame; wait for it first.
      await expect(drawer.getByRole("tab", { selected: true })).toBeFocused();
    }
    const lastTab = drawer.getByRole("tab", { name: "입고 OCR", exact: true });
    await lastTab.focus();
    await expect(lastTab).toBeFocused();
    let bounds = await lastTab.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({
      path: testInfo.outputPath(
        `home-redesign-${viewport.width}x${viewport.height}-navigation.png`,
      ),
    });
    const back = drawer.getByRole("link", {
      name: "스토어로 돌아가기",
      exact: true,
    });
    await back.focus();
    await expect(back).toBeFocused();
    bounds = await back.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(audit.syntheticWrites).toEqual([]);
    expectNoHomePrivateReads(audit);
  });
}
