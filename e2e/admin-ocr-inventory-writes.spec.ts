// 역할: OCR 입고 쓰기의 명시적 선택·버전 충돌·같은 상품 합산·부분 성공·응답 유실·늦은 응답 처리를 실제 관리자 화면과 가로챈 API로 검증함.
import { expect, test } from "@playwright/test";
import type { AdminOcrIntakeInput } from "../lib/admin-ui/types";
import {
  API,
  OCR_ROUTE,
  JWT,
  json,
  heldResponse,
  flushResponse,
  adminOcrBeforeEach,
  adminOcrAfterEach,
} from "./admin-ocr-fixtures";
import {
  type InventoryCatalogFixture,
  inventoryCatalogProduct,
  inventoryReviewRow,
  setupInventoryCatalogApi,
  intakeResponse,
  expectedExistingIntake,
  isIntakeRequest,
  setupInventoryReviewApi,
  inventoryApplicationPanel,
  saveInventoryReview,
  prepareInventoryApplication,
  confirmInventoryApplication,
  openInventorySection,
  expectInventoryStock,
} from "./admin-ocr-inventory-fixtures";

test.beforeEach(adminOcrBeforeEach);
test.afterEach(adminOcrAfterEach);

test.describe("OCR inventory application", () => {
  test("an exact candidate still requires explicit selection and cannot produce an intake POST", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await expect(
      panel.getByRole("combobox", { name: "재고 상품 선택 1", exact: true }),
    ).toHaveValue("");
    const preview = panel.getByRole("button", {
      name: "재고 반영 미리보기",
      exact: true,
    });
    if (await preview.isEnabled()) await preview.click();
    await expect(panel.getByRole("alert")).toContainText("개별 확인");
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toHaveCount(0);
    expect(inventory.intakes).toHaveLength(0);
  });

  test("version conflict stops inventory writes and does not offer an automatic retry", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(
      page,
      [inventoryCatalogProduct()],
      {
        id: "inventory-product-1",
        kind: "conflict",
      },
    );
    await setupInventoryReviewApi(page);
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    const response = page.waitForResponse((value) => isIntakeRequest(value.request()));
    await confirmInventoryApplication(page);
    await flushResponse(page, response);
    await expect(inventoryApplicationPanel(page).getByRole("alert")).toContainText(
      "재고",
    );
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toEqual([
      expectedExistingIntake("inventory-product-1", 3, 4),
    ]);
    await openInventorySection(page, "재고 수정");
    // 공통 beforeEach는 이 테스트 fixture를 설치하기 전에 빈 카탈로그를 먼저 돌려줌.
    // 충돌에는 병합할 성공 상품이 없으므로 운영자 검토를 위해 현재 재고를
    // 명시적으로 다시 불러옴.
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expectInventoryStock(page, 5);
    await openInventorySection(page, "입고 OCR");
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(1);
  });

  test("two rows for the same product sum their increments without replacing existing stock", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      inventoryReviewRow(1, "4"),
      { ...inventoryReviewRow(2, "2"), productName: "Inventory deck 1" },
    ]);
    await saveInventoryReview(page);
    await expect(
      inventoryApplicationPanel(page).getByRole("combobox", {
        name: "재고 반영 방식",
        exact: true,
      }),
    ).toHaveCount(0);
    await prepareInventoryApplication(page, [
      "inventory-product-1",
      "inventory-product-1",
    ]);
    await confirmInventoryApplication(page);
    await expect.poll(() => inventory.intakes.length).toBe(1);
    expect(inventory.intakes[0]).toEqual(
      expectedExistingIntake("inventory-product-1", 3, 6, [
        "inventory-row-1",
        "inventory-row-2",
      ]),
    );
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 11);
  });

  test("an in-flight stock response still updates inventory after review editing hides its panel", async ({
    page,
  }) => {
    await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const pending = heldResponse();
    const intakes: AdminOcrIntakeInput[] = [];
    await page.route(`${API}admin/catalog/products`, async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      if (route.request().method() !== "POST") return route.fallback();
      intakes.push(route.request().postDataJSON());
      return pending.handle(route);
    });
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    await confirmInventoryApplication(page);
    await pending.started;
    await page
      .getByRole("textbox", { name: "상품명", exact: true })
      .fill("Edited while inventory is pending");
    await expect(inventoryApplicationPanel(page)).toHaveCount(0);
    const response = page.waitForResponse((value) => isIntakeRequest(value.request()));
    pending.respond(
      intakeResponse(
        intakes[0],
        { ...inventoryCatalogProduct(), inventoryQuantity: 9, version: 4 },
        5,
      ),
    );
    await flushResponse(page, response);
    await expect(
      page.getByRole("textbox", { name: "상품명", exact: true }),
    ).toHaveValue("Edited while inventory is pending");
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 9);
    await openInventorySection(page, "입고 OCR");
    await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
    await expect(inventoryApplicationPanel(page)).toBeVisible();
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(intakes).toEqual([expectedExistingIntake("inventory-product-1", 3, 4)]);
  });

  test("partial success followed by a lost response stops before the third product", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(
      page,
      [
        inventoryCatalogProduct(1),
        inventoryCatalogProduct(2),
        inventoryCatalogProduct(3),
      ],
      { id: "inventory-product-2", kind: "response-lost" },
    );
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      inventoryReviewRow(1, "4"),
      inventoryReviewRow(2, "2"),
      inventoryReviewRow(3, "1"),
    ]);
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, [
      "inventory-product-1",
      "inventory-product-2",
      "inventory-product-3",
    ]);
    const failed = page.waitForEvent(
      "requestfailed",
      (request) =>
        isIntakeRequest(request) &&
        request.postDataJSON().existing?.productId === "inventory-product-2",
    );
    await confirmInventoryApplication(page);
    await failed;
    await expect(inventoryApplicationPanel(page).getByRole("alert")).toContainText(
      "재고",
    );
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toEqual([
      expectedExistingIntake("inventory-product-1", 3, 4),
      expectedExistingIntake("inventory-product-2", 4, 2, ["inventory-row-2"]),
    ]);
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 9);
    await openInventorySection(page, "입고 OCR");
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(2);
  });

  test("pending inventory finishes visibly after the OCR panel is unmounted and reopened", async ({
    page,
  }) => {
    await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const pending = heldResponse();
    const intakes: AdminOcrIntakeInput[] = [];
    await page.route(`${API}admin/catalog/products`, async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      if (route.request().method() !== "POST") return route.fallback();
      intakes.push(route.request().postDataJSON());
      return pending.handle(route);
    });
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    await inventoryApplicationPanel(page)
      .getByRole("checkbox", {
        name: "실제 상품 등록·재고 변경 내용을 확인했습니다",
        exact: true,
      })
      .check();
    await inventoryApplicationPanel(page)
      .getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      })
      .dblclick();
    await pending.started;
    expect(intakes).toHaveLength(1);
    await openInventorySection(page, "재고 수정");
    await openInventorySection(page, "입고 OCR");
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "입고 반영 중…",
        exact: true,
      }),
    ).toBeDisabled();
    const response = page.waitForResponse((value) => isIntakeRequest(value.request()));
    pending.respond(
      intakeResponse(
        intakes[0],
        { ...inventoryCatalogProduct(), inventoryQuantity: 9, version: 4 },
        5,
      ),
    );
    await flushResponse(page, response);
    await expect(inventoryApplicationPanel(page).getByRole("status")).toContainText(
      "입고 반영이 완료",
    );
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(intakes).toEqual([expectedExistingIntake("inventory-product-1", 3, 4)]);
  });

  test("an older catalog reload cannot replace a later canonical inventory write", async ({
    page,
  }) => {
    await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const stock = heldResponse();
    const catalog = heldResponse();
    const intakes: AdminOcrIntakeInput[] = [];
    await page.route(`${API}admin/catalog/products`, async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      if (route.request().method() !== "POST") return route.fallback();
      intakes.push(route.request().postDataJSON());
      return stock.handle(route);
    });
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    await confirmInventoryApplication(page);
    await stock.started;
    // 이 GET은 성공한 입고 POST 결과를 받기 전에 시작되지만, 붙잡아 둔
    // 카탈로그 스냅숏은 의도적으로 재고 쓰기 뒤에 전달됨.
    const catalogUrl = new URL(`${API}admin/catalog/products`);
    await page.route(
      (url) => url.origin === catalogUrl.origin && url.pathname === catalogUrl.pathname,
      async (route) => {
        if (route.request().method() === "OPTIONS") return json(route, {});
        if (route.request().method() !== "GET") return route.fallback();
        return catalog.handle(route);
      },
    );
    await openInventorySection(page, "재고 수정");
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await catalog.started;
    const stockResponse = page.waitForResponse((value) =>
      isIntakeRequest(value.request()),
    );
    stock.respond(
      intakeResponse(
        intakes[0],
        { ...inventoryCatalogProduct(), inventoryQuantity: 9, version: 4 },
        5,
      ),
    );
    await flushResponse(page, stockResponse);
    await expectInventoryStock(page, 9);
    const catalogResponse = page.waitForResponse(
      (value) =>
        value.request().method() === "GET" &&
        new URL(value.url()).origin === catalogUrl.origin &&
        new URL(value.url()).pathname === catalogUrl.pathname,
    );
    catalog.respond({ products: [inventoryCatalogProduct()] });
    await flushResponse(page, catalogResponse);
    await expectInventoryStock(page, 9);
    await openInventorySection(page, "입고 OCR");
    await expect(inventoryApplicationPanel(page).getByRole("status")).toContainText(
      "입고 반영이 완료",
    );
    expect(intakes).toEqual([expectedExistingIntake("inventory-product-1", 3, 4)]);
  });

  test("a delayed manual stock response cannot overwrite a newer OCR inventory version", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const manual = heldResponse();
    const patches: Record<string, unknown>[] = [];
    let manualSnapshot: InventoryCatalogFixture | undefined;
    await page.route(
      `${API}admin/catalog/products/inventory-product-1`,
      async (route) => {
        const request = route.request();
        if (request.method() === "OPTIONS") return json(route, {});
        expect(request.method()).toBe("PATCH");
        expect(request.headers().authorization).toBe(`Bearer ${JWT}`);
        const body = request.postDataJSON() as { version: number; stock: number };
        const product = inventory.products[0];
        expect(body.version).toBe(product.version);
        patches.push(body);
        product.inventoryQuantity = body.stock;
        product.version += 1;
        if (patches.length === 1) {
          manualSnapshot = { ...product };
          return manual.handle(route);
        }
        return json(route, { product });
      },
    );
    await openInventorySection(page, "재고 수정");
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expectInventoryStock(page, 5);
    await page
      .getByRole("button", { name: "Inventory deck 1 재고 조정", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true }),
    ).toHaveValue("5");
    await page.getByRole("button", { name: "재고 1개 증가", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true }),
    ).toHaveValue("6");
    await page
      .getByRole("textbox", { name: "변경 후 재고 수량", exact: true })
      .press("Enter");
    await page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true }).blur();
    expect(patches).toHaveLength(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "재고 변경 내용 확인", exact: true })
      .click();
    await manual.started;
    await openInventorySection(page, "입고 OCR");
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    await confirmInventoryApplication(page);
    await expect(inventoryApplicationPanel(page).getByRole("status")).toContainText(
      "입고 반영이 완료",
    );
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 10);
    const response = page.waitForResponse(
      (value) =>
        value.request().method() === "PATCH" &&
        value.url().endsWith("/inventory-product-1"),
    );
    manual.respond({ product: manualSnapshot });
    await flushResponse(page, response);
    await expectInventoryStock(page, 10);
    expect(patches).toEqual([{ version: 3, stock: 6 }]);
    expect(inventory.intakes).toEqual([
      expectedExistingIntake("inventory-product-1", 4, 4),
    ]);
  });
});
