// 역할: 상품 폼의 관리 코드·브랜드 선택·옵션 추가를 기존 카탈로그 문자열 계약 안에서 처리합니다.

export const PRODUCT_OPTION_LIMITS = Object.freeze({
  maximumItems: 20,
  maximumItemLength: 50,
});

export const PRODUCT_DECK_WIDTHS = Object.freeze([
  "7.5",
  "7.75",
  "8.0",
  "8.125",
  "8.25",
  "8.5",
]);

export const PRODUCT_WHEEL_DIAMETERS = Object.freeze(
  Array.from({ length: 11 }, (_, index) => index + 50),
);

export const PRODUCT_WHEEL_HARDNESSES = Object.freeze(
  Array.from({ length: 22 }, (_, index) => index + 80),
);

/** 새 초안을 만드는 호출부에서 한 번 호출합니다. 편집 세션 ID·URL·storage와 무관합니다. */
export function createProductSku(
  createUuid: () => string = () => crypto.randomUUID(),
): string {
  return createUuid();
}

/** 최초 표시 철자를 유지하며, 현재 조회 범위의 공백·대소문자 중복만 제거합니다. */
export function mergeProductBrandNames(
  ...sources: readonly (readonly string[])[]
): readonly string[] {
  const seen = new Set<string>();
  const brands: string[] = [];
  for (const source of sources) {
    for (const value of source) {
      const brand = value.trim();
      if (!brand || brand === "—") continue;
      const key = brand.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      brands.push(brand);
    }
  }
  return brands;
}

export type ProductOptionError =
  | "empty-option"
  | "multiple-options"
  | "option-too-long"
  | "too-many-options";

export type ProductOptionAppendResult =
  | Readonly<{ ok: true; value: string; added: boolean }>
  | Readonly<{ ok: false; value: string; reason: ProductOptionError }>;

/** 서버의 comma 목록과 같은 20개·항목당 50 UTF-16 단위 한도를 확인합니다. */
export function validateProductOptions(
  value: string,
): "option-too-long" | "too-many-options" | null {
  const options = value
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean);
  if (options.length > PRODUCT_OPTION_LIMITS.maximumItems) return "too-many-options";
  if (options.some((option) => option.length > PRODUCT_OPTION_LIMITS.maximumItemLength))
    return "option-too-long";
  return null;
}

/** 기존 옵션은 재정렬·정규화하지 않습니다. 선택한 새 옵션 한 개만 명시적으로 덧붙입니다. */
export function appendProductOption(
  current: string,
  value: string,
): ProductOptionAppendResult {
  const option = value.trim();
  if (!option) return { ok: false, value: current, reason: "empty-option" };
  if (/[,\r\n]/.test(option))
    return { ok: false, value: current, reason: "multiple-options" };
  if (option.length > PRODUCT_OPTION_LIMITS.maximumItemLength)
    return { ok: false, value: current, reason: "option-too-long" };

  const existingError = validateProductOptions(current);
  if (existingError) return { ok: false, value: current, reason: existingError };
  const options = current
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (options.includes(option)) return { ok: true, value: current, added: false };
  if (options.length >= PRODUCT_OPTION_LIMITS.maximumItems)
    return { ok: false, value: current, reason: "too-many-options" };

  return {
    ok: true,
    value: `${current}${options.length ? ", " : ""}${option}`,
    added: true,
  };
}

/** 새로 선택하는 규격에만 사용합니다. 저장된 legacy 옵션을 이 형식으로 바꾸지 않습니다. */
export function formatProductDeckOption(width: string): string | null {
  return PRODUCT_DECK_WIDTHS.includes(width) ? `${width}”` : null;
}

/** 크기·경도가 모두 선택된 조합 하나가 한 개의 구매 옵션입니다. */
export function formatProductWheelOption(
  diameter: string,
  hardness: string,
): string | null {
  if (!/^[1-9]\d*$/.test(diameter) || !/^[1-9]\d*$/.test(hardness)) return null;
  if (
    !PRODUCT_WHEEL_DIAMETERS.includes(Number(diameter)) ||
    !PRODUCT_WHEEL_HARDNESSES.includes(Number(hardness))
  )
    return null;
  return `${diameter}mm / ${hardness}a`;
}
