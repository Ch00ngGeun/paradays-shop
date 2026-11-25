import { expect, type Locator, type Page } from "@playwright/test";
import { active } from "./admin-navigation-base-fixtures";

async function newProduct(page: Page) {
  await active(page, "products");
  await page.getByRole("button", { name: "새 상품 등록", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "새 상품", exact: true }),
  ).toBeVisible();
}

async function fillProduct(page: Page, name = "SYNTHETIC_REDESIGN_DECK") {
  await page.getByRole("textbox", { name: "상품명", exact: false }).fill(name);
  await page
    .locator("#admin-panel-products")
    .getByRole("textbox", { name: "브랜드", exact: false })
    .fill("NOVA");
  const sku = await page.getByLabel("SKU / 관리 코드", { exact: true }).inputValue();
  expect(sku).toMatch(PRODUCT_SKU_UUID);
  await expect(page.getByLabel("SKU / 관리 코드", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("89000");
  await page.getByRole("spinbutton", { name: /재고/ }).fill("13");
  await addOptions(page, "8.25 inch", "8.5 inch");
  return sku;
}

/** 옵션을 한 개씩 입력하고 '옵션 추가'로 칩을 만듭니다. */
async function addOptions(page: Page, ...options: string[]) {
  const input = page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false });
  for (const option of options) {
    await input.fill(option);
    await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
    await expect(input).toHaveValue("");
  }
}

/** 칩 이름만 순서대로 읽습니다(× 버튼·등록 표시 제외). */
function optionChips(page: Page) {
  return page
    .getByRole("list", { name: "추가된 옵션", exact: true })
    .locator("li > :first-child");
}

async function removeOptions(page: Page, ...options: string[]) {
  for (const option of options)
    await page.getByRole("button", { name: `${option} 삭제`, exact: true }).click();
}

const PRODUCT_SKU_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function productPreview(page: Page) {
  return page.locator("#admin-panel-products aside").first();
}

// Product rows only; the menu-top work flow is a separate list.
const productRows = (panel: Locator) =>
  panel.getByRole("list", { name: "상품 목록", exact: true }).getByRole("listitem");

export {
  addOptions,
  fillProduct,
  newProduct,
  optionChips,
  PRODUCT_SKU_UUID,
  productPreview,
  productRows,
  removeOptions,
};
