import { expect, type Locator, test } from "@playwright/test";
import { REQUIRED, requiredLook } from "./admin-navigation-accessibility-fixtures";
import { audits, select, setup } from "./admin-navigation-base-fixtures";
import { brandNameInput, brandWorkspace } from "./admin-navigation-brand-fixtures";
import {
  couponField,
  couponWorkspace,
  fillCoupon,
} from "./admin-navigation-coupon-fixtures";
import {
  inventoryProducts,
  selectInventory,
} from "./admin-navigation-inventory-fixtures";
import {
  campaignBody,
  campaignTitle,
  fillCampaign,
  marketingWorkspace,
} from "./admin-navigation-marketing-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("required fields: empty required inputs use the selected-box blue until filled across product, brand, coupon and campaign forms", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=products" });
  await page.getByRole("button", { name: "새 상품 등록", exact: true }).click();
  const name = page.getByRole("textbox", { name: /상품명/ }).first();
  await expect(name).toHaveAttribute("required", "");
  expect(await requiredLook(name)).toEqual(REQUIRED);
  await name.fill("[TEST] Required deck");
  expect(await requiredLook(name)).not.toEqual(REQUIRED);
  // Optional fields never turn blue.
  const optional = page.getByRole("combobox", { name: "카테고리", exact: true });
  expect(await requiredLook(optional)).not.toEqual(REQUIRED);

  await select(page, "brands");
  expect(await requiredLook(brandNameInput(page))).toEqual(REQUIRED);
  await brandNameInput(page).fill("[TEST] Brand");
  expect(await requiredLook(brandNameInput(page))).not.toEqual(REQUIRED);

  await select(page, "coupons");
  const couponName = couponField(page, "쿠폰명 (필수)");
  expect(await requiredLook(couponName)).toEqual(REQUIRED);
  await fillCoupon(page);
  for (const label of ["쿠폰명 (필수)", "쿠폰 코드 (필수)"])
    expect(await requiredLook(couponField(page, label))).not.toEqual(REQUIRED);
  expect(await requiredLook(couponField(page, "만료 시각"))).not.toEqual(REQUIRED);

  await select(page, "marketing");
  expect(await requiredLook(campaignTitle(page))).toEqual(REQUIRED);
  expect(await requiredLook(campaignBody(page))).toEqual(REQUIRED);
  await fillCampaign(page);
  expect(await requiredLook(campaignTitle(page))).not.toEqual(REQUIRED);
  expect(await requiredLook(campaignBody(page))).not.toEqual(REQUIRED);
});

test("required fields: every (필수) label shows a red asterisk that is not read twice", async ({
  page,
}) => {
  const marks = async (scope: Locator) =>
    scope
      .locator('label span[aria-hidden="true"]', { hasText: /^\*$/ })
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
  await setup(page, { path: "/admin?section=brands" });
  expect(await marks(brandWorkspace(page))).toEqual(["rgb(185, 28, 28)"]);
  await expect(brandNameInput(page)).toHaveAttribute("required", "");
  await select(page, "coupons");
  expect(await marks(couponWorkspace(page))).toEqual(Array(3).fill("rgb(185, 28, 28)"));
  await expect(couponField(page, "쿠폰명 (필수)")).toHaveAccessibleName(
    /^쿠폰명 \(필수\)$/,
  );
  await select(page, "marketing");
  expect(await marks(marketingWorkspace(page))).toEqual(
    Array(2).fill("rgb(185, 28, 28)"),
  );
});

test("required fields: dark theme uses the dark selected-box blue and the stock quantity turns blue when cleared", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("paradays-theme", "dark"));
  await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await selectInventory(page);
  const quantity = page.getByRole("textbox", {
    name: "변경 후 재고 수량",
    exact: true,
  });
  await expect(quantity).toHaveAttribute("required", "");
  expect(await requiredLook(quantity)).not.toEqual([
    "rgb(19, 23, 28)",
    "rgb(40, 100, 180)",
  ]);
  await quantity.fill("");
  expect(await requiredLook(quantity)).toEqual([
    "rgb(19, 23, 28)",
    "rgb(40, 100, 180)",
  ]);
});
