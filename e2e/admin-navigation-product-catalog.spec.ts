// 역할: 관리자 상품 목록의 필터·선택·삭제, 빈/실패 목록, 저장 거부, 이미지 업로드와 모바일 편집을 검증함.
import { expect, test } from "@playwright/test";
import { audits, products, respond, setup } from "./admin-navigation-base-fixtures";
import {
  fillProduct,
  newProduct,
  productPreview,
  productRows,
} from "./admin-navigation-product-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("product redesign: SKU and status filters keyboard and pointer selection and confirmed synthetic deletion retain their contracts", async ({
  page,
}) => {
  let items = [
    { ...products[0], sku: "SKU-A", status: "DRAFT", version: 4 },
    {
      ...products[1],
      sku: "SKU-B",
      status: "PUBLISHED",
      inventoryQuantity: 0,
      version: 7,
    },
  ];
  const deleted: { path: string; version: unknown }[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleCatalog: (route) => respond(route, { products: items }),
    handleProductMutation: async (route) => {
      expect(route.request().method()).toBe("DELETE");
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      deleted.push({ path, version: body.version });
      items = items.filter((item) => !path.endsWith(item.productId!));
      await respond(route, {});
    },
  });
  const panel = page.locator("#admin-panel-products");
  await panel.getByRole("searchbox", { name: "상품 검색", exact: true }).fill("SKU-A");
  await expect(productRows(panel)).toHaveCount(1);
  await expect(productRows(panel)).toContainText(products[0]!.name);
  await panel.getByRole("searchbox", { name: "상품 검색", exact: true }).fill("");
  await panel
    .getByRole("combobox", { name: "상태", exact: true })
    .selectOption("published");
  await expect(productRows(panel)).toHaveCount(1);
  await expect(productRows(panel)).toContainText(products[1]!.name);
  await panel.getByRole("combobox", { name: "상태", exact: true }).selectOption("all");
  await panel
    .getByRole("combobox", { name: "재고", exact: true })
    .selectOption("soldOut");
  await expect(productRows(panel)).toHaveCount(1);
  await expect(productRows(panel)).toContainText(products[1]!.name);
  await panel.getByRole("combobox", { name: "재고", exact: true }).selectOption("all");
  const first = panel.getByRole("button", {
    name: `${products[0]!.name} 선택`,
    exact: true,
  });
  await first.focus();
  await first.press("Space");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await first.press("Enter");
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await panel
    .getByRole("button", { name: `${products[1]!.name} 선택`, exact: true })
    .click();
  const remove = panel.getByRole("button", { name: "선택 삭제 (2)", exact: true });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await remove.click();
  expect(deleted).toEqual([]);
  await expect(productRows(panel)).toHaveCount(2);
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect.poll(() => deleted.length).toBe(2);
  expect(deleted).toEqual([
    { path: "/prod/admin/catalog/products/prd_synthetic_A", version: 4 },
    { path: "/prod/admin/catalog/products/prd_synthetic_B", version: 7 },
  ]);
  await expect(productRows(panel)).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([
    "DELETE https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
    "DELETE https://api.sales.test/prod/admin/catalog/products/prd_synthetic_B",
  ]);
});

test("product redesign: empty and failed catalog states do not invent sample products", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleCatalog: (route) =>
      route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_CATALOG_UNAVAILABLE" },
        headers: { "access-control-allow-origin": "*" },
      }),
  });
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "상품 목록을 불러오지 못했습니다",
  );
  await expect(productRows(page.locator("#admin-panel-products"))).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
});

test("product redesign: rejected save leaves the entered draft editable and is not reported as saved", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: (route) =>
      route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_SAVE_UNAVAILABLE" },
        headers: { "access-control-allow-origin": "*" },
      }),
  });
  await newProduct(page);
  const sku = await fillProduct(page);
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "상품을 저장하지 못했습니다",
  );
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "SYNTHETIC_REDESIGN_DECK",
  );
  await expect(page.getByLabel("SKU / 관리 코드", { exact: true })).toHaveValue(sku);
  await expect(
    page.getByRole("button", { name: "비공개로 저장", exact: true }),
  ).toBeEnabled();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product redesign: local image preview uploads only to synthetic targets and never saves a blob URL", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    productImageFixture: true,
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  await fillProduct(page);
  await page
    .locator('input[type="file"]')
    .and(page.getByLabel("대표 이미지", { exact: false }))
    .setInputFiles({
      name: "synthetic-redesign-upload.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRfsAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await expect(productPreview(page).getByRole("img")).toHaveAttribute("src", /^blob:/);
  const beforeSave = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      session: { ...sessionStorage },
      local: { ...localStorage },
    }),
  );
  expect(beforeSave).not.toContain("blob:");
  expect(beforeSave).not.toContain("synthetic-redesign-upload.png");
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    imageUrl: "https://cdn.redesign.test/product.png",
    isVisible: false,
  });
  expect(JSON.stringify(commands[0])).not.toContain("blob:");
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/uploads",
    "PUT https://upload.redesign.test/image",
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product redesign: mobile editor and preview stay usable within 375 CSS pixels", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const audit = await setup(page, { path: "/admin?section=products", products: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await newProduct(page);
  await fillProduct(page, "SYNTHETIC_MOBILE_DECK");
  await expect(productPreview(page)).toContainText("SYNTHETIC_MOBILE_DECK");
  await expect(productPreview(page)).toContainText("8.25 inch");
  await expect(
    page.getByRole("button", { name: "비공개로 저장", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(audit.syntheticWrites).toEqual([]);
  await page.evaluate(() => scrollTo(0, 0));
  const screenshot = testInfo.outputPath("product-redesign-mobile-375.png");
  await page.screenshot({ path: screenshot });
  console.log(`Product redesign mobile screenshot: ${screenshot}`);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
