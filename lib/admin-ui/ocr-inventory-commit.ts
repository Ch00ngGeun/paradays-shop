// 역할: 저장된 OCR 검토본과 명시적 상품 선택을 고정 재고 계획으로 바꿉니다.
// 기능: 기존 version 조건부 PATCH만 순서대로 호출하며 실패 후 자동 재시도하지 않습니다.
import type {
  AdminCatalogListItem,
  AdminOcrRecognitionResult,
} from "@/lib/admin-ui/types";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import { OCR_INPUT_LIMITS } from "@/lib/admin-ui/ocr-input-validation";
import {
  isJobId,
  isMode,
  isProductId,
  isQuantity,
  isRecord,
  isStock,
  isText,
  isVersion,
  MAX_ROWS,
} from "@/lib/admin-ui/ocr-inventory-commit-guards";

export type OcrInventoryMode = "add" | "replace";
export type OcrInventorySelection = Readonly<Record<string, string>>;
export type OcrInventoryPlanItem = Readonly<{
  productId: string;
  productName: string;
  sku?: string;
  expectedVersion: number;
  beforeStock: number;
  quantity: number;
  nextStock: number;
  rowIds: readonly string[];
}>;
export type OcrInventoryPlan = Readonly<{
  jobId: string;
  reviewVersion: number;
  mode: OcrInventoryMode;
  items: readonly OcrInventoryPlanItem[];
}>;
export type OcrInventoryCommitItemResult = Readonly<{
  productId: string;
  status: "applied" | "unchanged" | "failed" | "uncertain" | "pending";
  message?: string;
}>;
export type OcrInventoryCommitResult = Readonly<{
  status: "complete" | "stopped";
  items: readonly OcrInventoryCommitItemResult[];
}>;

export class OcrInventoryPlanError extends Error {
  readonly code = "OCR_INVENTORY_PLAN_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "OcrInventoryPlanError";
  }
}

/** 상품명·SKU를 추측 매칭하지 않고 저장된 모든 행의 정확한 productId 선택을 요구합니다. */
export function buildOcrInventoryPlan(
  input: Readonly<{
    job: AdminOcrRecognitionResult;
    products: readonly AdminCatalogListItem[];
    selection: OcrInventorySelection;
    mode: OcrInventoryMode;
  }>,
): OcrInventoryPlan {
  if (!isRecord(input) || !isMode(input.mode)) fail("재고 반영 방식을 선택해 주세요.");
  const { job, products, selection, mode } = input;
  if (
    !isRecord(job) ||
    !isJobId(job.jobId) ||
    !isVersion(job.version) ||
    !Array.isArray(job.rows) ||
    job.rows.length < 1 ||
    job.rows.length > MAX_ROWS
  )
    fail("저장된 OCR 검토본을 다시 확인해 주세요.");
  if (!Array.isArray(products) || !isRecord(selection))
    fail("현재 상품 목록과 상품 선택을 다시 확인해 주세요.");

  const byProductId = new Map<
    string,
    Pick<AdminCatalogListItem, "id" | "name" | "sku" | "version" | "stock">
  >();
  for (const product of products) {
    if (
      !isRecord(product) ||
      !isProductId(product.id) ||
      byProductId.has(product.id) ||
      !isVersion(product.version) ||
      !isStock(product.stock) ||
      !isText(product.name, 160) ||
      (product.sku !== undefined && !isText(product.sku, 80))
    )
      fail("상품 목록의 ID·버전·재고가 올바르지 않습니다. 목록을 새로 불러와 주세요.");
    byProductId.set(product.id, {
      id: product.id,
      name: product.name,
      version: product.version,
      stock: product.stock,
      ...(typeof product.sku === "string" ? { sku: product.sku } : {}),
    });
  }

  const rowIds = new Set<string>();
  const grouped = new Map<string, OcrInventoryPlanItem>();
  for (const [index, row] of job.rows.entries()) {
    const rowNumber = index + 1;
    if (
      !isRecord(row) ||
      !isText(row.id, 128) ||
      rowIds.has(row.id) ||
      !isText(row.productName, OCR_INPUT_LIMITS.maxProductNameLength)
    )
      fail(`${rowNumber}번째 검토 행의 ID와 상품명을 확인해 주세요.`);
    rowIds.add(row.id);
    if (
      typeof row.quantity !== "string" ||
      !/^[0-9]+$/.test(row.quantity) ||
      row.quantity.length > 9 ||
      !isQuantity(Number(row.quantity), mode)
    )
      fail(
        `${rowNumber}번째 수량은 ${mode === "add" ? "1" : "0"}~1,000,000 정수로 입력해 주세요.`,
      );
    const productId = Object.hasOwn(selection, row.id) ? selection[row.id] : undefined;
    const product =
      typeof productId === "string" ? byProductId.get(productId) : undefined;
    if (!product) fail(`${rowNumber}번째 행에 반영할 기존 상품을 직접 선택해 주세요.`);
    const previous = grouped.get(product.id);
    const quantity = (previous?.quantity ?? 0) + Number(row.quantity);
    const nextStock = mode === "add" ? product.stock + quantity : quantity;
    if (!isQuantity(quantity, mode) || !isStock(nextStock))
      fail(
        `동일 상품의 수량 합계는 ${mode === "add" ? "1" : "0"}~1,000,000개, 반영 후 재고는 0~1,000,000개여야 합니다.`,
      );
    grouped.set(product.id, {
      productId: product.id,
      productName: product.name.trim(),
      ...(product.sku !== undefined ? { sku: product.sku } : {}),
      expectedVersion: product.version,
      beforeStock: product.stock,
      quantity,
      nextStock,
      rowIds: [...(previous?.rowIds ?? []), row.id],
    });
  }
  if (Object.keys(selection).some((rowId) => !rowIds.has(rowId)))
    fail(
      "검토본과 상품 선택이 달라졌습니다. 현재 검토 행의 상품을 다시 선택해 주세요.",
    );
  return freezePlan({
    jobId: job.jobId,
    reviewVersion: job.version,
    mode,
    items: [...grouped.values()],
  });
}

/**
 * 이미 확인받은 계획을 그대로 사용합니다. 입고량 재계산·재시도·부분 성공 롤백은 하지 않습니다.
 * 네트워크 오류/응답 불일치는 저장 여부를 알 수 없으므로 uncertain으로 중단합니다.
 */
export async function executeOcrInventoryPlan(
  plan: OcrInventoryPlan,
  dependencies: Readonly<{
    updateProductStock: (
      input: Readonly<{ id: string; version: number; stock: number }>,
    ) => Promise<AdminCatalogListItem>;
    onProductUpdated?: (product: AdminCatalogListItem) => void | Promise<void>;
  }>,
): Promise<OcrInventoryCommitResult> {
  const snapshot = validateAndSnapshotPlan(plan);
  if (
    !isRecord(dependencies) ||
    typeof dependencies.updateProductStock !== "function" ||
    (dependencies.onProductUpdated !== undefined &&
      typeof dependencies.onProductUpdated !== "function")
  )
    fail("실제 재고 저장 API가 연결되지 않았습니다.");
  const results: OcrInventoryCommitItemResult[] = snapshot.items.map((item) => ({
    productId: item.productId,
    status: "pending",
  }));
  for (const [index, item] of snapshot.items.entries()) {
    if (item.beforeStock === item.nextStock) {
      results[index] = { productId: item.productId, status: "unchanged" };
      continue;
    }
    let updated: AdminCatalogListItem;
    try {
      updated = await dependencies.updateProductStock({
        id: item.productId,
        version: item.expectedVersion,
        stock: item.nextStock,
      });
    } catch (error) {
      const knownRejection =
        error instanceof AdminApiRequestError &&
        [400, 401, 403, 409].includes(error.status);
      results[index] = {
        productId: item.productId,
        status: knownRejection ? "failed" : "uncertain",
        message: knownRejection
          ? "재고 저장이 거절됐습니다. 권한과 현재 상품 버전을 확인하고 새 계획을 검토해 주세요."
          : "저장 결과를 확인할 수 없습니다. 중복 입고를 막기 위해 자동 재시도하지 않습니다. 실제 재고를 먼저 확인해 주세요.",
      };
      return freezeResult("stopped", results);
    }
    if (
      !isRecord(updated) ||
      updated.id !== item.productId ||
      updated.version !== item.expectedVersion + 1 ||
      updated.stock !== item.nextStock
    ) {
      results[index] = {
        productId: item.productId,
        status: "uncertain",
        message:
          "재고 저장 응답이 확인한 계획과 다릅니다. 실제 재고를 확인한 뒤 다시 검토해 주세요.",
      };
      return freezeResult("stopped", results);
    }
    results[index] = { productId: item.productId, status: "applied" };
    try {
      await dependencies.onProductUpdated?.(updated);
    } catch {
      results[index] = {
        productId: item.productId,
        status: "applied",
        message:
          "재고는 저장됐지만 화면 갱신에 실패했습니다. 목록을 새로 불러와 주세요.",
      };
      return freezeResult("stopped", results);
    }
  }
  return freezeResult("complete", results);
}

/** 실행 전에 전체 계획을 검증·복사해 중간에 바뀐 객체나 뒤쪽 invalid 항목을 쓰지 않습니다. */
function validateAndSnapshotPlan(plan: OcrInventoryPlan): OcrInventoryPlan {
  if (
    !isRecord(plan) ||
    !isJobId(plan.jobId) ||
    !isVersion(plan.reviewVersion) ||
    !isMode(plan.mode) ||
    !Array.isArray(plan.items) ||
    plan.items.length < 1 ||
    plan.items.length > MAX_ROWS
  )
    fail("재고 반영 계획을 다시 생성해 주세요.");
  const productIds = new Set<string>();
  const rowIds = new Set<string>();
  for (const item of plan.items) {
    if (
      !isRecord(item) ||
      !isProductId(item.productId) ||
      productIds.has(item.productId) ||
      !isText(item.productName, 160) ||
      (item.sku !== undefined && !isText(item.sku, 80)) ||
      !isVersion(item.expectedVersion) ||
      !isStock(item.beforeStock) ||
      !isQuantity(item.quantity, plan.mode) ||
      !isStock(item.nextStock) ||
      item.nextStock !==
        (plan.mode === "add" ? item.beforeStock + item.quantity : item.quantity) ||
      !Array.isArray(item.rowIds) ||
      item.rowIds.length < 1
    )
      fail(
        `상품 ID·버전 또는 수량이 올바르지 않습니다. 수량은 ${plan.mode === "add" ? "1" : "0"}~1,000,000개로 다시 검토해 주세요.`,
      );
    productIds.add(item.productId);
    for (const rowId of item.rowIds) {
      if (!isText(rowId, 128) || rowIds.has(rowId) || rowIds.size >= MAX_ROWS)
        fail("검토 행이 중복되거나 달라졌습니다. 재고 계획을 다시 생성해 주세요.");
      rowIds.add(rowId);
    }
  }
  return freezePlan(plan);
}

function freezePlan(plan: OcrInventoryPlan): OcrInventoryPlan {
  return Object.freeze({
    jobId: plan.jobId,
    reviewVersion: plan.reviewVersion,
    mode: plan.mode,
    items: Object.freeze(
      plan.items.map((item) =>
        Object.freeze({ ...item, rowIds: Object.freeze([...item.rowIds]) }),
      ),
    ),
  });
}

function freezeResult(
  status: OcrInventoryCommitResult["status"],
  items: readonly OcrInventoryCommitItemResult[],
): OcrInventoryCommitResult {
  return Object.freeze({
    status,
    items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
  });
}

export function fail(message: string): never {
  throw new OcrInventoryPlanError(message);
}
