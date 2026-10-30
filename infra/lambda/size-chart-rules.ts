// 역할: 데크 외 상세사이즈(의류·휠) 규칙의 서버 복제본입니다.
// 원본은 루트 lib/size-chart.ts이며(infra는 별도 패키지라 공유하지 않음), 테스트가 두 쪽을 같은 표로 비교합니다.

export const SIZE_CHART_KINDS = [
  "shortSleeve",
  "raglanLongSleeve",
  "longPants",
  "shorts",
  "wheel",
] as const;

export type SizeChartKind = (typeof SIZE_CHART_KINDS)[number];

const PANTS_KEYS = ["length", "waist", "hip", "thigh", "rise", "hem"] as const;

/** 도면 종류별 단위와 항목 key(도면 번호 순서). */
export const SIZE_CHART_KIND_RULES: Readonly<
  Record<SizeChartKind, Readonly<{ unit: "cm" | "mm"; keys: readonly string[] }>>
> = {
  shortSleeve: {
    unit: "cm",
    keys: [
      "length",
      "shoulder",
      "chest",
      "sleeveLength",
      "hem",
      "sleeveWidth",
      "armhole",
    ],
  },
  raglanLongSleeve: {
    unit: "cm",
    keys: ["length", "chest", "cuff", "neckToCuff", "hem", "armhole"],
  },
  longPants: { unit: "cm", keys: PANTS_KEYS },
  shorts: { unit: "cm", keys: PANTS_KEYS },
  wheel: { unit: "mm", keys: ["diameter", "width", "contactWidth"] },
};

/** 카테고리별로 고를 수 있는 도면 종류(첫 번째가 기본값). Deck은 deckSpec을 씁니다. */
const CATEGORY_KINDS: Readonly<Record<string, readonly SizeChartKind[]>> = {
  Top: ["shortSleeve", "raglanLongSleeve"],
  Outerwear: ["raglanLongSleeve", "shortSleeve"],
  Bottom: ["longPants", "shorts"],
  Wheels: ["wheel"],
};

const MAX_VALUE = { cm: 300, mm: 100 } as const;

/** 항목 key → 값(cm 또는 mm). 비운 칸은 null입니다. */
export type SizeChartValues = Readonly<Record<string, number | null>>;

export type CatalogSizeChart = Readonly<{
  kind: SizeChartKind;
  values: SizeChartValues;
}>;

export function sizeChartKindsFor(category: string): readonly SizeChartKind[] {
  return Object.hasOwn(CATEGORY_KINDS, category) ? CATEGORY_KINDS[category] : [];
}

export function defaultSizeChartKind(category: string): SizeChartKind | undefined {
  return sizeChartKindsFor(category)[0];
}

/** 값이 그 카테고리에서 고를 수 있는 도면 종류일 때만 돌려줍니다. */
export function allowedSizeChartKind(
  category: string,
  value: unknown,
): SizeChartKind | undefined {
  return isSizeChartKind(value) && sizeChartKindsFor(category).includes(value)
    ? value
    : undefined;
}

export function isSizeChartKind(value: unknown): value is SizeChartKind {
  return SIZE_CHART_KINDS.includes(value as SizeChartKind);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * 그 도면 종류의 항목만 빠짐없이 있고, 값은 0 초과 최댓값(cm 300·mm 100) 이하·소수 1자리 숫자 또는
 * 비운 칸(null)이며, 숫자가 하나 이상일 때만 참입니다. 모든 칸 null은 삭제(null)로 보내므로 거부합니다.
 */
export function isSizeChartValues(
  kind: SizeChartKind,
  value: unknown,
): value is SizeChartValues {
  const { unit, keys } = SIZE_CHART_KIND_RULES[kind];
  const isValue = (number: unknown) =>
    typeof number === "number" &&
    Number.isFinite(number) &&
    Math.round(number * 10) / 10 === number &&
    number > 0 &&
    number <= MAX_VALUE[unit];
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, keys) &&
    keys.every((key) => value[key] === null || isValue(value[key])) &&
    keys.some((key) => value[key] !== null)
  );
}

/** { kind, values } 정확히 두 필드이고 값이 그 kind 규칙에 맞을 때만 참입니다. */
export function isCatalogSizeChart(value: unknown): value is CatalogSizeChart {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["kind", "values"]) &&
    isSizeChartKind(value.kind) &&
    isSizeChartValues(value.kind, value.values)
  );
}

/** 검증한 값을 새 객체로 복사합니다(항목 순서는 도면 순서). */
export function copySizeChartValues(
  kind: SizeChartKind,
  values: SizeChartValues,
): SizeChartValues {
  return Object.fromEntries(
    SIZE_CHART_KIND_RULES[kind].keys.map((key) => [key, values[key]]),
  );
}

/** 저장 행의 상세사이즈를 새 객체로 복사합니다(항목 순서는 도면 순서). */
export function copySizeChart(chart: CatalogSizeChart): CatalogSizeChart {
  return { kind: chart.kind, values: copySizeChartValues(chart.kind, chart.values) };
}

/** 응답에 담을 수 있는 상세사이즈: 형식이 맞고 상품 카테고리에서 고를 수 있는 kind일 때만입니다. */
export function sizeChartFor(
  category: string,
  value: unknown,
): CatalogSizeChart | undefined {
  return isCatalogSizeChart(value) && sizeChartKindsFor(category).includes(value.kind)
    ? copySizeChart(value)
    : undefined;
}
