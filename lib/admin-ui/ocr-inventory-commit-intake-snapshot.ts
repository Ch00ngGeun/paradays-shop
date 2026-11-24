// 역할: OCR 입고 계획을 실행 전에 검증·고정하고 저장 응답이 계획과 맞는지 확인합니다.
import type { AdminOcrIntakeInput, AdminOcrIntakeResult } from "@/lib/admin-ui/types";
import {
  getOcrIntakeNewProductValidationMessage,
  normalizeOcrIntakeSku,
  normalizeOcrIntakeText,
  ocrIntakeIdentity,
  type OcrIntakeNewProduct,
} from "@/lib/admin-ui/ocr-intake-matching";
import { fail } from "@/lib/admin-ui/ocr-inventory-commit";
import {
  isJobId,
  isProductId,
  isQuantity,
  isRecord,
  isStock,
  isText,
  isVersion,
  MAX_ROWS,
  MAX_STOCK,
} from "@/lib/admin-ui/ocr-inventory-commit-guards";
import type {
  OcrIntakeCommitResult,
  OcrIntakePlan,
  OcrIntakePlanItem,
} from "@/lib/admin-ui/ocr-inventory-commit-intake";
import type { Locale } from "@/types/store";

export function matchesIntakeResponse(
  response: AdminOcrIntakeResult,
  operation: AdminOcrIntakeInput,
  item: OcrIntakePlanItem,
): boolean {
  if (!isRecord(response) || !isRecord(response.product) || !isRecord(response.receipt))
    return false;
  const { product, receipt } = response;
  if (
    !isProductId(product.id) ||
    !isText(product.name, 160) ||
    typeof product.brand !== "string" ||
    typeof product.sizes !== "string" ||
    (product.sku !== undefined && typeof product.sku !== "string") ||
    !isVersion(product.version) ||
    !isStock(product.stock) ||
    typeof receipt.replayed !== "boolean" ||
    receipt.operationId !== operation.operationId ||
    receipt.kind !== item.kind ||
    receipt.quantity !== item.quantity ||
    receipt.beforeStock !== item.beforeStock ||
    receipt.afterStock !== item.nextStock ||
    product.stock !== item.nextStock
  )
    return false;
  if (item.kind === "existing")
    return (
      product.id === item.productId && product.version === item.expectedVersion + 1
    );
  return (
    product.version === 1 &&
    product.isVisible === false &&
    product.isFeatured === false &&
    product.price === item.product.price &&
    product.category === item.product.category &&
    normalizeOcrIntakeText(product.name) ===
      normalizeOcrIntakeText(item.product.name) &&
    normalizeOcrIntakeText(product.brand) ===
      normalizeOcrIntakeText(item.product.brandName) &&
    normalizeOcrIntakeText(product.sizes) ===
      normalizeOcrIntakeText(item.product.option) &&
    normalizeOcrIntakeSku(product.sku ?? "") ===
      normalizeOcrIntakeSku(item.product.sku ?? "")
  );
}

export function snapshotIntakePlan(plan: OcrIntakePlan, locale: Locale): OcrIntakePlan {
  const t = localize(locale);
  if (
    !isRecord(plan) ||
    !isJobId(plan.jobId) ||
    !isVersion(plan.reviewVersion) ||
    !Array.isArray(plan.items) ||
    plan.items.length < 1 ||
    plan.items.length > MAX_ROWS
  )
    fail(t("입고 계획을 다시 생성해 주세요.", "Create the receiving plan again."));
  const itemIds = new Set<string>();
  const rowIds = new Set<string>();
  const productIds = new Set<string>();
  const newKeys = new Set<string>();
  const skus = new Set<string>();
  const items = plan.items.map((item): OcrIntakePlanItem => {
    if (
      !isRecord(item) ||
      !isText(item.itemId, 140) ||
      itemIds.has(item.itemId) ||
      !isText(item.productName, 160) ||
      !isQuantity(item.quantity, "add") ||
      !isStock(item.beforeStock) ||
      !isStock(item.nextStock) ||
      item.nextStock !== item.beforeStock + item.quantity ||
      !Array.isArray(item.rowIds) ||
      item.rowIds.length < 1
    )
      fail(
        t(
          "입고 계획의 상품·수량을 다시 확인해 주세요.",
          "Check the products and quantities in the receiving plan again.",
        ),
      );
    if (item.rowIds.length > 96)
      fail(
        t(
          "동일 상품에 연결한 입고 행은 한 번에 최대 96개입니다. 검토 행과 수량을 합친 뒤 다시 저장해 주세요.",
          "Up to 96 receiving rows can link to one product at a time. Merge the review rows and quantities, then save again.",
        ),
      );
    itemIds.add(item.itemId);
    for (const rowId of item.rowIds) {
      if (!isText(rowId, 128) || rowIds.has(rowId) || rowIds.size >= MAX_ROWS)
        fail(
          t(
            "입고 계획에 중복된 검토 행이 있습니다.",
            "The receiving plan has duplicate review rows.",
          ),
        );
      rowIds.add(rowId);
    }
    const common = {
      itemId: item.itemId,
      productName: item.productName,
      quantity: item.quantity,
      beforeStock: item.beforeStock,
      nextStock: item.nextStock,
      rowIds: Object.freeze([...item.rowIds]),
    };
    if (item.kind === "existing") {
      if (
        !isProductId(item.productId) ||
        productIds.has(item.productId) ||
        !isVersion(item.expectedVersion) ||
        item.expectedVersion >= MAX_STOCK ||
        (item.sku !== undefined && !isText(item.sku, 80))
      )
        fail(
          t(
            "입고 계획의 상품 ID·버전을 확인해 주세요.",
            "Check the product IDs and versions in the receiving plan.",
          ),
        );
      productIds.add(item.productId);
      return Object.freeze({
        ...common,
        kind: "existing",
        productId: item.productId,
        expectedVersion: item.expectedVersion,
        ...(item.sku ? { sku: item.sku } : {}),
      });
    }
    if (item.kind !== "new")
      fail(
        t("신규 상품 입력을 다시 확인해 주세요.", "Check the new product input again."),
      );
    const product = readIntakeNewProduct(item.product, locale);
    if (
      item.beforeStock !== 0 ||
      item.productName.normalize("NFC").trim() !== product.name ||
      item.rowIds.length !== 1
    )
      fail(
        t("신규 상품 입력을 다시 확인해 주세요.", "Check the new product input again."),
      );
    const key = ocrIntakeIdentity(product);
    const sku = normalizeOcrIntakeSku(product.sku ?? "");
    if (newKeys.has(key) || (sku && skus.has(sku)))
      fail(
        t(
          "중복 신규 상품을 하나의 검토 행으로 합쳐 주세요.",
          "Merge duplicate new products into one review row.",
        ),
      );
    newKeys.add(key);
    if (sku) skus.add(sku);
    return Object.freeze({
      ...common,
      productName: product.name,
      kind: "new",
      product: Object.freeze({
        ...product,
      }),
    });
  });
  return Object.freeze({
    jobId: plan.jobId,
    reviewVersion: plan.reviewVersion,
    items: Object.freeze(items),
  });
}
export function localize(locale: Locale) {
  return (ko: string, en: string) => (locale === "ko" ? ko : en);
}

export function freezeIntakeResult(
  status: OcrIntakeCommitResult["status"],
  items: OcrIntakeCommitResult["items"],
): OcrIntakeCommitResult {
  return Object.freeze({
    status,
    items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
  });
}

export function readIntakeNewProduct(
  value: unknown,
  locale: Locale,
): OcrIntakeNewProduct {
  const t = localize(locale);
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.brandName !== "string" ||
    typeof value.option !== "string" ||
    typeof value.price !== "number" ||
    typeof value.category !== "string" ||
    (value.sku !== undefined && typeof value.sku !== "string")
  )
    fail(
      t("신규 상품 입력을 다시 확인해 주세요.", "Check the new product input again."),
    );
  const product: OcrIntakeNewProduct = {
    name: value.name.normalize("NFC").trim(),
    brandName: value.brandName.normalize("NFC").trim(),
    option: value.option.normalize("NFC").trim(),
    price: value.price,
    category: value.category,
    ...(value.sku !== undefined ? { sku: normalizeOcrIntakeSku(value.sku) } : {}),
  };
  const message = getOcrIntakeNewProductValidationMessage(product, locale);
  if (message) fail(message);
  return product;
}
