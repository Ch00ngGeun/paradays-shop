// 역할: 상품 관리 코드·브랜드 선택·데크/휠 옵션의 명시적 추가와 옵션 개수·길이 한도, 편집기 전환 시 선택 폐기를 검증함.
import { expect, test } from "@playwright/test";
import {
  audits,
  products,
  respond,
  select,
  setup,
} from "./admin-navigation-base-fixtures";
import {
  addOptions,
  fillProduct,
  newProduct,
  optionChips,
  PRODUCT_SKU_UUID,
  productPreview,
  removeOptions,
} from "./admin-navigation-product-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("product form refinement: generated management codes remain private and stable until an explicit new draft", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  const code = page.getByRole("textbox", { name: "SKU / 관리 코드", exact: true });
  const firstCode = await code.inputValue();
  expect(firstCode).toMatch(PRODUCT_SKU_UUID);
  expect(firstCode).not.toBe(new URL(page.url()).searchParams.get("editor"));
  await expect(code).toHaveAttribute("readonly", "");
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_SKU_DRAFT");
  await page
    .getByRole("combobox", { name: "카테고리", exact: true })
    .selectOption("Wheels");
  await expect(code).toHaveValue(firstCode);
  const editorUrl = page.url();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(editorUrl);
  await expect(code).toHaveValue(firstCode);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "TEST_SKU_DRAFT",
  );
  const persistentSurfaces = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      session: { ...sessionStorage },
      local: { ...localStorage },
    }),
  );
  expect(persistentSurfaces).not.toContain(firstCode);
  await page.getByRole("button", { name: "새 초안", exact: true }).click();
  const resetCode = await code.inputValue();
  expect(resetCode).toMatch(PRODUCT_SKU_UUID);
  expect(resetCode).not.toBe(firstCode);
  await page.getByRole("button", { name: "← 목록으로", exact: true }).click();
  await newProduct(page);
  const nextCode = await code.inputValue();
  expect(nextCode).toMatch(PRODUCT_SKU_UUID);
  expect([firstCode, resetCode]).not.toContain(nextCode);
  expect(audit.syntheticWrites).toEqual([]);
});

test("product form refinement: a legacy product without a management code stays blank across editing and reset", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    products: true,
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const code = page.getByRole("textbox", { name: "SKU / 관리 코드", exact: true });
  await expect(code).toHaveValue("");
  await expect(code).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "입력 초기화", exact: true }).click();
  await expect(code).toHaveValue("");
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_LEGACY_EMPTY_SKU");
  await page.getByRole("textbox", { name: "브랜드", exact: false }).fill("TEST");
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("10000");
  await page.getByRole("button", { name: "비공개 수정 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    version: 1,
    name: "TEST_LEGACY_EMPTY_SKU",
    isVisible: false,
  });
  expect(commands[0]).not.toHaveProperty("sku");
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});

test("product form refinement: brand typing and the right-hand choice list retain the exact selected or custom brand", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: [
      { ...products[0], brandName: "NOVA" },
      { ...products[1], brandName: " nova " },
      { ...products[1], productId: "prd_synthetic_C", brandName: "RIVER" },
    ],
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  const input = page.getByRole("textbox", { name: "브랜드", exact: false });
  const choice = page.getByRole("combobox", { name: "브랜드 선택", exact: true });
  const labels = await choice.locator("option").allTextContents();
  expect(labels.filter((label) => label.trim().toLowerCase() === "nova")).toEqual([
    "NOVA",
  ]);
  expect(labels).toContain("RIVER");
  expect(labels).toContain("기타");
  await input.fill("TEST_MANUAL_BRAND");
  await choice.selectOption({ label: "RIVER" });
  await expect(input).toHaveValue("RIVER");
  await expect(productPreview(page)).toContainText("RIVER");
  await choice.selectOption({ label: "기타" });
  await input.fill("TEST_CUSTOM_BRAND");
  await expect(productPreview(page)).toContainText("TEST_CUSTOM_BRAND");
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_CUSTOM_BRAND_DECK");
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("10000");
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ brand: "TEST_CUSTOM_BRAND", isVisible: false });
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product form refinement: deck choices append only explicitly and category changes preserve legacy multi-options", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  const raw = page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false });
  const chooser = page.getByRole("combobox", { name: "데크 규격 선택", exact: true });
  const labels = await chooser.locator("option").allTextContents();
  for (const width of ["7.5", "7.75", "8.0", "8.125", "8.25", "8.5"]) {
    expect(labels.some((label) => label.includes(width))).toBe(true);
  }
  expect(labels.some((label) => /직접\s*입력/.test(label))).toBe(true);
  const legacy = ["8.25\u2033", "SPECIAL / blue"];
  await addOptions(page, ...legacy);
  await expect(optionChips(page)).toHaveText(legacy);
  // 고른 폭은 명시적으로 추가하기 전까지 옵션이 아님.
  await chooser.selectOption("8.125");
  await expect(optionChips(page)).toHaveText(legacy);
  await expect(productPreview(page)).not.toContainText("8.125”");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(optionChips(page)).toHaveText([...legacy, "8.125”"]);
  await expect(productPreview(page)).toContainText("8.125”");
  await chooser.selectOption("8.125");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(optionChips(page)).toHaveText([...legacy, "8.125”"]);
  await expect(
    page.getByRole("status").filter({ hasText: "이미 있는 옵션입니다." }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "카테고리", exact: true })
    .selectOption("Wheels");
  await expect(optionChips(page)).toHaveText([...legacy, "8.125”"]);
  await expect(chooser).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "바퀴 크기 선택", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "카테고리", exact: true })
    .selectOption("Deck");
  await expect(optionChips(page)).toHaveText([...legacy, "8.125”"]);
  await chooser.selectOption("manual");
  await expect(raw).toBeFocused();
  await expect(raw).toHaveValue("");
  // 실제 양식 제출 횟수를 세므로 검증이 저장을 막더라도 preventDefault 누락은 실패함.
  await page.evaluate(() => {
    const state = window as unknown as { __submits: number };
    state.__submits = 0;
    document.addEventListener("submit", () => (state.__submits += 1), true);
  });
  const submits = () =>
    page.evaluate(() => (window as unknown as { __submits: number }).__submits);
  await raw.fill("TEST_CUSTOM_8.375");
  await raw.press("Enter");
  await expect(raw).toHaveValue("");
  await expect(optionChips(page)).toHaveText([
    ...legacy,
    "8.125”",
    "TEST_CUSTOM_8.375",
  ]);
  await expect(productPreview(page)).toContainText("TEST_CUSTOM_8.375");
  const removeBox = (await page
    .getByRole("button", { name: "TEST_CUSTOM_8.375 삭제", exact: true })
    .boundingBox())!;
  expect(removeBox.height).toBeGreaterThanOrEqual(44);
  expect(removeBox.width).toBeGreaterThanOrEqual(44);
  // Enter는 옵션만 추가했고 상품 양식을 제출하지 않았음.
  expect(await submits()).toBe(0);
  // 대조군: 저장 버튼은 실제로 제출하므로 카운터가 제출을 잡아낼 수 있음.
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(submits).toBe(1);
  expect(audit.syntheticWrites).toEqual([]);
});

test("product form refinement: wheel size and hardness ranges form one complete purchase option in the save payload", async ({
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
  await fillProduct(page, "TEST_WHEEL_COMPOSITE");
  const raw = page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false });
  await removeOptions(page, "8.25 inch", "8.5 inch");
  await expect(optionChips(page)).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "카테고리", exact: true })
    .selectOption("Wheels");
  const diameter = page.getByRole("combobox", { name: "바퀴 크기 선택", exact: true });
  const hardness = page.getByRole("combobox", { name: "경도 선택", exact: true });
  const diameterValues = await diameter
    .locator("option")
    .evaluateAll((items) =>
      items
        .map((item) => (item as HTMLOptionElement).value)
        .filter((value) => /^\d+$/.test(value)),
    );
  const hardnessValues = await hardness
    .locator("option")
    .evaluateAll((items) =>
      items
        .map((item) => (item as HTMLOptionElement).value)
        .filter((value) => /^\d+$/.test(value)),
    );
  expect(diameterValues).toEqual(
    Array.from({ length: 11 }, (_, index) => String(index + 50)),
  );
  expect(hardnessValues).toEqual(
    Array.from({ length: 22 }, (_, index) => String(index + 80)),
  );
  const add = page.getByRole("button", { name: "옵션 추가", exact: true });
  await diameter.selectOption("54");
  await expect(raw).toHaveValue("");
  await expect(optionChips(page)).toHaveCount(0);
  await expect(add).toBeDisabled();
  const publish = page.getByRole("checkbox", {
    name: "저장 후 스토어에 공개",
    exact: true,
  });
  await publish.check();
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "최소 한 개의 옵션",
  );
  expect(commands).toEqual([]);
  await hardness.selectOption("99");
  await expect(raw).toHaveValue("");
  await expect(optionChips(page)).toHaveCount(0);
  await expect(productPreview(page)).not.toContainText("54mm / 99a");
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "최소 한 개의 옵션",
  );
  expect(commands).toEqual([]);
  await publish.uncheck();
  await add.click();
  await expect(optionChips(page)).toHaveText(["54mm / 99a"]);
  await expect(raw).toHaveValue("");
  await expect(productPreview(page)).toContainText("54mm / 99a");
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    category: "Wheels",
    sizes: "54mm / 99a",
    isVisible: false,
  });
  expect(String(commands[0]!.sizes).split(",")).toHaveLength(1);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product form refinement: option count and length limits stop adding without erasing the entered text", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  await fillProduct(page);
  const raw = page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false });
  const chooser = page.getByRole("combobox", { name: "데크 규격 선택", exact: true });
  const twenty = [
    "8.25 inch",
    "8.5 inch",
    ...Array.from({ length: 18 }, (_, index) => `LEGACY_${index}`),
  ];
  await addOptions(page, ...twenty.slice(2));
  await expect(optionChips(page)).toHaveText(twenty);
  await chooser.selectOption("7.5");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(optionChips(page)).toHaveText(twenty);
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "20",
  );
  await raw.fill("OVERFLOW");
  await raw.press("Enter");
  await expect(raw).toHaveValue("OVERFLOW");
  await expect(optionChips(page)).toHaveText(twenty);
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "20",
  );
  await removeOptions(page, "LEGACY_17");
  const tooLong = "한".repeat(51);
  await raw.fill(tooLong);
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(raw).toHaveValue(tooLong);
  await expect(optionChips(page)).toHaveText(twenty.slice(0, 19));
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "50",
  );
  // 거부된 추가 전에 고른 폭이 선택된 채 남으므로 빈 입력 검사를 위해 해제함.
  await chooser.selectOption("");
  await raw.fill("8.75, 9.0");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "쉼표",
  );
  await raw.fill("");
  await expect(
    page.getByRole("button", { name: "옵션 추가", exact: true }),
  ).toBeDisabled();
  await expect(optionChips(page)).toHaveText(twenty.slice(0, 19));
  expect(audit.syntheticWrites).toEqual([]);
});

test("product form refinement: exactly twenty fifty-character options remain valid and are sent without truncation", async ({
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
  await removeOptions(page, "8.25 inch", "8.5 inch");
  const boundaryOptions = Array.from(
    { length: 20 },
    (_, index) => `${"한".repeat(48)}${String(index).padStart(2, "0")}`,
  );
  const exactBoundary = boundaryOptions.join(", ");
  await addOptions(page, ...boundaryOptions);
  await expect(optionChips(page)).toHaveText(boundaryOptions);
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toHaveProperty("sizes", exactBoundary);
  expect(
    String(commands[0]!.sizes)
      .split(",")
      .map((option) => option.trim()),
  ).toHaveLength(20);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product form refinement: editor changes discard pending option selections without mixing A and B draft options", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products", products: true });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const raw = page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false });
  await addOptions(page, "TEST_A_LEGACY");
  await raw.fill("TEST_A_PENDING");
  const chooser = page.getByRole("combobox", { name: "데크 규격 선택", exact: true });
  await chooser.selectOption("8.5");
  const firstUrl = page.url();
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[1]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await expect(optionChips(page)).toHaveText(["TEST"]);
  await expect(raw).toHaveValue("");
  await expect(chooser).not.toHaveValue("8.5");
  await expect(
    page.getByRole("button", { name: "옵션 추가", exact: true }),
  ).toBeDisabled();
  await addOptions(page, "TEST_B_LEGACY");
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(firstUrl);
  await expect(optionChips(page)).toHaveText(["TEST", "TEST_A_LEGACY"]);
  await expect(raw).toHaveValue("");
  await expect(chooser).not.toHaveValue("8.5");
  expect(audit.syntheticWrites).toEqual([]);
});
