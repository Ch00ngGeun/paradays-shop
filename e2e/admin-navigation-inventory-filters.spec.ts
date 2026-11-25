import { expect, test } from "@playwright/test";
import { audits, respond, setup } from "./admin-navigation-base-fixtures";
import {
  inventoryFilterProducts,
  inventoryWorkspace,
  selectInventory,
} from "./admin-navigation-inventory-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("inventory filters: category brand search and stock intersect without reads or writes and clear independently", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryFilterProducts,
  });
  const workspace = inventoryWorkspace(page);
  const rows = workspace.getByRole("button", { name: / 재고 조정$/ });
  const search = workspace.getByRole("searchbox", { name: "상품 검색", exact: true });
  const category = workspace.getByRole("combobox", { name: "카테고리", exact: true });
  const brand = workspace.getByRole("combobox", { name: "브랜드", exact: true });
  const stock = workspace.getByRole("combobox", { name: "재고", exact: true });
  const readsBefore = audit.reads.length;
  await expect(rows).toHaveCount(9);
  await expect(brand.getByRole("option", { name: "NOVA", exact: true })).toHaveCount(1);
  await expect(brand.getByRole("option", { name: "nova", exact: true })).toHaveCount(1);
  await category.selectOption("Deck");
  await expect(rows).toHaveCount(2);
  await brand.selectOption("NOVA");
  await stock.selectOption("low");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAccessibleName("[TEST] Filter product 1 재고 조정");
  await search.fill("filter-0");
  await expect(rows).toHaveCount(0);
  await expect(
    workspace.getByText("표시할 상품이 없습니다", { exact: true }),
  ).toBeVisible();
  await search.fill("FILTER-1");
  await expect(rows).toHaveCount(1);
  await search.fill("");
  await brand.selectOption("RIVER");
  await expect(rows).toHaveCount(0);
  await category.selectOption("Trucks");
  await expect(rows).toHaveCount(1);
  await stock.selectOption("soldOut");
  await expect(rows).toHaveCount(0);
  await stock.selectOption("all");
  await expect(rows).toHaveCount(1);
  await brand.selectOption("");
  await category.selectOption("");
  await expect(rows).toHaveCount(9);
  await brand.selectOption("nova");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAccessibleName("[TEST] Filter product 8 재고 조정");
  await brand.selectOption("");
  await search.focus();
  await search.press("Tab");
  await expect(category).toBeFocused();
  await category.press("Tab");
  await expect(brand).toBeFocused();
  await brand.press("Tab");
  await expect(stock).toBeFocused();
  const bounds = await Promise.all(
    [search, category, brand, stock].map((control) => control.boundingBox()),
  );
  expect(bounds[0]!.width).toBeLessThanOrEqual(352);
  for (let index = 1; index < bounds.length; index += 1) {
    expect(bounds[index]!.x).toBeGreaterThan(bounds[index - 1]!.x);
    expect(bounds[index]!.y).toBe(bounds[0]!.y);
  }
  const screenshot = testInfo.outputPath("inventory-filters-desktop-1440.png");
  await page.screenshot({ path: screenshot });
  console.log(`Inventory filter desktop screenshot: ${screenshot}`);
  expect(audit.reads).toHaveLength(readsBefore);
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory filters: legacy categories stay selectable and filtering never retargets an existing stock draft", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryFilterProducts,
  });
  const workspace = inventoryWorkspace(page);
  const category = workspace.getByRole("combobox", { name: "카테고리", exact: true });
  const rows = workspace.getByRole("button", { name: / 재고 조정$/ });
  const input = await selectInventory(page, "[TEST] Filter product 0");
  await input.fill("12");
  for (const [value, index] of [
    ["Bottoms", 5],
    ["Acc", 6],
    ["Top", 4],
    ["Wheels", 2],
  ] as const) {
    await category.selectOption(value);
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAccessibleName(`[TEST] Filter product ${index} 재고 조정`);
    await expect(input).toHaveValue("12");
    await expect(workspace.locator("#inventory-adjustment-title")).toHaveAttribute(
      "data-product-id",
      "prd_synthetic_filter_0",
    );
  }
  await category.selectOption("");
  await expect(rows).toHaveCount(9);
  await expect(
    workspace.getByRole("button", {
      name: "[TEST] Filter product 0 재고 조정",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory filters: refresh preserves an explicit no-match filter rather than displaying all with stale hidden state", async ({
  page,
}) => {
  let current = inventoryFilterProducts;
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) => respond(route, { products: current }),
  });
  const workspace = inventoryWorkspace(page);
  const category = workspace.getByRole("combobox", { name: "카테고리", exact: true });
  const brand = workspace.getByRole("combobox", { name: "브랜드", exact: true });
  await category.selectOption("Bottoms");
  await brand.selectOption("NOVA");
  const readsBefore = audit.reads.filter(
    (path) => path === "/prod/admin/catalog/products",
  ).length;
  current = inventoryFilterProducts.filter((product) => product.brandName === "RIVER");
  await workspace.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect
    .poll(
      () =>
        audit.reads.filter((path) => path === "/prod/admin/catalog/products").length,
    )
    .toBe(readsBefore + 1);
  await expect(category).toHaveValue("Bottoms");
  await expect(brand).toHaveValue("NOVA");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(0);
  await category.selectOption("");
  await brand.selectOption("");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(2);
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory filters: long brands and category controls fit mobile 375 and 320 with 44px targets and no stock writes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryFilterProducts,
  });
  const workspace = inventoryWorkspace(page);
  const category = workspace.getByRole("combobox", { name: "카테고리", exact: true });
  const brand = workspace.getByRole("combobox", { name: "브랜드", exact: true });
  const stock = workspace.getByRole("combobox", { name: "재고", exact: true });
  await category.selectOption("Outerwear");
  await brand.selectOption("TEST VERY LONG BRAND NAME FOR NARROW VIEWPORTS");
  await stock.selectOption("low");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(1);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const control of [
      category,
      brand,
      stock,
      workspace.getByRole("searchbox", { name: "상품 검색", exact: true }),
    ]) {
      const bounds = await control.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    const screenshot = testInfo.outputPath(`inventory-filters-mobile-${width}.png`);
    await page.screenshot({ path: screenshot });
    console.log(`Inventory filter mobile screenshot: ${screenshot}`);
  }
  expect(audit.syntheticWrites).toEqual([]);
});
