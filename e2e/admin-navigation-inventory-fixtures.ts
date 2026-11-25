// 역할: 재고 필터·편집 검사용 합성 상품과 재고 화면·행 선택 도우미를 제공함.
import { expect, type Page } from "@playwright/test";
import { products } from "./admin-navigation-base-fixtures";

const inventoryProducts = [
  { ...products[0], sku: "STOCK-A", inventoryQuantity: 10, version: 4 },
  { ...products[1], sku: "STOCK-B", inventoryQuantity: 3, version: 7 },
  {
    ...products[1],
    productId: "prd_synthetic_C",
    name: "[TEST] Stock product C",
    sku: "STOCK-C",
    inventoryQuantity: 0,
    version: 2,
  },
];

function inventoryWorkspace(page: Page) {
  return page.locator("#admin-panel-inventory");
}

async function selectInventory(page: Page, name = products[0]!.name) {
  const row = inventoryWorkspace(page).getByRole("button", {
    name: `${name} 재고 조정`,
    exact: true,
  });
  await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  return page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true });
}

const inventoryFilterProducts = [
  ["Deck", "NOVA", 10],
  ["Deck", "NOVA", 3],
  ["Wheels", "NOVA", 0],
  ["Trucks", "RIVER", 5],
  ["Top", "RIVER", 6],
  ["Bottoms", "NOVA", 1],
  ["Acc", "NOVA", 0],
  ["Outerwear", "TEST VERY LONG BRAND NAME FOR NARROW VIEWPORTS", 4],
  ["Other", "nova", 2],
].map(([category, brandName, inventoryQuantity], index) => ({
  ...products[0],
  productId: `prd_synthetic_filter_${index}`,
  name: `[TEST] Filter product ${index}`,
  sku: `FILTER-${index}`,
  category,
  brandName,
  inventoryQuantity,
}));

export {
  inventoryFilterProducts,
  inventoryProducts,
  inventoryWorkspace,
  selectInventory,
};
