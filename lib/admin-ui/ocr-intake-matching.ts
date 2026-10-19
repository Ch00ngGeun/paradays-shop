import type { AdminCatalogListItem, AdminOcrReviewRow } from "@/lib/admin-ui/types";

/** Matches are suggestions only. Even a unique exact result requires explicit selection. */
export type OcrIntakeMatch = Readonly<{
  basis: "product-id" | "sku" | "composite" | "possible" | "none" | "unresolved-id";
  candidates: readonly AdminCatalogListItem[];
}>;
export type OcrIntakeReference = Readonly<{ productId?: string; sku?: string }>;
export type OcrIntakeNewProduct = Readonly<{
  name: string;
  brandName: string;
  option: string;
  sku?: string;
  price: number;
  category: string;
}>;

export const OCR_INTAKE_CATEGORIES = Object.freeze([
  "Deck",
  "Complete",
  "Top",
  "Bottom",
  "Outerwear",
  "Shoes",
  "Accessories",
  "Wheels",
  "Trucks",
  "Bearings",
  "Hardware",
  "Protection",
  "Other",
] as const);

/** NFC and whitespace/case only: no punctuation removal, NFKC or fuzzy matching. */
export function normalizeOcrIntakeText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** SKU is deliberately case-sensitive; identifiers never lose punctuation. */
export function normalizeOcrIntakeSku(value: string): string {
  return value.normalize("NFC").trim();
}

export function ocrIntakeIdentity(
  product: Pick<OcrIntakeNewProduct, "name" | "brandName" | "option">,
): string {
  return JSON.stringify(
    [product.name, product.brandName, product.option].map(normalizeOcrIntakeText),
  );
}

export function findOcrIntakeMatches(
  row: Pick<AdminOcrReviewRow, "productName" | "brand" | "option">,
  products: readonly AdminCatalogListItem[],
  reference: OcrIntakeReference = {},
): OcrIntakeMatch {
  const productId = reference.productId?.trim();
  if (productId) {
    const candidates = products.filter((product) => product.id === productId);
    return result(candidates.length ? "product-id" : "unresolved-id", candidates);
  }
  const sku = normalizeOcrIntakeSku(reference.sku ?? "");
  if (sku) {
    const candidates = products.filter(
      (product) =>
        product.sku !== undefined && normalizeOcrIntakeSku(product.sku) === sku,
    );
    if (candidates.length) return result("sku", candidates);
  }
  const name = normalizeOcrIntakeText(row.productName);
  const brand = normalizeOcrIntakeText(row.brand);
  const option = normalizeOcrIntakeText(row.option);
  if (!name) return result("none", []);
  const candidates = products.filter((product) => {
    if (normalizeOcrIntakeText(product.name) !== name) return false;
    if (brand && normalizeOcrIntakeText(product.brand) !== brand) return false;
    const options = product.sizes
      .split(",")
      .map(normalizeOcrIntakeText)
      .filter(Boolean);
    return !option || options.length === 0 || options.includes(option);
  });
  return result(
    candidates.length
      ? brand &&
        option &&
        candidates.every((product) =>
          product.sizes.split(",").some((size) => normalizeOcrIntakeText(size)),
        )
        ? "composite"
        : "possible"
      : "none",
    candidates,
  );
}

export function getOcrIntakeNewProductValidationMessage(
  product: OcrIntakeNewProduct,
): string | null {
  if (!text(product.name, 160)) return "신규 상품명은 1~160자로 입력해 주세요.";
  if (!text(product.brandName, 100))
    return "신규 상품 브랜드는 1~100자로 입력해 주세요.";
  if (
    typeof product.option !== "string" ||
    product.option.length > 50 ||
    product.option.includes("\0") ||
    product.option.includes(",") ||
    /[\r\n]/u.test(product.option)
  )
    return "신규 상품 옵션은 쉼표·줄바꿈 없이 50자 이내로 입력해 주세요. 옵션별 재고는 생성하지 않습니다.";
  if (product.sku !== undefined && !text(product.sku, 80))
    return "신규 SKU는 1~80자로 입력해 주세요.";
  if (
    !Number.isSafeInteger(product.price) ||
    product.price < 0 ||
    product.price > 100_000_000
  )
    return "신규 상품 가격은 필수이며 0~100,000,000원 정수여야 합니다.";
  if (!(OCR_INTAKE_CATEGORIES as readonly string[]).includes(product.category))
    return "신규 상품의 허용된 카테고리를 선택해 주세요.";
  return null;
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}
function result(
  basis: OcrIntakeMatch["basis"],
  candidates: readonly AdminCatalogListItem[],
): OcrIntakeMatch {
  return Object.freeze({ basis, candidates: Object.freeze([...candidates]) });
}
