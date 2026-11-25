import { expect, test } from "@playwright/test";
import {
  operationRows,
  recentOperations,
} from "./admin-navigation-accessibility-fixtures";
import {
  audits,
  products,
  respond,
  select,
  setup,
} from "./admin-navigation-base-fixtures";
import {
  couponWorkspace,
  fillCoupon,
  savedCoupon,
} from "./admin-navigation-coupon-fixtures";
import { inventoryWorkspace } from "./admin-navigation-inventory-fixtures";
import {
  fillProduct,
  newProduct,
  productPreview,
} from "./admin-navigation-product-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("accessible images: placeholder empty and broken images use marked examples while real images do not", async ({
  page,
}) => {
  const fixture = [
    { ...products[0], image: "/images/product-placeholder.svg" },
    { ...products[1], image: "" },
    {
      ...products[0],
      productId: "prd_image_broken",
      name: "[TEST] Broken image",
      image: "/images/synthetic-image-missing.png",
    },
    {
      ...products[0],
      productId: "prd_image_real",
      name: "[TEST] Real image",
      image: "/images/dekeyzer-deck.webp",
    },
  ];
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: fixture,
  });
  const panel = page.locator("#admin-panel-products");
  await expect(panel.locator('[data-example="true"]')).toHaveCount(3);
  for (const image of await panel.locator('[data-example="true"] img').all())
    await expect(image).toHaveAttribute("src", "/images/admin-board-example.png");
  const real = panel.locator("li").filter({ hasText: "[TEST] Real image" });
  await expect(real.locator('[data-example="true"]')).toHaveCount(0);
  await select(page, "inventory");
  await expect(inventoryWorkspace(page).locator('[data-example="true"]')).toHaveCount(
    3,
  );
  await inventoryWorkspace(page)
    .getByRole("button", { name: "[TEST] Broken image 재고 조정", exact: true })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "재고 조정", exact: true })
      .locator('[data-example="true"]'),
  ).toHaveCount(1);
  expect(audit.syntheticWrites).toEqual([]);
});

test("accessible images: failing example stops at text and a new uploaded image restores the real preview without changing saved fallback payloads", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await respond(route, {});
    },
  });
  let exampleRequests = 0;
  await page.route("**/images/admin-board-example.png", (route) => {
    exampleRequests++;
    return route.fulfill({ status: 404, body: "" });
  });
  await newProduct(page);
  const preview = productPreview(page);
  await expect(preview.getByRole("img")).toHaveCount(0);
  await expect(
    preview.getByText("이미지 없음 · 예시 이미지", { exact: true }),
  ).toBeVisible();
  expect(exampleRequests).toBeLessThanOrEqual(2);
  await page
    .locator('input[type="file"]')
    .and(page.getByLabel("대표 이미지", { exact: false }))
    .setInputFiles({
      name: "synthetic-real.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRfsAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await expect(preview.getByRole("img")).toHaveAttribute("src", /^blob:/);
  await expect(preview.locator('[data-example="true"]')).toHaveCount(0);
  await page.getByRole("button", { name: "새 초안", exact: true }).click();
  await fillProduct(page);
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]!.imageUrl).toBe("/images/product-placeholder.svg");
  expect(JSON.stringify(commands[0])).not.toContain("admin-board-example");
  await select(page, "overview");
  await expect(operationRows(page)).toHaveAttribute("data-status", "draft");
  await expect(operationRows(page)).toContainText("스토어 미공개");
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("accessible operations: mobile cards badges and example previews fit both themes with readable status text", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, {
    path: "/admin?section=coupons",
    handleCouponMutation: savedCoupon,
  });
  await fillCoupon(page);
  await couponWorkspace(page)
    .getByRole("button", { name: "쿠폰 초안 저장", exact: true })
    .click();
  await expect(couponWorkspace(page).getByRole("status")).toBeVisible();
  await select(page, "overview");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 375, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      const status = operationRows(page)
        .locator("span")
        .filter({ hasText: /^임시저장$/ });
      const ratio = await status.evaluate((element) => {
        const style = getComputedStyle(element);
        const rgb = (value: string) =>
          value
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
        const luminance = (value: string) => {
          const values = rgb(value).map((n) => {
            const c = n / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
        };
        const front = luminance(style.color),
          back = luminance(style.backgroundColor);
        return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      for (const action of await recentOperations(page).getByRole("button").all())
        expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({
        path: testInfo.outputPath(`accessible-home-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ forcedColors: "active" });
  await expect(
    operationRows(page).getByText("임시저장", { exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ forcedColors: "none" });
  await select(page, "products");
  await newProduct(page);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expect(
      productPreview(page).getByText("이미지 없음 · 예시 이미지", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`accessible-example-preview-${width}.png`),
      fullPage: true,
    });
  }
  expect(audit.syntheticWrites).toHaveLength(1);
});
