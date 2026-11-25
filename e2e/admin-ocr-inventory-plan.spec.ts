/** Real admin UI/client with test-only session and intercepted provider API. */
import { expect, test } from "@playwright/test";
import {
  OCR_ROUTE,
  recognize,
  adminOcrBeforeEach,
  adminOcrAfterEach,
} from "./admin-ocr-fixtures";
import {
  inventoryCatalogProduct,
  inventoryReviewRow,
  setupInventoryCatalogApi,
  expectedExistingIntake,
  setupInventoryReviewApi,
  inventoryApplicationPanel,
  saveInventoryReview,
  prepareInventoryApplication,
  confirmInventoryApplication,
  chooseNewInventoryProduct,
  confirmInventoryRow,
  previewInventoryApplication,
  openInventorySection,
  expectInventoryStock,
} from "./admin-ocr-inventory-fixtures";

test.beforeEach(adminOcrBeforeEach);
test.afterEach(adminOcrAfterEach);

test.describe("OCR inventory application", () => {
  test("OCR help opens on demand while the stock and privacy warnings stay visible", async ({
    page,
  }) => {
    await setupInventoryCatalogApi(page, []);
    const rows = [{ ...inventoryReviewRow(), productName: "New synthetic deck" }];
    await setupInventoryReviewApi(page, OCR_ROUTE, rows);
    await saveInventoryReview(page);
    const dialog = page.getByRole("dialog");
    const check = async (target: string, text: string) => {
      const help = page.getByRole("button", { name: `${target} 도움말`, exact: true });
      await expect(page.getByText(text, { exact: true })).toHaveCount(0);
      await help.click();
      await expect(dialog).toContainText(text);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(help).toBeFocused();
    };
    // Stock and safety notices stay on screen.
    await expect(
      page.getByText("빈 수량 제외 · 실제 재고와 무관", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("검토본을 저장해도 재고는 변경되지", { exact: false }),
    ).toBeVisible();
    await check("원본 이미지", "PNG·JPG·WEBP · 4MiB 이하 · 표 전체가 보이는 이미지");

    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await panel
      .getByRole("combobox", { name: "입고 방식 1", exact: true })
      .selectOption("new");
    await check("신규 옵션 1", "옵션이 없으면 빈칸. 옵션별 재고는 생성하지 않습니다.");
    await check("신규 가격 1", "필수 · 원 단위 정수, 0~100,000,000원");
    // The price range comes back as the validation message when the price is wrong.
    await panel.getByLabel("신규 가격 1", { exact: true }).fill("100000001");
    await expect(panel).toContainText("0~100,000,000원 정수여야 합니다");
  });

  test("a new product requires price and category and is created as a private draft with intake stock", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page, []);
    const rows = [{ ...inventoryReviewRow(), productName: "New synthetic deck" }];
    const methods = await setupInventoryReviewApi(page, OCR_ROUTE, rows);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await expect(panel).toContainText("일치 후보 없음 · 신규 입력 가능");
    await panel
      .getByRole("combobox", { name: "입고 방식 1", exact: true })
      .selectOption("new");
    await expect(panel.getByLabel("신규 가격 1", { exact: true })).toHaveValue("");
    await expect(
      panel.getByRole("combobox", { name: "신규 카테고리 1", exact: true }),
    ).toHaveValue("");
    const rowConfirmation = panel.getByRole("checkbox", {
      name: "입고 행 1 내용을 확인했습니다",
      exact: true,
    });
    await expect(rowConfirmation).toBeDisabled();
    await panel.getByLabel("신규 가격 1", { exact: true }).fill("89000");
    await expect(rowConfirmation).toBeDisabled();
    await panel
      .getByRole("combobox", { name: "신규 카테고리 1", exact: true })
      .selectOption("Deck");
    await confirmInventoryRow(page, 1);
    await previewInventoryApplication(page);
    await expect(panel).toContainText("신규 · 비공개 초안");
    await expect(panel).toContainText("89,000");
    expect(inventory.intakes).toHaveLength(0);
    // Editing even a valid price invalidates both row confirmation and the preview.
    await panel.getByLabel("신규 가격 1", { exact: true }).fill("90000");
    await expect(rowConfirmation).not.toBeChecked();
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toHaveCount(0);
    await confirmInventoryRow(page, 1);
    await previewInventoryApplication(page);
    await confirmInventoryApplication(page);
    await expect(panel.getByRole("status")).toContainText("입고 반영이 완료");
    expect(inventory.intakes).toEqual([
      {
        action: "ocr-intake",
        operationId: expect.any(String),
        kind: "new",
        quantity: 4,
        source: { jobId: "ocr_inventory", rowIds: ["inventory-row-1"] },
        product: {
          name: "New synthetic deck",
          brandName: "Test Maker",
          option: "8.25",
          price: 90000,
          category: "Deck",
        },
      },
    ]);
    expect(inventory.products[0]).toMatchObject({
      status: "DRAFT",
      version: 1,
      inventoryQuantity: 4,
      price: 90000,
      category: "Deck",
      sizes: ["8.25"],
    });
    expect(methods).toEqual(["POST", "PATCH"]);
    await expect(
      page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }).first(),
    ).toHaveValue(rows[0].sourceText);
    expect(JSON.stringify(inventory.intakes)).not.toMatch(
      /rawText|sourceText|confidence|"box"/u,
    );
  });

  test("ambiguous normalized composite candidates are never auto-selected or newly duplicated", async ({
    page,
  }) => {
    const first = inventoryCatalogProduct(1);
    const second = { ...inventoryCatalogProduct(2), name: first.name };
    const inventory = await setupInventoryCatalogApi(page, [first, second]);
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      {
        ...inventoryReviewRow(),
        productName: "  INVENTORY   deck 1  ",
        brand: " test MAKER ",
        option: " 8.25 ",
      },
    ]);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await expect(panel).toContainText("이름·브랜드·옵션 일치 후보 2개");
    await expect(
      panel.getByRole("combobox", { name: "재고 상품 선택 1", exact: true }),
    ).toHaveValue("");
    await expect(
      panel.getByRole("checkbox", {
        name: "입고 행 1 내용을 확인했습니다",
        exact: true,
      }),
    ).toBeDisabled();
    await chooseNewInventoryProduct(page);
    await expect(panel).toContainText(
      "기존 상품 또는 중복 후보가 있어 신규 등록할 수 없습니다",
    );
    await expect(
      panel.getByRole("checkbox", {
        name: "입고 행 1 내용을 확인했습니다",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(0);
    await panel
      .getByRole("combobox", { name: "입고 방식 1", exact: true })
      .selectOption("existing");
    await panel
      .getByRole("combobox", { name: "재고 상품 선택 1", exact: true })
      .selectOption(second.productId);
    await confirmInventoryRow(page, 1);
    await previewInventoryApplication(page);
    await confirmInventoryApplication(page);
    await expect.poll(() => inventory.intakes.length).toBe(1);
    expect(inventory.intakes[0]).toEqual(
      expectedExistingIntake(second.productId, 4, 4),
    );
    expect(first.inventoryQuantity).toBe(5);
    expect(second.inventoryQuantity).toBe(24);
  });

  test("exact ID and SKU only suggest candidates and similar names never become automatic matches", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      { ...inventoryReviewRow(), productName: "Inventory deck 1!" },
    ]);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await expect(panel).toContainText("일치 후보 없음 · 신규 입력 가능");
    await panel.getByLabel("정확한 SKU 1", { exact: true }).fill("TEST-INVENTORY-1");
    await expect(panel).toContainText("정확한 SKU 후보 1개");
    await expect(
      panel.getByRole("combobox", { name: "재고 상품 선택 1", exact: true }),
    ).toHaveValue("");
    await panel
      .getByLabel("정확한 상품 ID 1", { exact: true })
      .fill("inventory-product-missing");
    await expect(panel).toContainText("해당 상품 ID를 찾지 못했습니다");
    await chooseNewInventoryProduct(page);
    await expect(
      panel.getByRole("checkbox", {
        name: "입고 행 1 내용을 확인했습니다",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(0);
  });

  test("invalid price and unsupported category cannot confirm or write a new product", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page, []);
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      { ...inventoryReviewRow(), productName: "Invalid price fixture" },
    ]);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await chooseNewInventoryProduct(page);
    const confirmation = panel.getByRole("checkbox", {
      name: "입고 행 1 내용을 확인했습니다",
      exact: true,
    });
    for (const price of ["", "-1", "1.5", "NaN", "100000001"]) {
      await panel.getByLabel("신규 가격 1", { exact: true }).fill(price);
      await expect(confirmation).toBeDisabled();
      expect(inventory.intakes).toHaveLength(0);
    }
    await panel.getByLabel("신규 가격 1", { exact: true }).fill("0");
    await expect(confirmation).toBeEnabled();
    const category = panel.getByRole("combobox", {
      name: "신규 카테고리 1",
      exact: true,
    });
    await expect(category.locator('option[value="Unapproved"]')).toHaveCount(0);
    await category.selectOption("");
    await expect(confirmation).toBeDisabled();
    expect(inventory.intakes).toHaveLength(0);
  });

  for (const quantity of ["", "0", "1000001"]) {
    test(`saved review quantity ${JSON.stringify(quantity)} cannot produce an intake write`, async ({
      page,
    }) => {
      const inventory = await setupInventoryCatalogApi(page);
      await setupInventoryReviewApi(page, OCR_ROUTE, [inventoryReviewRow(1, quantity)]);
      await saveInventoryReview(page);
      const panel = inventoryApplicationPanel(page);
      await panel
        .getByRole("button", { name: "재고 상품 불러오기", exact: true })
        .click();
      await panel
        .getByRole("combobox", { name: "재고 상품 선택 1", exact: true })
        .selectOption("inventory-product-1");
      await previewInventoryApplication(page);
      await expect(panel.getByRole("alert")).toContainText(
        "입고 수량은 1~1,000,000 정수",
      );
      await expect(
        panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
      ).toHaveCount(0);
      expect(inventory.intakes).toHaveLength(0);
    });
  }

  test("concurrent duplicate creation stops a mixed plan after its first success without retrying", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(
      page,
      [inventoryCatalogProduct(1), inventoryCatalogProduct(3)],
      { id: "inventory-new-product", kind: "duplicate" },
    );
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      inventoryReviewRow(1, "4"),
      { ...inventoryReviewRow(2, "2"), productName: "New concurrent fixture" },
      inventoryReviewRow(3, "1"),
    ]);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await panel
      .getByRole("combobox", { name: "재고 상품 선택 1", exact: true })
      .selectOption("inventory-product-1");
    await confirmInventoryRow(page, 1);
    await chooseNewInventoryProduct(page, 2);
    await confirmInventoryRow(page, 2);
    await panel
      .getByRole("combobox", { name: "재고 상품 선택 3", exact: true })
      .selectOption("inventory-product-3");
    await confirmInventoryRow(page, 3);
    await previewInventoryApplication(page);
    await confirmInventoryApplication(page);
    await expect(panel.getByRole("alert")).toContainText("입고 반영이 중단");
    await expect(panel).toContainText("다른 관리자가 등록했거나 기존 상품·버전과 충돌");
    await expect(panel).toContainText("반영 완료");
    await expect(panel).toContainText("미반영");
    expect(inventory.intakes).toHaveLength(2);
    expect(inventory.intakes[0]).toEqual(
      expectedExistingIntake("inventory-product-1", 3, 4),
    );
    expect(inventory.intakes[1]).toMatchObject({ kind: "new", quantity: 2 });
    expect(
      inventory.products.find((product) => product.productId === "inventory-product-1")
        ?.inventoryQuantity,
    ).toBe(9);
    expect(
      inventory.products.find((product) => product.productId === "inventory-product-3")
        ?.inventoryQuantity,
    ).toBe(30);
    await openInventorySection(page, "재고 수정");
    await openInventorySection(page, "입고 OCR");
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(2);
  });

  test("saving the review draft does not change catalog inventory", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    await recognize(page, "Draft only.png");
    await expect(inventoryApplicationPanel(page)).toHaveCount(0);
    await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
    await expect(inventoryApplicationPanel(page)).toBeVisible();
    expect(inventory.intakes).toHaveLength(0);
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test("manual add applies a fresh versioned stock plan and locks that job after navigation or edits", async ({
    page,
  }, testInfo) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await expect(
      panel.getByRole("combobox", { name: "재고 반영 방식", exact: true }),
    ).toHaveCount(0);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    const colors = await panel.evaluate((element) => {
      const select = element.querySelector("select");
      const button = [...element.querySelectorAll("button")].find((item) =>
        item.textContent?.includes("재고 상품 불러오기"),
      );
      return {
        background: getComputedStyle(element).backgroundColor,
        text: getComputedStyle(element).color,
        selectBackground: select ? getComputedStyle(select).backgroundColor : null,
        selectText: select ? getComputedStyle(select).color : null,
        buttonText: button ? getComputedStyle(button).color : null,
      };
    });
    expect(colors.background).not.toBe(colors.text);
    expect(colors.selectBackground).not.toBe(colors.selectText);
    expect(colors.background).not.toBe(colors.buttonText);
    await panel.screenshot({ path: testInfo.outputPath("ocr-inventory-preview.png") });
    expect(inventory.gets).toBeGreaterThanOrEqual(2);
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    await confirmInventoryApplication(page);
    await expect.poll(() => inventory.intakes.length).toBe(1);
    expect(inventory.intakes[0]).toEqual(
      expectedExistingIntake("inventory-product-1", 3, 4),
    );
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 9);
    await openInventorySection(page, "입고 OCR");
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("textbox", { name: "상품명", exact: true })
      .fill("Edited after stock apply");
    await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(1);
  });
});
