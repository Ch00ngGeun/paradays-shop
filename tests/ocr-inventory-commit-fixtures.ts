// 역할: OCR 재고 반영 단위 검사의 합성 상품·검토 행·작업·계획과 입고 응답 도우미를 제공함.
import {
  buildOcrInventoryPlan,
  type OcrInventoryMode,
  type OcrInventoryPlan,
} from "@/lib/admin-ui/ocr-inventory-commit";
import {
  buildOcrIntakePlan,
  type OcrIntakePlan,
  type OcrIntakeSelection,
} from "@/lib/admin-ui/ocr-inventory-commit-intake";
import type {
  AdminCatalogListItem,
  AdminOcrRecognitionResult,
  AdminOcrReviewRow,
  AdminOcrIntakeInput,
  AdminOcrIntakeResult,
} from "@/lib/admin-ui/types";

export function product(id = "prd_deck", stock = 10): AdminCatalogListItem {
  return {
    id,
    name: "Example deck",
    sku: "DECK-825",
    brand: "Example",
    category: "Deck",
    price: 80_000,
    stock,
    isVisible: true,
    version: 3,
    sizes: "8.25",
    description: "",
    isFeatured: false,
  };
}
export function row(id = "row_A", quantity = "2"): AdminOcrReviewRow {
  return {
    id,
    productName: "Reviewed deck",
    quantity,
    sourceText: "PRIVATE RAW TEXT",
    brand: "Example",
    option: "8.25",
  };
}
export function job(
  rows: readonly AdminOcrReviewRow[] = [row()],
): AdminOcrRecognitionResult {
  return { jobId: "ocr_saved", version: 2, rawText: "PRIVATE RAW TEXT", rows };
}
export function build(
  mode: OcrInventoryMode = "add",
  rows = [row()],
): OcrInventoryPlan {
  return buildOcrInventoryPlan({
    job: job(rows),
    products: [product()],
    selection: Object.fromEntries(rows.map((item) => [item.id, "prd_deck"])),
    mode,
  });
}
export function twoProductPlan(): OcrInventoryPlan {
  return buildOcrInventoryPlan({
    job: job([row("row_A", "2"), row("row_B", "3")]),
    products: [product(), product("prd_wheel", 8)],
    selection: { row_A: "prd_deck", row_B: "prd_wheel" },
    mode: "add",
  });
}

export const newProduct = {
  name: "New deck",
  brandName: "New Maker",
  option: "8.5",
  price: 90000,
  category: "Deck",
};
export function intake(
  selection: OcrIntakeSelection = {
    row_A: { kind: "existing", productId: "prd_deck", confirmed: true },
    row_B: { kind: "new", product: newProduct, confirmed: true },
  },
  rows = [row(), row("row_B", "3")],
): OcrIntakePlan {
  return buildOcrIntakePlan({ job: job(rows), products: [product()], selection });
}
export function intakeResponse(input: AdminOcrIntakeInput): AdminOcrIntakeResult {
  const beforeStock = input.kind === "existing" ? 10 : 0;
  return {
    product:
      input.kind === "existing"
        ? {
            ...product(input.existing.productId),
            version: input.existing.version + 1,
            stock: beforeStock + input.quantity,
          }
        : {
            ...product("prd_new"),
            name: input.product.name,
            brand: input.product.brandName,
            sku: input.product.sku,
            sizes: input.product.option,
            price: input.product.price,
            category: input.product.category,
            version: 1,
            stock: input.quantity,
            isVisible: false,
            isFeatured: false,
          },
    receipt: {
      operationId: input.operationId,
      kind: input.kind,
      quantity: input.quantity,
      beforeStock,
      afterStock: beforeStock + input.quantity,
      replayed: false,
    },
  };
}
