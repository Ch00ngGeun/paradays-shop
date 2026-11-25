// 역할: OCR 검토 행을 기존 상품 후보(상품 ID·SKU·이름 조합)와 대조하고 신규 상품 입력을 검증합니다.
import type { AdminCatalogListItem, AdminOcrReviewRow } from "@/lib/admin-ui/types";
import type { Locale } from "@/types/store";

/** 대조 결과는 제안일 뿐이며, 정확히 하나만 맞아도 관리자가 명시적으로 선택해야 합니다. */
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

/** NFC·공백·대소문자만 정규화하며 문장부호 제거·NFKC·유사 일치는 하지 않습니다. */
export function normalizeOcrIntakeText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** SKU는 의도적으로 대소문자를 구분하며 식별자의 문장부호를 지우지 않습니다. */
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
  locale: Locale = "ko",
): string | null {
  const isKorean = locale === "ko";
  if (!text(product.name, 160))
    return isKorean
      ? "신규 상품명은 1~160자로 입력해 주세요."
      : "Enter the new product name in 1–160 characters.";
  if (!text(product.brandName, 100))
    return isKorean
      ? "신규 상품 브랜드는 1~100자로 입력해 주세요."
      : "Enter the new product brand in 1–100 characters.";
  if (
    typeof product.option !== "string" ||
    product.option.length > 50 ||
    product.option.includes("\0") ||
    product.option.includes(",") ||
    /[\r\n]/u.test(product.option)
  )
    return isKorean
      ? "신규 상품 옵션은 쉼표·줄바꿈 없이 50자 이내로 입력해 주세요. 옵션별 재고는 생성하지 않습니다."
      : "Enter the new product option in 50 characters or fewer without commas or line breaks. Stock per option is not created.";
  if (product.sku !== undefined && !text(product.sku, 80))
    return isKorean
      ? "신규 SKU는 1~80자로 입력해 주세요."
      : "Enter the new SKU in 1–80 characters.";
  if (
    !Number.isSafeInteger(product.price) ||
    product.price < 0 ||
    product.price > 100_000_000
  )
    return isKorean
      ? "신규 상품 가격은 필수이며 0~100,000,000원 정수여야 합니다."
      : "The new product price is required and must be a whole number from 0 to 100,000,000 KRW.";
  if (!(OCR_INTAKE_CATEGORIES as readonly string[]).includes(product.category))
    return isKorean
      ? "신규 상품의 허용된 카테고리를 선택해 주세요."
      : "Choose an allowed category for the new product.";
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
