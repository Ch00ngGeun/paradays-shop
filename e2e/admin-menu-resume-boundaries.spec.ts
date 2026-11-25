import { expect, test } from "@playwright/test";
import {
  active,
  adminLink,
  audits,
  entryHref,
  ORIGIN,
  PENDING,
  PENDING_KEY,
  PRODUCT_A,
  PRODUCT_B,
  roundTrip,
  select,
  setup,
  storeHref,
  storeLink,
} from "./admin-menu-resume-base-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
  expect(audits.get(page)?.writes ?? []).toEqual([]);
});

test("private query editor draft and return directives never cross the public menu boundary", async ({
  page,
}) => {
  const path = `${PRODUCT_B}&locale=ko#details`;
  const privatePath = `${PRODUCT_B}&locale=ko&adminSection=inventory&section=members&editor=00000000-0000-0000-0000-000000000001&draft=TEST_PRIVATE&token=TEST_PRIVATE&returnTo=%2Fadmin#details`;
  await setup(page, { path: privatePath });
  await expect(adminLink(page)).toHaveAttribute("href", entryHref(path, "inventory"));
  await adminLink(page).click();
  await active(page, "inventory");
  expect(page.url()).not.toMatch(/TEST_PRIVATE|editor|draft|token|members/);
  await expect(storeLink(page)).toHaveAttribute("href", storeHref(path, "inventory"));
  await storeLink(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${storeHref(path, "inventory")}`);
  expect(page.url()).not.toMatch(/TEST_PRIVATE|editor|draft|token|members|returnTo/);
  await adminLink(page).click();
  await select(page, "products");
  await page.getByRole("button", { name: "새 상품 등록", exact: true }).click();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_PRIVATE_DRAFT");
  expect(new URL(page.url()).searchParams.has("editor")).toBe(true);
  await expect(storeLink(page)).toHaveAttribute("href", storeHref(path, "products"));
  await roundTrip(page, path, "products");
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toMatch(/editor|TEST_PRIVATE_DRAFT/);
  await page.goto(
    `/admin?returnTo=${encodeURIComponent("/admin?adminSection=inventory")}&section=inventory`,
  );
  await expect(storeLink(page)).toHaveAttribute("href", "/?adminSection=inventory");
  await storeLink(page).click();
  await expect(adminLink(page)).toHaveAttribute("href", "/admin?section=inventory");
  await page.goto(
    "/products?slug=synthetic-menu-product-b&slug=ambiguous&adminSection=inventory",
  );
  await expect(adminLink(page)).toHaveAttribute("href", "/admin");
});

test("anonymous and member URLs cannot mount an admin menu or read admin data", async ({
  page,
}) => {
  const path = `${PRODUCT_B}&adminSection=inventory`;
  const audit = await setup(page, { path, groups: [] });
  await expect(adminLink(page)).toHaveCount(0);
  await page.goto(entryHref(PRODUCT_B, "inventory"));
  await expect(
    page.getByRole("heading", { name: "관리자 권한이 없습니다", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#admin-panel-inventory")).toHaveCount(0);
  await expect(storeLink(page)).toHaveAttribute("href", PRODUCT_B);
  expect(audit.reads.filter((path) => path.includes("/admin/"))).toEqual([]);
  await page.evaluate(() => {
    sessionStorage.removeItem("paradays.auth.session");
    localStorage.removeItem("paradays.auth.session");
  });
  await page.goto(entryHref(PRODUCT_B, "inventory"));
  await expect(
    page.getByRole("heading", { name: "관리자 로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  await expect(storeLink(page)).toHaveAttribute("href", PRODUCT_B);
  expect(audit.reads.filter((path) => path.includes("/admin/"))).toEqual([]);
});

test("resuming sales returns to mode chooser and does not persist simulation state or add storage", async ({
  page,
}) => {
  const audit = await setup(page, { pending: true });
  await adminLink(page).click();
  await select(page, "sales");
  const storage = () =>
    page.evaluate(() => ({
      session: Object.fromEntries(
        Object.keys(sessionStorage)
          .sort()
          .map((key) => [key, sessionStorage.getItem(key)]),
      ),
      local: Object.fromEntries(
        Object.keys(localStorage)
          .sort()
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    }));
  const before = await storage();
  await page
    .getByLabel("실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "모의 매출·일마감 체험", exact: true })
    .click();
  const reads = [...audit.reads];
  await page.getByRole("button", { name: "카드 예시 불러오기", exact: true }).click();
  await page.getByRole("button", { name: "모의 초안 저장", exact: true }).click();
  await page
    .getByRole("button", { name: "가상 재고 예정표 확인", exact: true })
    .click();
  await page
    .getByLabel("예정표의 가상 재고 차감을 확인했습니다", { exact: true })
    .check();
  await page.getByRole("button", { name: "모의 판매 확정", exact: true }).click();
  await expect(page.getByLabel("가상 데크 재고", { exact: true })).toHaveText("8개");
  expect(audit.reads).toEqual(reads);
  await roundTrip(page, PRODUCT_A, "sales");
  await expect(
    page.getByRole("heading", { name: "매출·일마감 모드 선택", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "모의 매출·일마감 체험", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "모의 매출·일마감 체험", exact: true })
    .click();
  await expect(page.getByLabel("가상 데크 재고", { exact: true })).toHaveText("10개");
  expect(await storage()).toEqual(before);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_KEY)).toBe(
    PENDING,
  );
  expect(audit.reads.filter((path) => path.includes("/admin/sales/"))).toEqual([]);
});

test("home cart and account round trips recover their explicit admin menu", async ({
  page,
}) => {
  await setup(page, { path: "/" });
  for (const [path, section] of [
    ["/", "inventory"],
    ["/cart", "brands"],
    ["/account", "sales"],
  ] as const) {
    await page.goto(path);
    await adminLink(page).click();
    await select(page, section);
    await roundTrip(page, path, section);
  }
});

test("mobile video flow keeps the return link reachable and resumes the original menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await adminLink(page).click();
  await select(page, "inventory");
  const bounds = await storeLink(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await roundTrip(page, PRODUCT_A, "inventory");
});
