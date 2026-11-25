import { expect, test } from "@playwright/test";
import { audits, products, respond, setup } from "./admin-navigation-base-fixtures";
import {
  inventoryProducts,
  inventoryWorkspace,
  selectInventory,
} from "./admin-navigation-inventory-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("inventory redesign: stock edits steppers blur and Enter are previews until one confirmed canonical PATCH", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const commands: Record<string, unknown>[] = [];
  let current = { ...inventoryProducts[0] };
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) =>
      respond(route, { products: [current, ...inventoryProducts.slice(1)] }),
    handleProductMutation: async (route) => {
      expect(route.request().method()).toBe("PATCH");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      const command = route.request().postDataJSON() as Record<string, unknown>;
      commands.push(command);
      current = {
        ...current,
        inventoryQuantity: Number(command.stock),
        version: current.version + 1,
      };
      await respond(route, { product: current });
    },
  });
  const input = await selectInventory(page);
  await input.fill("12");
  await input.press("Tab");
  await input.press("Enter");
  await page.getByRole("button", { name: "재고 1개 증가", exact: true }).click();
  await expect(input).toHaveValue("13");
  expect(commands).toEqual([]);
  const workspace = inventoryWorkspace(page);
  await expect(workspace).toContainText("+3");
  await expect(workspace.getByText("아직 미반영", { exact: false })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  const screenshot = testInfo.outputPath("inventory-redesign-desktop-1440.png");
  await page.screenshot({ path: screenshot });
  console.log(`Inventory redesign desktop screenshot: ${screenshot}`);
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await confirm.click();
  expect(commands).toEqual([]);
  await expect(input).toHaveValue("13");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("10");
    expect(dialog.message()).toContain("13");
    void dialog.accept();
  });
  await confirm.click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({ version: 4, stock: 13 });
  await expect(input).toHaveValue("13");
  await expect(
    workspace.getByRole("status").filter({ hasText: "13개로 저장" }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("inventory redesign: malformed or out-of-range quantities stay editable without writes and boundaries remain explicit", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
  });
  const input = await selectInventory(page);
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  for (const invalid of ["", " ", "-3", "1.5", "1e3", "abc", "1,000", "1000001"]) {
    await input.fill(invalid);
    await input.press("Tab");
    await expect(confirm).toBeDisabled();
    expect(audit.syntheticWrites).toEqual([]);
  }
  await input.fill("0");
  await expect(confirm).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "재고 1개 감소", exact: true }),
  ).toBeDisabled();
  await input.fill("1000000");
  await expect(confirm).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "재고 1개 증가", exact: true }),
  ).toBeDisabled();
  await input.fill("10");
  await expect(confirm).toBeDisabled();
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory redesign: SKU and stock filters keyboard row selection preserve correct product targeting", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
  });
  const workspace = inventoryWorkspace(page);
  await workspace
    .getByRole("searchbox", { name: "상품 검색", exact: true })
    .fill("STOCK-B");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(1);
  const item = workspace.getByRole("button", {
    name: `${products[1]!.name} 재고 조정`,
    exact: true,
  });
  await item.focus();
  await item.press("Enter");
  await expect(item).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true }),
  ).toHaveValue("3");
  await workspace.getByRole("searchbox", { name: "상품 검색", exact: true }).fill("");
  const filter = workspace.getByRole("combobox", { name: "재고", exact: true });
  await filter.selectOption("low");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(1);
  await expect(item).toBeVisible();
  await filter.selectOption("soldOut");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(1);
  await expect(
    workspace.getByRole("button", {
      name: "[TEST] Stock product C 재고 조정",
      exact: true,
    }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory redesign: refresh locks changes and a new server version requires an explicit fresh draft", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshArmed = false;
  const commands: Record<string, unknown>[] = [];
  let current = { ...inventoryProducts[0] };
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: async (route) => {
      if (refreshArmed) {
        refreshArmed = false;
        await gate;
        current = { ...current, inventoryQuantity: 20, version: 5 };
      }
      await respond(route, { products: [current] });
    },
    handleProductMutation: async (route) => {
      const command = route.request().postDataJSON() as Record<string, unknown>;
      commands.push(command);
      current = {
        ...current,
        inventoryQuantity: Number(command.stock),
        version: current.version + 1,
      };
      await respond(route, { product: current });
    },
  });
  const input = await selectInventory(page);
  await input.fill("13");
  refreshArmed = true;
  await inventoryWorkspace(page)
    .getByRole("button", { name: "새로고침", exact: true })
    .click();
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  try {
    await expect(confirm).toBeDisabled();
    expect(commands).toEqual([]);
  } finally {
    release();
  }
  const reset = page.getByRole("button", {
    name: "최신 재고로 다시 시작",
    exact: true,
  });
  await expect(inventoryWorkspace(page).getByRole("status")).toHaveText(
    "최신 재고 확인 필요",
  );
  await expect(reset).toBeVisible();
  await expect(confirm).toBeDisabled();
  await expect(input).toHaveValue("13");
  expect(commands).toEqual([]);
  await reset.click();
  await expect(input).toHaveValue("20");
  await page.getByRole("button", { name: "재고 1개 증가", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await confirm.click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({ version: 5, stock: 21 });
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("inventory redesign: a stock conflict reloads canonical stock and cannot silently resend the stale draft", async ({
  page,
}) => {
  let current = { ...inventoryProducts[0] };
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) => respond(route, { products: [current] }),
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      current = { ...current, inventoryQuantity: 8, version: 5 };
      await route.fulfill({
        status: 409,
        json: { code: "CATALOG_VERSION_CONFLICT" },
        headers: { "access-control-allow-origin": "*" },
      });
    },
  });
  const input = await selectInventory(page);
  await input.fill("13");
  page.once("dialog", (dialog) => void dialog.accept());
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  const catalogReads = () =>
    audit.reads.filter((path) => path === "/prod/admin/catalog/products").length;
  // Initial loading may read the catalog more than once; the conflict must add exactly one reload.
  const readsBeforeSave = catalogReads();
  await confirm.click();
  await expect.poll(catalogReads).toBe(readsBeforeSave + 1);
  await expect(inventoryWorkspace(page).getByRole("alert").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "최신 재고로 다시 시작", exact: true }),
  ).toBeVisible();
  await expect(confirm).toBeDisabled();
  expect(commands).toEqual([{ version: 4, stock: 13 }]);
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("inventory redesign: an in-flight write locks duplicate submissions and unknown results are not reported as success", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await gate;
      await route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_RESULT_UNKNOWN" },
        headers: { "access-control-allow-origin": "*" },
      });
    },
  });
  const input = await selectInventory(page);
  await input.fill("13");
  page.once("dialog", (dialog) => void dialog.accept());
  const confirm = page.getByRole("button", {
    name: /^(?:재고 변경 내용 확인|저장 중…)$/,
  });
  await confirm.click();
  await expect.poll(() => commands.length).toBe(1);
  try {
    await expect(confirm).toBeDisabled();
    await expect(input).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "재고 1개 증가", exact: true }),
    ).toBeDisabled();
    await confirm.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    expect(commands).toHaveLength(1);
  } finally {
    release();
  }
  await expect(inventoryWorkspace(page).getByRole("alert").first()).toBeVisible();
  await expect(
    inventoryWorkspace(page)
      .getByRole("status")
      .filter({ hasText: /저장 완료|개로 저장했습니다/ }),
  ).toHaveCount(0);
  expect(commands).toEqual([{ version: 4, stock: 13 }]);
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("inventory redesign: a noncanonical response is rejected and refreshed instead of displaying a fabricated saved result", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
    handleProductMutation: (route) =>
      respond(route, {
        product: { ...inventoryProducts[0], inventoryQuantity: 12, version: 5 },
      }),
  });
  const input = await selectInventory(page);
  const initialCatalogReads = audit.reads.filter(
    (path) => path === "/prod/admin/catalog/products",
  ).length;
  await input.fill("13");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "재고 변경 내용 확인", exact: true }).click();
  await expect
    .poll(
      () =>
        audit.reads.filter((path) => path === "/prod/admin/catalog/products").length,
    )
    .toBe(initialCatalogReads + 1);
  await expect(inventoryWorkspace(page).getByRole("alert").first()).toBeVisible();
  await expect(
    inventoryWorkspace(page)
      .getByRole("status")
      .filter({ hasText: /저장 완료|개로 저장했습니다/ }),
  ).toHaveCount(0);
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("inventory redesign: mobile selection preview and controls reflow at 375 and 320 CSS pixels without stock writes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
  });
  const row = inventoryWorkspace(page).getByRole("button", {
    name: `${products[0]!.name} 재고 조정`,
    exact: true,
  });
  await row.focus();
  await row.press("Enter");
  const input = page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true });
  const heading = inventoryWorkspace(page).getByRole("heading", {
    name: "재고 조정",
    exact: true,
  });
  await expect(heading).toBeFocused();
  const headingBounds = await heading.boundingBox();
  expect(headingBounds!.y).toBeGreaterThanOrEqual(0);
  expect(headingBounds!.y + headingBounds!.height).toBeLessThanOrEqual(844);
  // The label's '?' help comes first, then the stepper.
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "변경 후 재고 수량 도움말", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "재고 1개 감소", exact: true }),
  ).toBeFocused();
  await input.fill("13");
  for (const name of ["재고 1개 감소", "재고 1개 증가"]) {
    const bounds = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  const screenshot = testInfo.outputPath("inventory-redesign-mobile-375.png");
  await page.screenshot({ path: screenshot });
  console.log(`Inventory redesign mobile screenshot: ${screenshot}`);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory redesign: failed stock write plus unavailable reload keeps the result uncertain and blocks a stale retry", async ({
  page,
}) => {
  let reads = 0;
  let rejectReads = false;
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) => {
      reads += 1;
      return !rejectReads
        ? respond(route, { products: inventoryProducts })
        : route.fulfill({
            status: 503,
            json: { code: "SYNTHETIC_READ_UNAVAILABLE" },
            headers: { "access-control-allow-origin": "*" },
          });
    },
    handleProductMutation: (route) =>
      route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_WRITE_UNKNOWN" },
        headers: { "access-control-allow-origin": "*" },
      }),
  });
  const input = await selectInventory(page);
  await input.fill("13");
  const readsBeforeWrite = reads;
  rejectReads = true;
  page.once("dialog", (dialog) => void dialog.accept());
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  await confirm.click();
  await expect(
    inventoryWorkspace(page)
      .getByRole("alert")
      .filter({ hasText: "중복 저장하지 말고" }),
  ).toBeVisible();
  await expect(confirm).toBeDisabled();
  await expect(input).toHaveValue("13");
  await page
    .getByRole("button", { name: "최신 재고로 다시 시작", exact: true })
    .click();
  await expect.poll(() => reads).toBe(readsBeforeWrite + 2);
  await expect(confirm).toBeDisabled();
  await expect(
    inventoryWorkspace(page)
      .getByRole("alert")
      .filter({ hasText: "최신 재고를 불러오지 못했습니다" }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});
