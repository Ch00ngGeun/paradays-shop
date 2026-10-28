// 역할: 저장된 OCR 검토본과 명시적 상품 선택을 고정 재고 계획으로 바꿉니다.
// 기능: 기존 version 조건부 PATCH만 순서대로 호출하며 실패 후 자동 재시도하지 않습니다.
import type {
  AdminCatalogListItem,
  AdminOcrIntakeInput,
  AdminOcrIntakeResult,
  AdminOcrRecognitionResult,
} from "@/lib/admin-ui/types";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import { OCR_INPUT_LIMITS } from "@/lib/admin-ui/ocr-input-validation";
import {
  findOcrIntakeMatches,
  getOcrIntakeNewProductValidationMessage,
  normalizeOcrIntakeSku,
  normalizeOcrIntakeText,
  ocrIntakeIdentity,
  type OcrIntakeNewProduct,
  type OcrIntakeReference,
} from "@/lib/admin-ui/ocr-intake-matching";
import type { Locale } from "@/types/store";

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

const MAX_STOCK = 1_000_000;
const MAX_ROWS = 500;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMode(value: unknown): value is OcrInventoryMode {
  return value === "add" || value === "replace";
}
function isText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}
function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID.test(value);
}
function isProductId(value: unknown): value is string {
  return typeof value === "string" && PRODUCT_ID.test(value);
}
function isVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_STOCK
  );
}
function isStock(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_STOCK
  );
}
function isQuantity(value: unknown, mode: OcrInventoryMode): value is number {
  return isStock(value) && (mode === "replace" || value > 0);
}
function fail(message: string): never {
  throw new OcrInventoryPlanError(message);
}

export type OcrIntakeChoice =
  | Readonly<{ kind: "existing"; productId: string; confirmed: boolean }>
  | Readonly<{ kind: "new"; product: OcrIntakeNewProduct; confirmed: boolean }>;
export type OcrIntakeSelection = Readonly<Record<string, OcrIntakeChoice>>;
type OcrIntakeCommonItem = Readonly<{
  itemId: string;
  productName: string;
  beforeStock: number;
  quantity: number;
  nextStock: number;
  rowIds: readonly string[];
}>;
export type OcrIntakePlanItem =
  | (OcrIntakeCommonItem &
      Readonly<{
        kind: "existing";
        productId: string;
        expectedVersion: number;
        sku?: string;
      }>)
  | (OcrIntakeCommonItem & Readonly<{ kind: "new"; product: OcrIntakeNewProduct }>);
export type OcrIntakePlan = Readonly<{
  jobId: string;
  reviewVersion: number;
  items: readonly OcrIntakePlanItem[];
}>;
export type OcrIntakeCommitResult = Readonly<{
  status: "complete" | "stopped";
  items: readonly Readonly<{
    itemId: string;
    productId?: string;
    status: "applied" | "failed" | "uncertain" | "pending";
    replayed?: boolean;
    message?: string;
  }>[];
}>;

/** A saved review only becomes an additive intake after every row is explicitly confirmed. */
export function buildOcrIntakePlan(
  input: Readonly<{
    job: AdminOcrRecognitionResult;
    products: readonly AdminCatalogListItem[];
    selection: OcrIntakeSelection;
    references?: Readonly<Record<string, OcrIntakeReference>>;
  }>,
  locale: Locale = "ko",
): OcrIntakePlan {
  const t = localize(locale);
  if (
    !isRecord(input) ||
    !isRecord(input.job) ||
    !isJobId(input.job.jobId) ||
    !isVersion(input.job.version) ||
    !Array.isArray(input.job.rows) ||
    input.job.rows.length < 1 ||
    input.job.rows.length > MAX_ROWS ||
    !Array.isArray(input.products) ||
    !isRecord(input.selection)
  )
    fail(
      t(
        "저장된 OCR 검토본과 현재 상품 목록을 다시 확인해 주세요.",
        "Check the saved OCR review and the current product list again.",
      ),
    );
  const products = new Map<string, AdminCatalogListItem>();
  for (const product of input.products) {
    if (
      !isRecord(product) ||
      !isProductId(product.id) ||
      products.has(product.id) ||
      !isVersion(product.version) ||
      !isStock(product.stock) ||
      !isText(product.name, 160) ||
      typeof product.brand !== "string" ||
      typeof product.sizes !== "string" ||
      (product.sku !== undefined && !isText(product.sku, 80))
    )
      fail(
        t(
          "상품 목록의 ID·버전·재고를 확인하고 다시 불러와 주세요.",
          "Check the product list IDs, versions and stock, then reload it.",
        ),
      );
    products.set(product.id, product as AdminCatalogListItem);
  }
  const items: OcrIntakePlanItem[] = [];
  const existingIndexes = new Map<string, number>();
  const newIdentities = new Set<string>();
  const newSkus = new Set<string>();
  const rows = new Set<string>();
  for (const [index, row] of input.job.rows.entries()) {
    const prefix = t(`${index + 1}번째 행`, `Row ${index + 1}`);
    if (
      !isRecord(row) ||
      !isText(row.id, 128) ||
      rows.has(row.id) ||
      !isText(row.productName, OCR_INPUT_LIMITS.maxProductNameLength) ||
      typeof row.brand !== "string" ||
      typeof row.option !== "string"
    )
      fail(
        t(
          `${prefix}의 검토 내용을 확인해 주세요.`,
          `Check the review content of ${prefix}.`,
        ),
      );
    rows.add(row.id);
    if (
      typeof row.quantity !== "string" ||
      !/^[0-9]{1,9}$/.test(row.quantity) ||
      !isQuantity(Number(row.quantity), "add")
    )
      fail(
        t(
          `${prefix}의 입고 수량은 1~1,000,000 정수여야 합니다.`,
          `The receiving quantity of ${prefix} must be a whole number from 1 to 1,000,000.`,
        ),
      );
    const choice = Object.hasOwn(input.selection, row.id)
      ? input.selection[row.id]
      : undefined;
    if (!isRecord(choice) || choice.confirmed !== true)
      fail(
        t(
          `${prefix}의 상품 연결 또는 신규 등록 내용을 개별 확인해 주세요.`,
          `Confirm the product link or new product entry of ${prefix} individually.`,
        ),
      );
    const quantity = Number(row.quantity);
    if (choice.kind === "existing") {
      const product =
        typeof choice.productId === "string"
          ? products.get(choice.productId)
          : undefined;
      if (!product)
        fail(
          t(
            `${prefix}에 반영할 기존 상품을 직접 선택해 주세요.`,
            `Select the existing product to apply to ${prefix} yourself.`,
          ),
        );
      const previousIndex = existingIndexes.get(product.id);
      const previous = previousIndex === undefined ? undefined : items[previousIndex];
      const total = (previous?.quantity ?? 0) + quantity;
      if (!isQuantity(total, "add") || !isStock(product.stock + total))
        fail(
          t(
            "동일 상품 입고 합계와 반영 재고는 1,000,000개를 넘을 수 없습니다.",
            "The received total and resulting stock for one product cannot exceed 1,000,000.",
          ),
        );
      const item: OcrIntakePlanItem = {
        kind: "existing",
        itemId: `existing:${product.id}`,
        productId: product.id,
        productName: product.name,
        expectedVersion: product.version,
        beforeStock: product.stock,
        quantity: total,
        nextStock: product.stock + total,
        rowIds: [...(previous?.rowIds ?? []), row.id],
        ...(product.sku ? { sku: product.sku } : {}),
      };
      if (previousIndex === undefined) {
        existingIndexes.set(product.id, items.length);
        items.push(item);
      } else items[previousIndex] = item;
    } else if (choice.kind === "new" && isRecord(choice.product)) {
      const product = readIntakeNewProduct(choice.product, locale);
      const reference = input.references?.[row.id];
      const matches = findOcrIntakeMatches(
        { productName: product.name, brand: product.brandName, option: product.option },
        input.products,
        { ...reference, ...(product.sku ? { sku: product.sku } : {}) },
      );
      if (matches.candidates.length || matches.basis === "unresolved-id")
        fail(
          t(
            `${prefix}: 기존 상품 또는 중복 후보가 있습니다. 상품 목록을 확인해 기존 상품을 선택해 주세요.`,
            `${prefix}: An existing product or duplicate candidate exists. Check the product list and select the existing product.`,
          ),
        );
      const identity = ocrIntakeIdentity(product);
      if (newIdentities.has(identity) || (product.sku && newSkus.has(product.sku)))
        fail(
          t(
            "같은 신규 상품 또는 SKU가 여러 행에 있습니다. 검토 행과 수량을 합친 뒤 다시 저장해 주세요.",
            "The same new product or SKU appears in several rows. Merge the review rows and quantities, then save again.",
          ),
        );
      newIdentities.add(identity);
      if (product.sku) newSkus.add(product.sku);
      items.push({
        kind: "new",
        itemId: `new:${row.id}`,
        productName: product.name,
        product,
        beforeStock: 0,
        quantity,
        nextStock: quantity,
        rowIds: [row.id],
      });
    } else
      fail(
        t(`${prefix}의 입고 방식을 선택해 주세요.`, `Choose how to receive ${prefix}.`),
      );
  }
  if (
    Object.keys(input.selection).some((id) => !rows.has(id)) ||
    (input.references && Object.keys(input.references).some((id) => !rows.has(id)))
  )
    fail(
      t(
        "현재 검토본과 선택한 행이 다릅니다. 입고 계획을 다시 확인해 주세요.",
        "The selected rows differ from the current review. Check the receiving plan again.",
      ),
    );
  return snapshotIntakePlan(
    {
      jobId: input.job.jobId,
      reviewVersion: input.job.version,
      items,
    },
    locale,
  );
}

/** Hash all immutable row identities before any write. Retries never invent a new operation key. */
export async function executeOcrIntakePlan(
  plan: OcrIntakePlan,
  dependencies: Readonly<{
    applyOcrIntake: (input: AdminOcrIntakeInput) => Promise<AdminOcrIntakeResult>;
    onProductUpdated?: (product: AdminCatalogListItem) => void | Promise<void>;
  }>,
  locale: Locale = "ko",
): Promise<OcrIntakeCommitResult> {
  const t = localize(locale);
  const snapshot = snapshotIntakePlan(plan, locale);
  if (
    !isRecord(dependencies) ||
    typeof dependencies.applyOcrIntake !== "function" ||
    (dependencies.onProductUpdated !== undefined &&
      typeof dependencies.onProductUpdated !== "function")
  )
    fail(
      t(
        "입고 저장 API가 연결되지 않았습니다.",
        "The receiving save API is not connected.",
      ),
    );
  if (!globalThis.crypto?.subtle)
    fail(
      t(
        "중복 반영 방지 기능을 사용할 수 없습니다. HTTPS 연결을 확인해 주세요.",
        "Duplicate protection is unavailable. Check the HTTPS connection.",
      ),
    );
  const operations = await Promise.all(
    snapshot.items.map(async (item): Promise<AdminOcrIntakeInput> => {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([snapshot.jobId, [...item.rowIds].sort()]),
        ),
      );
      const operationId = `ocr_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      return item.kind === "existing"
        ? {
            operationId,
            kind: "existing",
            quantity: item.quantity,
            source: { jobId: snapshot.jobId, rowIds: [...item.rowIds].sort() },
            existing: { productId: item.productId, version: item.expectedVersion },
          }
        : {
            operationId,
            kind: "new",
            quantity: item.quantity,
            source: { jobId: snapshot.jobId, rowIds: [...item.rowIds].sort() },
            product: { ...item.product },
          };
    }),
  );
  const results: OcrIntakeCommitResult["items"][number][] = snapshot.items.map(
    (item) => ({ itemId: item.itemId, status: "pending" }),
  );
  for (const [index, item] of snapshot.items.entries()) {
    const operation = operations[index];
    let response: AdminOcrIntakeResult;
    try {
      response = await dependencies.applyOcrIntake(operation);
    } catch (error) {
      const known =
        error instanceof AdminApiRequestError &&
        [400, 401, 403, 409].includes(error.status);
      results[index] = {
        itemId: item.itemId,
        status: known ? "failed" : "uncertain",
        message: known
          ? error.status === 409
            ? t(
                "다른 관리자가 등록했거나 기존 상품·버전과 충돌했습니다. 상품 목록을 다시 확인해 주세요. 자동 재시도하지 않습니다.",
                "Another admin registered it or it conflicted with an existing product or version. Check the product list again. It is not retried automatically.",
              )
            : t(
                "입고 저장이 거절됐습니다. 입력값과 관리자 권한을 확인해 주세요.",
                "Saving the receipt was rejected. Check the input and admin permissions.",
              )
          : t(
              "저장 결과가 불명확합니다. 실제 상품·재고를 먼저 확인하세요. 중복 입고를 막기 위해 자동 재시도하지 않습니다.",
              "The save result is unclear. Check the actual products and stock first. It is not retried automatically to avoid duplicate receipts.",
            ),
      };
      return freezeIntakeResult("stopped", results);
    }
    if (!matchesIntakeResponse(response, operation, item)) {
      results[index] = {
        itemId: item.itemId,
        status: "uncertain",
        message: t(
          "입고 저장 응답이 확인한 계획과 다릅니다. 실제 상품·재고를 먼저 확인해 주세요.",
          "The save response differs from the confirmed plan. Check the actual products and stock first.",
        ),
      };
      return freezeIntakeResult("stopped", results);
    }
    results[index] = {
      itemId: item.itemId,
      productId: response.product.id,
      status: "applied",
      replayed: response.receipt.replayed,
    };
    // A replay returns its original receipt, not necessarily the current product. Do not resurrect stale/deleted products.
    if (!response.receipt.replayed) {
      try {
        await dependencies.onProductUpdated?.(response.product);
      } catch {
        results[index] = {
          ...results[index],
          message: t(
            "입고는 저장됐지만 화면 갱신에 실패했습니다. 상품 목록을 다시 불러와 주세요.",
            "The receipt was saved but the screen failed to refresh. Reload the product list.",
          ),
        };
        return freezeIntakeResult("stopped", results);
      }
    }
  }
  return freezeIntakeResult("complete", results);
}

function matchesIntakeResponse(
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

function snapshotIntakePlan(plan: OcrIntakePlan, locale: Locale): OcrIntakePlan {
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
function localize(locale: Locale) {
  return (ko: string, en: string) => (locale === "ko" ? ko : en);
}

function freezeIntakeResult(
  status: OcrIntakeCommitResult["status"],
  items: OcrIntakeCommitResult["items"],
): OcrIntakeCommitResult {
  return Object.freeze({
    status,
    items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
  });
}

function readIntakeNewProduct(value: unknown, locale: Locale): OcrIntakeNewProduct {
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
