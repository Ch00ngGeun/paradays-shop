import { expect, test } from "@playwright/test";
import { audits, products, respond, setup } from "./admin-navigation-base-fixtures";
import {
  fillProduct,
  newProduct,
  productPreview,
} from "./admin-navigation-product-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("product form refinement: a spaced search finds a product whose name has a line break", async ({
  page,
}) => {
  await setup(page, {
    path: "/admin?section=products",
    catalogProducts: [
      {
        ...products[0]!,
        name: "[TEST] Two line\nsearch deck",
        brandName: "NEW  BALANCE",
      },
      products[1]!,
    ],
  });
  const search = page
    .getByRole("searchbox", { name: "상품 검색", exact: true })
    .first();
  await search.fill("two line search");
  const list = page.getByRole("list", { name: "상품 목록" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("listitem")).toContainText("search deck");
  await search.fill("TWO   LINE\tSEARCH");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  // A brand stored with two spaces is found by the same text typed as is.
  await search.fill("NEW  BALANCE");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("listitem")).toContainText("search deck");
});

test("product redesign: publishing requires a deliberate confirmation and dismissing it leaves the draft untouched", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  await fillProduct(page);
  await page.getByRole("checkbox", { name: /스토어.*공개/ }).check();
  await expect(productPreview(page)).toContainText("공개 예정");
  let confirmations = 0;
  page.once("dialog", (dialog) => {
    confirmations += 1;
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  expect(confirmations).toBe(1);
  expect(commands).toEqual([]);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "SYNTHETIC_REDESIGN_DECK",
  );
  page.once("dialog", (dialog) => {
    confirmations += 1;
    void dialog.accept();
  });
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(confirmations).toBe(2);
  expect(commands[0]).toMatchObject({ isVisible: true, sizes: "8.25 inch, 8.5 inch" });
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product redesign: an already-published edit preserves publication and submits the original product version", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: [
      { ...products[0], status: "PUBLISHED", sku: "EXISTING-SKU", version: 7 },
    ],
    handleProductMutation: async (route) => {
      expect(route.request().method()).toBe("PATCH");
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await expect(page.getByRole("checkbox", { name: /스토어.*공개/ })).toBeChecked();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("SYNTHETIC_EDITED_PUBLIC_DECK");
  page.on("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "공개 상태로 수정 저장", exact: true })
    .click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    name: "SYNTHETIC_EDITED_PUBLIC_DECK",
    version: 7,
    sku: "EXISTING-SKU",
    isVisible: true,
  });
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});
