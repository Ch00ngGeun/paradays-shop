import { expect, test } from "@playwright/test";
import { DECK, PLAIN, SPEC, setup } from "./deck-size-spec-fixtures";

test("the storefront shows a size chart with inches and cm only when the product has a spec", async ({
  page,
}) => {
  const audit = await setup(page, `/products/${DECK.slug}`, SPEC);
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();

  await page.getByRole("button", { name: "상세사이즈" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: "[TEST] Deck size A" })).toBeVisible();
  for (const text of ['6.875"', "(17.5cm)", '31.75"', "(80.6cm)", '14.25"', "(36.2cm)"])
    await expect(dialog.locator("svg")).toContainText(text);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.goto(`/products?slug=${PLAIN.slug}`);
  await expect(page.getByRole("heading", { name: "[TEST] Deck size B" })).toBeVisible();
  await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);
  expect(audit.blocked).toEqual([]);
});

test("a product name entered on two lines shows on two lines on the product page", async ({
  page,
}) => {
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    name: "[TEST] Two line\nDeck",
  });
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  expect(await heading.innerText()).toBe("[TEST] Two line\nDeck");
  const lineHeight = await heading.evaluate((h1) =>
    parseFloat(getComputedStyle(h1).lineHeight),
  );
  expect((await heading.boundingBox())!.height).toBeGreaterThan(lineHeight * 1.5);
  expect(audit.blocked).toEqual([]);
});

for (const width of [1280, 375]) {
  test(`saved product name line breaks survive home and menu filtering at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const name = "[TEST] Two\nDeck";
    const audit = await setup(page, "/", undefined, { name });
    const grid = page.getByRole("list", { name: "PARADAYS products" });
    const card = grid.getByRole("listitem").filter({ hasText: "[TEST] Two" });
    const plain = grid.getByRole("listitem").filter({ hasText: "[TEST] Deck size B" });
    const checkLayout = async () => {
      const heading = card.getByRole("heading", { level: 2 });
      await expect(heading).toBeVisible();
      expect(await heading.innerText()).toBe(name);
      const layout = await card.evaluate((item) => {
        const title = item.querySelector("h2")!;
        const price = item.querySelector("p")!;
        const imageSlot = item.querySelector("img")!.parentElement!;
        const titleBox = title.getBoundingClientRect();
        const priceBox = price.getBoundingClientRect();
        const mediaBox = imageSlot.getBoundingClientRect();
        const cardBox = item.getBoundingClientRect();
        return {
          titleHeight: titleBox.height,
          lineHeight: parseFloat(getComputedStyle(title).lineHeight),
          priceTop: priceBox.top,
          titleBottom: titleBox.bottom,
          mediaBottom: mediaBox.bottom,
          titleTop: titleBox.top,
          mediaHeight: mediaBox.height,
          mediaWidth: mediaBox.width,
          cardBottom: cardBox.bottom,
          priceBottom: priceBox.bottom,
          left: cardBox.left,
          right: cardBox.right,
        };
      });
      expect(layout.titleHeight).toBeGreaterThan(layout.lineHeight * 1.5);
      expect(layout.titleHeight).toBeLessThan(layout.lineHeight * 2.1);
      expect(layout.titleTop).toBeGreaterThanOrEqual(layout.mediaBottom);
      expect(layout.priceTop).toBeGreaterThanOrEqual(layout.titleBottom);
      expect(layout.cardBottom).toBeGreaterThanOrEqual(layout.priceBottom);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(width);
      await expect(plain).toBeVisible();
      const plainImage = await plain.locator("img").boundingBox();
      expect(plainImage!.height).toBeCloseTo(layout.mediaHeight, 0);
      expect(plainImage!.width).toBeCloseTo(layout.mediaWidth, 0);
    };
    await checkLayout();
    const before = await grid.locator("h2").allTextContents();

    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (width < 768) await menu.click();
    else await menu.press("ArrowDown");
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const dropdown = page.locator("#store-menu-dropdown");
    await dropdown.getByRole("button", { name: "데크", exact: true }).press("Enter");
    await menu.press("Enter");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await checkLayout();
    const after = await grid.locator("h2").allTextContents();
    expect(after).toEqual(before.filter((title) => after.includes(title)));
    expect(audit.patches).toEqual([]);
    expect(audit.blocked).toEqual([]);
  });
}

test("the storefront size chart follows the selected size and falls back to the default", async ({
  page,
}) => {
  const option = { ...SPEC, width: 8.25, wheelbase: 14 };
  const audit = await setup(page, `/products/${DECK.slug}`, SPEC, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.25": option },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  const openChart = async () => {
    await page.getByRole("button", { name: "상세사이즈" }).click();
    const svg = page.getByRole("dialog").locator("svg");
    await expect(svg).toBeVisible();
    return svg;
  };

  // The first size is selected and has its own values.
  await expect(page.getByRole("button", { name: "8.25", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  let svg = await openChart();
  for (const text of ['8.25"', "(21.0cm)", '14"', "(35.6cm)"])
    await expect(svg).toContainText(text);
  await expect(svg).not.toContainText('14.25"');
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "8.5", exact: true }).click();
  svg = await openChart();
  for (const text of ['8.5"', "(21.6cm)", '14.25"', "(36.2cm)"])
    await expect(svg).toContainText(text);
  await expect(svg).not.toContainText('8.25"');
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);
});

test("without a default, only a size with its own values shows the size chart", async ({
  page,
}) => {
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": SPEC },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);

  await page.getByRole("button", { name: "8.5", exact: true }).click();
  await page.getByRole("button", { name: "상세사이즈" }).click();
  await expect(page.getByRole("dialog").locator("svg")).toContainText('14.25"');
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "8.25", exact: true }).click();
  await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);
  expect(audit.blocked).toEqual([]);
});

test("a legacy duplicate option chip is removed alone, by its position", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", undefined, {
    sizes: ["M", "M", "L"],
  });
  await page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const chips = page
    .getByRole("list", { name: "추가된 옵션" })
    .locator("li > :first-child > span:first-child");
  await expect(chips).toHaveText(["M", "M", "L"]);
  await page.getByRole("button", { name: "M 삭제", exact: true }).nth(1).click();
  await expect(chips).toHaveText(["M", "L"]);

  page.once("dialog", (prompt) => void prompt.accept());
  await page.getByRole("button", { name: /수정 저장/ }).click();
  await expect.poll(() => audit.patches.length).toBe(1);
  expect(audit.patches[0]).toMatchObject({ version: 3, sizes: "M, L" });
  expect(audit.blocked).toEqual([]);
});
