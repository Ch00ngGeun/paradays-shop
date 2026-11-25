// 역할: 저장된 OCR 검토본과 행별 확인 선택을 신규·기존 상품 입고 계획으로 바꾸고 순서대로 저장합니다.
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
  ocrIntakeIdentity,
  type OcrIntakeNewProduct,
  type OcrIntakeReference,
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
} from "@/lib/admin-ui/ocr-inventory-commit-guards";
import {
  freezeIntakeResult,
  localize,
  matchesIntakeResponse,
  readIntakeNewProduct,
  snapshotIntakePlan,
} from "@/lib/admin-ui/ocr-inventory-commit-intake-snapshot";
import type { Locale } from "@/types/store";

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

/** 저장된 검토본은 모든 행을 명시적으로 확인한 뒤에만 가산 입고 계획이 됩니다. */
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

/** 쓰기 전에 모든 불변 행 식별값을 hash로 고정하며, 재시도해도 새 작업 키를 만들지 않습니다. */
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
    // 재실행 응답은 원래 영수증을 돌려줄 뿐 현재 상품과 같다는 보장이 없으므로 낡거나 삭제된 상품을 되살리지 않습니다.
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
