/** admin-ocr 입고 반영 spec 공통 fixture: synthetic catalog·intake API 도우미. */
import { expect, type Page } from "@playwright/test";
import type { AdminOcrIntakeInput } from "../lib/admin-ui/types";
import {
  API,
  OCR_ROUTE,
  JWT,
  job,
  json,
  selectAdminTab,
  recognize,
} from "./admin-ocr-fixtures";

export type InventoryCatalogFixture = {
  productId: string;
  name: string;
  brandName: string;
  category: string;
  price: number;
  inventoryQuantity: number;
  status: "PUBLISHED" | "DRAFT";
  featured: boolean;
  version: number;
  description: string[];
  sizes: string[];
  sku?: string;
};

export function inventoryCatalogProduct(index = 1): InventoryCatalogFixture {
  return {
    productId: `inventory-product-${index}`,
    name: `Inventory deck ${index}`,
    brandName: "Test Maker",
    category: "Deck",
    price: 100000,
    inventoryQuantity: index === 1 ? 5 : index * 10,
    status: "PUBLISHED",
    featured: false,
    version: index + 2,
    description: ["Synthetic inventory fixture"],
    sizes: ["8.25"],
    sku: `TEST-INVENTORY-${index}`,
  };
}

export function inventoryReviewRow(index = 1, quantity = "4") {
  return {
    ...job().rows[0],
    id: `inventory-row-${index}`,
    sourceText: `Synthetic intake line ${index}`,
    productName: `Inventory deck ${index}`,
    brand: "Test Maker",
    option: "8.25",
    quantity,
  };
}

export async function setupInventoryCatalogApi(
  page: Page,
  products = [inventoryCatalogProduct()],
  failure?: { id: string; kind: "conflict" | "response-lost" | "duplicate" },
) {
  const state = {
    products,
    gets: 0,
    intakes: [] as Array<AdminOcrIntakeInput & { action: "ocr-intake" }>,
    intakeUrls: [] as string[],
  };
  await page.route(`${API}admin/catalog/products**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return json(route, {});
    expect(request.headers().authorization).toBe(`Bearer ${JWT}`);
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/products")) {
      state.gets += 1;
      return json(route, { products: state.products });
    }
    if (request.method() !== "POST" || !url.pathname.endsWith("/products"))
      throw new Error(
        `Unexpected catalog mutation: ${request.method()} ${url.pathname}`,
      );
    const body = request.postDataJSON() as AdminOcrIntakeInput & {
      action: "ocr-intake";
    };
    expect(body.action).toBe("ocr-intake");
    expect(body.operationId).toMatch(/^[A-Za-z0-9._-]+$/u);
    expect(Number.isSafeInteger(body.quantity)).toBe(true);
    expect(body.quantity).toBeGreaterThan(0);
    expect(body.source.jobId).toBe("ocr_inventory");
    expect(body.source.rowIds.length).toBeGreaterThan(0);
    expect(new Set(body.source.rowIds).size).toBe(body.source.rowIds.length);
    for (const rowId of body.source.rowIds)
      expect(rowId).toMatch(/^inventory-row-[1-3]$/u);
    state.intakes.push(body);
    state.intakeUrls.push(request.url());
    const id =
      body.kind === "existing" ? body.existing.productId : "inventory-new-product";
    if (failure?.id === id && failure.kind === "conflict")
      return json(route, { code: "PRODUCT_VERSION_CONFLICT" }, 409);
    if (failure?.id === id && failure.kind === "duplicate")
      return json(route, { code: "OCR_INTAKE_DUPLICATE_PRODUCT" }, 409);
    let product: InventoryCatalogFixture;
    let beforeStock = 0;
    if (body.kind === "existing") {
      const existing = state.products.find((item) => item.productId === id);
      if (!existing) return json(route, {}, 404);
      expect(body.existing.version).toBe(existing.version);
      beforeStock = existing.inventoryQuantity;
      existing.inventoryQuantity += body.quantity;
      existing.version += 1;
      product = existing;
    } else {
      product = {
        ...inventoryCatalogProduct(),
        productId: id,
        ...body.product,
        inventoryQuantity: body.quantity,
        status: "DRAFT",
        version: 1,
        sizes: body.product.option ? [body.product.option] : [],
        sku: body.product.sku,
      };
      state.products.push(product);
    }
    // Model a committed write whose response was lost. It must not be retried
    // with a rebased stock increment or followed by the next product's POST.
    if (failure?.id === id && failure.kind === "response-lost")
      return route.abort("connectionfailed");
    return json(route, intakeResponse(body, product, beforeStock));
  });
  return state;
}

export function intakeResponse(
  input: AdminOcrIntakeInput,
  product: InventoryCatalogFixture,
  beforeStock: number,
) {
  return {
    product,
    receipt: {
      operationId: input.operationId,
      kind: input.kind,
      quantity: input.quantity,
      beforeStock,
      afterStock: product.inventoryQuantity,
      replayed: false,
    },
  };
}

export function expectedExistingIntake(
  productId: string,
  version: number,
  quantity: number,
  rowIds = ["inventory-row-1"],
) {
  return {
    action: "ocr-intake",
    operationId: expect.any(String),
    kind: "existing",
    quantity,
    source: { jobId: "ocr_inventory", rowIds },
    existing: { productId, version },
  };
}

export function isIntakeRequest(request: import("@playwright/test").Request) {
  return (
    request.method() === "POST" && request.url() === `${API}admin/catalog/products`
  );
}

export async function setupInventoryReviewApi(
  page: Page,
  routePattern = OCR_ROUTE,
  rows = [inventoryReviewRow()],
) {
  const methods: string[] = [];
  let current = { ...job("ocr_inventory", "Synthetic inventory intake"), rows };
  await page.route(routePattern, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return json(route, {});
    expect(request.headers().authorization).toBe(`Bearer ${JWT}`);
    methods.push(request.method());
    if (request.method() === "POST") return json(route, { job: current }, 201);
    if (request.method() === "GET") return json(route, { job: current });
    const body = request.postDataJSON();
    expect(body.version).toBe(current.version);
    current = {
      ...current,
      version: current.version + 1,
      rawText: body.rawText ?? current.rawText,
      rows: body.rows.map((row: ReturnType<typeof inventoryReviewRow>) => ({
        ...row,
        confidence:
          current.rows.find((item) => item.id === row.id)?.confidence ??
          job().rows[0].confidence,
        box: current.rows.find((item) => item.id === row.id)?.box ?? job().rows[0].box,
      })),
    };
    return json(route, { job: current });
  });
  return methods;
}

export function inventoryApplicationPanel(page: Page) {
  return page.getByRole("region", { name: "재고 반영", exact: true });
}

export async function saveInventoryReview(page: Page) {
  await recognize(page, "Synthetic inventory.png");
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "재고 반영", exact: true }),
  ).toBeVisible();
}

export async function prepareInventoryApplication(page: Page, productIds: string[]) {
  const panel = inventoryApplicationPanel(page);
  await panel.getByRole("button", { name: "재고 상품 불러오기", exact: true }).click();
  for (const [index, id] of productIds.entries()) {
    await panel
      .getByRole("combobox", { name: `재고 상품 선택 ${index + 1}`, exact: true })
      .selectOption(id);
    await panel
      .getByRole("checkbox", {
        name: `입고 행 ${index + 1} 내용을 확인했습니다`,
        exact: true,
      })
      .check();
  }
  await panel.getByRole("button", { name: "재고 반영 미리보기", exact: true }).click();
  await expect(
    panel.getByRole("checkbox", {
      name: "실제 상품 등록·재고 변경 내용을 확인했습니다",
      exact: true,
    }),
  ).toBeEnabled();
}

export async function confirmInventoryApplication(page: Page) {
  const panel = inventoryApplicationPanel(page);
  await panel
    .getByRole("checkbox", {
      name: "실제 상품 등록·재고 변경 내용을 확인했습니다",
      exact: true,
    })
    .check();
  await panel.getByRole("button", { name: "확인한 입고 반영", exact: true }).click();
}

export async function chooseNewInventoryProduct(
  page: Page,
  row = 1,
  price = "89000",
  category = "Deck",
) {
  const panel = inventoryApplicationPanel(page);
  await panel
    .getByRole("combobox", { name: `입고 방식 ${row}`, exact: true })
    .selectOption("new");
  await panel.getByLabel(`신규 가격 ${row}`, { exact: true }).fill(price);
  await panel
    .getByRole("combobox", { name: `신규 카테고리 ${row}`, exact: true })
    .selectOption(category);
}

export async function confirmInventoryRow(page: Page, row: number) {
  await inventoryApplicationPanel(page)
    .getByRole("checkbox", {
      name: `입고 행 ${row} 내용을 확인했습니다`,
      exact: true,
    })
    .check();
}

export async function previewInventoryApplication(page: Page) {
  await inventoryApplicationPanel(page)
    .getByRole("button", {
      name: "재고 반영 미리보기",
      exact: true,
    })
    .click();
}

export async function openInventorySection(
  page: Page,
  label: "재고 수정" | "입고 OCR",
) {
  await selectAdminTab(page, label);
}

export async function expectInventoryStock(
  page: Page,
  quantity: number,
  name = "Inventory deck 1",
) {
  await expect(
    page
      .getByRole("button", { name: `${name} 재고 조정`, exact: true })
      .getByText(`${quantity}개`, { exact: true }),
  ).toBeVisible();
}
