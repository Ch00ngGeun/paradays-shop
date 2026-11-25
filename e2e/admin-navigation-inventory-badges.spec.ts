import { expect, test } from "@playwright/test";
import { audits, respond, select, setup } from "./admin-navigation-base-fixtures";
import {
  inventoryProducts,
  inventoryWorkspace,
  selectInventory,
} from "./admin-navigation-inventory-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 375, height: 844 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`inventory badges: ${viewport.name} ${theme} uses readable green amber and gray badges in inventory and product lists`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript((value) => {
        localStorage.setItem("paradays-theme", value);
      }, theme);
      const audit = await setup(page, {
        path: "/admin?section=inventory",
        catalogProducts: inventoryProducts,
      });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const expectedBackgrounds =
        theme === "light"
          ? ["rgb(233, 247, 239)", "rgb(255, 245, 214)", "rgb(241, 243, 245)"]
          : ["rgb(20, 45, 33)", "rgb(52, 39, 16)", "rgb(38, 43, 51)"];
      const states = [
        ["normal", "정상", "success"],
        ["low", "주의", "warning"],
        ["outOfStock", "품절", "neutral"],
      ];
      for (const section of ["inventory", "products"] as const) {
        if (section === "products") await select(page, "products");
        const panel = page.locator(`#admin-panel-${section}`);
        for (const [index, [status, label, severity]] of states.entries()) {
          const badge = panel.locator(`[data-stock-status="${status}"]`);
          await expect(badge).toHaveCount(1);
          await expect(badge).toHaveText(label);
          await expect(badge).toHaveAttribute("data-severity", severity);
          await expect(badge).not.toHaveAttribute("role", /alert|status/);
          const colors = await badge.evaluate((element) => {
            const rgb = (value: string) =>
              value
                .match(/[\d.]+/g)!
                .slice(0, 3)
                .map(Number);
            const luminance = (value: string) => {
              const [red, green, blue] = rgb(value).map((channel) => {
                const linear = channel / 255;
                return linear <= 0.04045
                  ? linear / 12.92
                  : ((linear + 0.055) / 1.055) ** 2.4;
              });
              return red * 0.2126 + green * 0.7152 + blue * 0.0722;
            };
            const ratio = (first: string, second: string) => {
              const values = [luminance(first), luminance(second)].sort(
                (a, b) => b - a,
              );
              return (values[0] + 0.05) / (values[1] + 0.05);
            };
            const background = getComputedStyle(element).backgroundColor;
            const text = getComputedStyle(
              element.querySelector("span:last-child > span")!,
            ).color;
            const dot = getComputedStyle(
              element.querySelector('[aria-hidden="true"]')!,
            ).backgroundColor;
            return {
              background,
              text,
              dot,
              textRatio: ratio(background, text),
              dotRatio: ratio(background, dot),
            };
          });
          expect(colors.background).toBe(expectedBackgrounds[index]);
          expect(colors.textRatio).toBeGreaterThanOrEqual(4.5);
          expect(colors.dotRatio).toBeGreaterThanOrEqual(3);
          console.log(
            `Inventory badge ${viewport.name}/${theme}/${section}/${status}: ${JSON.stringify(colors)}`,
          );
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        if (section === "inventory") {
          const screenshot = testInfo.outputPath(
            `stock-badges-${viewport.name}-${theme}.png`,
          );
          await page.screenshot({ path: screenshot, fullPage: true });
          console.log(`Inventory badge screenshot: ${screenshot}`);
        }
      }
      expect(audit.syntheticWrites).toEqual([]);
    });
  }
}

test("inventory badges: draft previews keep the canonical state until a confirmed synthetic save", async ({
  page,
}) => {
  let current = { ...inventoryProducts[0] };
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) => respond(route, { products: [current] }),
    handleProductMutation: (route) => {
      const command = route.request().postDataJSON() as Record<string, unknown>;
      commands.push(command);
      current = {
        ...current,
        inventoryQuantity: Number(command.stock),
        version: current.version + 1,
      };
      return respond(route, { product: current });
    },
  });
  const input = await selectInventory(page);
  const badge = inventoryWorkspace(page).locator("[data-stock-status]");
  let previousStatus = "normal";
  for (const [index, [quantity, status, label]] of [
    ["5", "low", "주의"],
    ["0", "outOfStock", "품절"],
    ["6", "normal", "정상"],
  ].entries()) {
    await input.fill(quantity);
    await input.press("Tab");
    await expect(badge).toHaveAttribute("data-stock-status", previousStatus);
    expect(commands).toHaveLength(index);
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: "재고 변경 내용 확인", exact: true })
      .click();
    await expect(badge).toHaveAttribute("data-stock-status", status);
    await expect(badge).toHaveText(label);
    await expect(input).toHaveValue(quantity);
    expect(commands).toHaveLength(index + 1);
    previousStatus = status;
  }
  expect(commands).toEqual([
    { version: 4, stock: 5 },
    { version: 5, stock: 0 },
    { version: 6, stock: 6 },
  ]);
  expect(audit.syntheticWrites).toHaveLength(3);
});

for (const invalidStock of [undefined, null, -1, 1.5]) {
  test(`inventory badges: invalid API stock ${String(invalidStock)} cannot appear as healthy inventory`, async ({
    page,
  }) => {
    const audit = await setup(page, {
      path: "/admin?section=inventory",
      catalogProducts: [{ ...inventoryProducts[0], inventoryQuantity: invalidStock }],
    });
    const panel = inventoryWorkspace(page);
    await expect(panel.getByRole("alert")).toContainText(
      "재고 목록을 불러오지 못했습니다",
    );
    await expect(panel.locator("[data-stock-status]")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(0);
    expect(audit.syntheticWrites).toEqual([]);
  });
}
