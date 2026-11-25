import { expect, test } from "@playwright/test";
import {
  audits,
  products,
  respond,
  select,
  setup,
} from "./admin-navigation-base-fixtures";
import {
  fillProduct,
  newProduct,
  optionChips,
  productPreview,
  removeOptions,
} from "./admin-navigation-product-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("product redesign: desktop draft updates the customer preview while remaining private and unsaved", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  await fillProduct(page);
  const preview = productPreview(page);
  await expect(
    preview.getByRole("heading", { name: "SYNTHETIC_REDESIGN_DECK", exact: true }),
  ).toBeVisible();
  await expect(preview).toContainText("NOVA");
  await expect(preview).toContainText("89,000");
  await expect(preview).toContainText("8.25 inch");
  await expect(preview).toContainText("8.5 inch");
  await expect(preview).toContainText("비공개");
  await expect(page.getByRole("spinbutton", { name: /재고/ })).toHaveValue("13");
  await expect(page.getByRole("checkbox", { name: /스토어.*공개/ })).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "비공개로 저장", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  const screenshot = testInfo.outputPath("product-redesign-desktop-1440.png");
  await page.screenshot({ path: screenshot });
  console.log(`Product redesign desktop screenshot: ${screenshot}`);
});

test("product redesign: empty and missing-option public submissions do not write a product", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "상품명, 브랜드, 판매가",
  );
  await fillProduct(page);
  await removeOptions(page, "8.25 inch", "8.5 inch");
  await expect(optionChips(page)).toHaveCount(0);
  await page.getByRole("checkbox", { name: /스토어.*공개/ }).check();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "최소 한 개의 옵션",
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("product redesign: a private create sends the generated SKU stock options and translated fields exactly once", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  const sku = await fillProduct(page);
  await page.getByRole("checkbox", { name: "신상품 배지 표시", exact: true }).check();
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    name: "SYNTHETIC_REDESIGN_DECK",
    brand: "NOVA",
    category: "Deck",
    sku,
    price: "89000",
    stock: "13",
    sizes: "8.25 inch, 8.5 inch",
    isVisible: false,
    isFeatured: true,
    sourceLocale: "ko",
    nameI18n: { en: "SYNTHETIC_REDESIGN_DECK", ko: "SYNTHETIC_REDESIGN_DECK" },
  });
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product form refinement: a two-line product name grows the box, keeps one line break and stops at two lines", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  await fillProduct(page, "SYNTHETIC_ONE_LINE");
  const name = page.getByRole("textbox", { name: "상품명", exact: false });
  await name.fill("A");
  const oneLine = (await name.boundingBox())!.height;
  const status = page.getByRole("status").filter({ hasText: "최대 2줄" });

  await name.fill("FIRST\nSECOND");
  await expect
    .poll(async () => (await name.boundingBox())!.height)
    .toBeGreaterThan(oneLine * 1.4);

  // Enter at the end of the first line collapses the blank line and keeps the caret in place.
  const caretAt = (position: number) =>
    name.evaluate(
      (input: HTMLTextAreaElement, at) => input.setSelectionRange(at, at),
      position,
    );
  await caretAt("FIRST".length);
  await name.press("Enter");
  await expect(name).toHaveValue("FIRST\nSECOND");
  await name.pressSequentially("X");
  await expect(name).toHaveValue("FIRST\nXSECOND");

  // Enter at the end of the second line does nothing but explain the two-line limit.
  await caretAt("FIRST\nXSECOND".length);
  await name.press("Enter");
  await expect(name).toHaveValue("FIRST\nXSECOND");
  await expect(status).toContainText("최대 2줄까지 입력할 수 있습니다");

  // Enter inside the second line cannot start a third line, so nothing after the caret is lost.
  await caretAt("FIRST\nXSECO".length);
  await name.press("Enter");
  await expect(name).toHaveValue("FIRST\nXSECOND");
  await expect(status).toContainText("최대 2줄까지 입력할 수 있습니다");
  await name.pressSequentially("Y");
  await expect(name).toHaveValue("FIRST\nXSECOYND");

  // A pasted third line and blank lines are joined to the second line instead of being dropped.
  await name.fill("FIRST\n\n\nSECOND\nTHIRD");
  await expect(name).toHaveValue("FIRST\nSECOND THIRD");
  await expect(status).toContainText("2번째 줄 뒤에 이어 붙였습니다");

  await name.fill("SYNTHETIC_FIRST_LINE\nSYNTHETIC_SECOND_LINE");
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  const saved = String(commands[0]!.name);
  expect(saved.match(/\n/g)).toHaveLength(1);
  expect(saved).toBe("SYNTHETIC_FIRST_LINE\nSYNTHETIC_SECOND_LINE");
});

test("product form refinement: Enter that commits Korean IME input never starts a third product name line", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  const name = page.getByRole("textbox", { name: "상품명", exact: false });
  await name.fill("FIRST\nSECOND");
  await name.evaluate((input: HTMLTextAreaElement) =>
    input.setSelectionRange(input.value.length, input.value.length),
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "한",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await page.keyboard.press("Enter");
  await cdp.send("Input.insertText", { text: "한" });
  await expect(name).toHaveValue("FIRST\nSECOND한");
});

test("product form refinement: without field-sizing the product name box regrows when it gets narrower", async ({
  page,
}) => {
  // Forces the fallback path that Chromium would otherwise skip.
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS) as (...args: string[]) => boolean;
    CSS.supports = ((...args: string[]) =>
      args[0] === "field-sizing" ? false : supports(...args)) as typeof CSS.supports;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setup(page, { path: "/admin?section=products" });
  // Chromium would still apply the stylesheet rule, so it is switched off to act like an older browser.
  await page.addStyleTag({ content: "textarea { field-sizing: fixed !important; }" });
  await newProduct(page);
  const name = page.getByRole("textbox", { name: "상품명", exact: false });
  await name.fill(`SYNTHETIC ${"LONG NAME ".repeat(8)}`.trim());
  const fits = () =>
    name.evaluate((input) => input.scrollHeight <= input.clientHeight + 1);
  await expect.poll(fits).toBe(true);
  const wide = (await name.boundingBox())!.height;

  // Widening from 1023px to the 1024px desktop layout re-renders and narrows the box (about 305px to 238px).
  await page.setViewportSize({ width: 1023, height: 1000 });
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width: 1024, height: 1000 });
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(fits).toBe(true);

  // A width change that lands together with a re-render (here a price edit in the same task)
  // must still regrow the box; a reconnected observer would take the new width as its start.
  await name.evaluate((input) => {
    input.style.width = "120px";
    const price = document.querySelector<HTMLInputElement>(
      'input[inputmode="numeric"]',
    )!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setValue.call(price, "12345");
    price.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(fits).toBe(true);
  await name.evaluate((input) => {
    input.style.width = "";
  });

  // Narrowing only the box (as a rotation or a narrower column would) must regrow it.
  await name.evaluate((input) => {
    input.style.width = "160px";
  });
  await expect
    .poll(async () => (await name.boundingBox())!.height)
    .toBeGreaterThan(wide);
  await expect.poll(fits).toBe(true);
});

test("product form refinement: a long brand grows its box while typing and stays on one line", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  const brand = page
    .locator("#admin-panel-products")
    .getByRole("textbox", { name: "브랜드", exact: false });
  await brand.fill("A");
  const oneLine = (await brand.boundingBox())!.height;
  await brand.fill(`SYNTHETIC ${"LONG BRAND ".repeat(8)}`.trim());
  await expect
    .poll(async () => (await brand.boundingBox())!.height)
    .toBeGreaterThan(oneLine * 1.4);
  expect(
    await brand.evaluate((input) => input.scrollHeight <= input.clientHeight + 1),
  ).toBe(true);
  // A pasted line break becomes a space, and Enter never adds a line.
  await brand.fill("Synthetic\nBrand");
  await expect(brand).toHaveValue("Synthetic Brand");
  await brand.press("Enter");
  await expect(brand).toHaveValue("Synthetic Brand");
  expect(audit.syntheticWrites).toEqual([]);
});

test("product form refinement: the two-line notice does not follow the admin to another product", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=products", products: true });
  const openEditor = async (productName: string) => {
    await page
      .getByRole("listitem")
      .filter({ hasText: productName })
      .getByRole("button", { name: "수정", exact: true })
      .click();
  };
  await openEditor(products[0]!.name);
  const name = page.getByRole("textbox", { name: "상품명", exact: false });
  await name.fill("FIRST\nSECOND\nTHIRD");
  const notice = page.getByRole("status").filter({ hasText: "최대 2줄" });
  await expect(notice).toBeVisible();
  await select(page, "products");
  await openEditor(products[1]!.name);
  await expect(name).toHaveValue(products[1]!.name);
  await expect(notice).toHaveCount(0);
});
