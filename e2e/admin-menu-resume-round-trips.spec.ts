// 역할: 상점 왕복·새 탭·새로고침·뒤로/앞으로 이동 뒤에도 명시한 관리자 메뉴와 상품이 복원되고 잘못된 표식 값은 개요로 가는지 검증함.
import { expect, test } from "@playwright/test";
import {
  active,
  adminLink,
  audits,
  entryHref,
  ORIGIN,
  PRODUCT_A,
  PRODUCT_B,
  products,
  roundTrip,
  sections,
  select,
  setup,
  storeHref,
  storeLink,
} from "./admin-menu-resume-base-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
  expect(audits.get(page)?.writes ?? []).toEqual([]);
});

test("video reproduction: inventory to original product to admin resumes inventory instead of home", async ({
  page,
}) => {
  await setup(page);
  await adminLink(page).click();
  await active(page, "overview");
  await select(page, "inventory");
  await storeLink(page).click();
  await expect(page.getByRole("heading", { name: products[0].name })).toBeVisible();
  await adminLink(page).click();
  await active(page, "inventory");
  await expect(page).toHaveURL(`${ORIGIN}${entryHref(PRODUCT_A, "inventory")}`);
});

test("all nine menus survive two explicit storefront round trips without nested return markers", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setup(page);
  await adminLink(page).click();
  for (const [section] of sections) {
    await select(page, section);
    await roundTrip(page, PRODUCT_A, section);
    await roundTrip(page, PRODUCT_A, section);
  }
});

test("query detail preserves slug locale anchor and menu through both reloads", async ({
  page,
}) => {
  const path = `${PRODUCT_B}&locale=en#reviews`;
  await setup(page, { path });
  await adminLink(page).click();
  await select(page, "brands");
  await page.reload();
  await active(page, "brands");
  await storeLink(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${storeHref(path, "brands")}`);
  await page.reload();
  await expect(page).toHaveURL(`${ORIGIN}${storeHref(path, "brands")}`);
  await expect(page.getByRole("heading", { name: products[1].name })).toBeVisible();
  await expect(adminLink(page)).toHaveAttribute("href", entryHref(path, "brands"));
  await adminLink(page).click();
  await active(page, "brands");
});

test("opening the real resumed admin Link in a new tab carries only its explicit menu and return target", async ({
  page,
}) => {
  const path = `${PRODUCT_B}&locale=ko#description`;
  await setup(page, { path });
  await adminLink(page).click();
  await select(page, "marketing");
  await storeLink(page).click();
  const popupPromise = page.context().waitForEvent("page");
  await adminLink(page).click({ button: "middle" });
  const other = await popupPromise;
  try {
    await other.waitForLoadState("networkidle");
    await active(other, "marketing");
    await expect(other).toHaveURL(`${ORIGIN}${entryHref(path, "marketing")}`);
    await expect(storeLink(other)).toHaveAttribute(
      "href",
      storeHref(path, "marketing"),
    );
    await expect(page).toHaveURL(`${ORIGIN}${storeHref(path, "marketing")}`);
  } finally {
    await other.close();
  }
});

test("different products and direct admin do not borrow a stale global menu or product", async ({
  page,
}) => {
  await setup(page);
  await adminLink(page).click();
  await select(page, "inventory");
  await storeLink(page).click();
  await page.goto(PRODUCT_B);
  await expect(adminLink(page)).toHaveAttribute(
    "href",
    entryHref(PRODUCT_B, "overview"),
  );
  await adminLink(page).click();
  await active(page, "overview");
  await select(page, "coupons");
  await roundTrip(page, PRODUCT_B, "coupons");
  await page.goto("/admin");
  await active(page, "overview");
  await expect(storeLink(page)).toHaveAttribute("href", "/");
});

test("browser Back and Forward restore each menu and store boundary without history guessing", async ({
  page,
}) => {
  await setup(page);
  await adminLink(page).click();
  await select(page, "inventory");
  const inventory = page.url();
  await storeLink(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${storeHref(PRODUCT_A, "inventory")}`);
  const store = page.url();
  await adminLink(page).click();
  await select(page, "brands");
  await page.goBack();
  await active(page, "inventory");
  await page.goBack();
  await expect(page).toHaveURL(store);
  await page.goBack();
  await expect(page).toHaveURL(inventory);
  await active(page, "inventory");
  await page.goForward();
  await expect(page).toHaveURL(store);
  await page.goForward();
  await active(page, "inventory");
  await page.goForward();
  await active(page, "brands");
});

test("unknown empty duplicate encoded and dangerous marker values safely select overview", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setup(page);
  for (const query of [
    "adminSection=unknown",
    "adminSection=",
    "adminSection=inventory&adminSection=brands",
    "adminSection=inventory&adminSection=inventory",
    "adminSection=%2Fadmin%3Fsection%3Dinventory",
    "adminSection=javascript%3Aalert(1)",
    "adminSection=%3Cscript%3E",
    "adminSection=INVENTORY",
  ]) {
    await page.goto(`${PRODUCT_A}?${query}`);
    await expect(adminLink(page)).toHaveAttribute(
      "href",
      entryHref(PRODUCT_A, "overview"),
    );
    await adminLink(page).click();
    await active(page, "overview");
  }
});
