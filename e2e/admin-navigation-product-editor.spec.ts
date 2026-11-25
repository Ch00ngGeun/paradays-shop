// 역할: 상품 초안 미리보기·등록과 상품명 두 줄 제한·입력기(IME)·폭 변화에 따른 입력란 높이, 브랜드 입력을 검증함.
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

  // 첫 줄 끝의 Enter는 빈 줄을 합치고 커서를 제자리에 둠.
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

  // 둘째 줄 끝의 Enter는 두 줄 제한을 안내할 뿐 다른 동작을 하지 않음.
  await caretAt("FIRST\nXSECOND".length);
  await name.press("Enter");
  await expect(name).toHaveValue("FIRST\nXSECOND");
  await expect(status).toContainText("최대 2줄까지 입력할 수 있습니다");

  // 둘째 줄 안의 Enter도 셋째 줄을 만들 수 없으므로 커서 뒤 내용이 사라지지 않음.
  await caretAt("FIRST\nXSECO".length);
  await name.press("Enter");
  await expect(name).toHaveValue("FIRST\nXSECOND");
  await expect(status).toContainText("최대 2줄까지 입력할 수 있습니다");
  await name.pressSequentially("Y");
  await expect(name).toHaveValue("FIRST\nXSECOYND");

  // 붙여넣은 셋째 줄과 빈 줄은 버리지 않고 둘째 줄에 이어 붙임.
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
  // Chromium이 평소 건너뛰는 대체 경로를 강제로 탐.
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS) as (...args: string[]) => boolean;
    CSS.supports = ((...args: string[]) =>
      args[0] === "field-sizing" ? false : supports(...args)) as typeof CSS.supports;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setup(page, { path: "/admin?section=products" });
  // Chromium은 여전히 스타일시트 규칙을 적용하므로 이를 꺼서 구형 브라우저처럼 동작시킴.
  await page.addStyleTag({ content: "textarea { field-sizing: fixed !important; }" });
  await newProduct(page);
  const name = page.getByRole("textbox", { name: "상품명", exact: false });
  await name.fill(`SYNTHETIC ${"LONG NAME ".repeat(8)}`.trim());
  const fits = () =>
    name.evaluate((input) => input.scrollHeight <= input.clientHeight + 1);
  await expect.poll(fits).toBe(true);
  const wide = (await name.boundingBox())!.height;

  // 1023px에서 1024px 데스크톱 배치로 넓히면 다시 렌더링되며 입력란이 좁아짐(약 305px에서 238px).
  await page.setViewportSize({ width: 1023, height: 1000 });
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width: 1024, height: 1000 });
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(fits).toBe(true);

  // 폭 변경이 재렌더링(여기서는 같은 작업 안의 가격 편집)과 함께 일어나도
  // 입력란은 다시 늘어나야 함. 관찰자를 다시 연결하면 새 폭을 시작값으로 삼아 버림.
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

  // 입력란만 좁아져도(회전이나 더 좁은 열처럼) 다시 늘어나야 함.
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
  // 붙여넣은 줄바꿈은 공백이 되고 Enter는 줄을 추가하지 않음.
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
