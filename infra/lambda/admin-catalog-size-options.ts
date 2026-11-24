import { isRecord } from "./request-helpers.js";
import {
  allowedSizeChartKind,
  copySizeChartValues,
  defaultSizeChartKind,
  isCatalogSizeChart,
  isSizeChartValues,
  sizeChartFor,
  type SizeChartKind,
  type SizeChartValues,
} from "./size-chart-rules.js";
import {
  type CatalogSizeChartsBySize,
  type CatalogDeckSpec,
  type CatalogDeckSpecsBySize,
  type CatalogProductRecord,
} from "./admin-catalog-handler.js";
import { hasOwn } from "./admin-catalog-values.js";

const DECK_SPEC_FIELDS = ["nose", "tail", "width", "length", "wheelbase"] as const;

const MAX_DECK_SPEC_INCHES = 100;

// Matches the sizes list limit, so every option can have its own spec.
const MAX_DECK_SPECS_BY_SIZE = 20;

// The DynamoDB marshaller assigns map keys onto a plain object, which these names would break.
const UNSAFE_DECK_SPEC_OPTIONS = ["__proto__", "constructor", "prototype"];

/** 옵션별 상세사이즈 키로 쓸 수 있는 현재 sizes 값인지 확인합니다. */
function isDeckSpecOption(sizes: readonly string[], size: string) {
  return sizes.includes(size) && !UNSAFE_DECK_SPEC_OPTIONS.includes(size);
}

// Up to 4 decimals (1/16" = 0.0625), matching what the admin modal can type and reopen unchanged.
const DECK_SPEC_INCHES_PATTERN = /^\d+(?:\.\d{1,4})?$/;

/** 생략·null은 상세사이즈 없음(undefined), 형식 오류는 null로 구분합니다. */
export function readDeckSpec(value: unknown): CatalogDeckSpec | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }

  return isCatalogDeckSpec(value)
    ? {
        nose: value.nose,
        tail: value.tail,
        width: value.width,
        length: value.length,
        wheelbase: value.wheelbase,
      }
    : null;
}

/**
 * 옵션별 상세사이즈를 읽습니다. 형식 오류는 null이고, sizes에 없는 옵션(이름 변경·삭제)의 값은 버립니다.
 * 남은 값이 없으면 undefined라 저장 행에서 필드가 빠집니다.
 */
export function readDeckSpecsBySize(
  value: unknown,
  sizes: readonly string[],
): CatalogDeckSpecsBySize | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    return null;
  }

  // Prune first, so a key left by an older server never counts against the limit.
  const entries: [string, CatalogDeckSpec][] = [];
  for (const [size, spec] of Object.entries(value)) {
    if (!isDeckSpecOption(sizes, size)) continue;
    const parsed = readDeckSpec(spec);
    if (!parsed) return null;
    entries.push([size, parsed]);
  }

  if (entries.length > MAX_DECK_SPECS_BY_SIZE) {
    return null;
  }

  // fromEntries defines own keys, so an option named __proto__ is stored like any other.
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * PATCH { version, size, sizeName?, sizeDeckSpec | sizeChartValues }: 저장된 옵션 하나의 데크 또는
 * 의류·휠 상세사이즈를 넣거나(null이면) 지우고, sizeName이 있으면 같은 위치의 옵션 이름도 바꿔
 * 두 종류의 옵션별 값을 모두 새 이름으로 옮깁니다.
 * 구 서버가 무시하거나 거부하도록 전용 필드만 쓰며, 다른 필드와 함께 오면 거부합니다.
 */
export function patchSizeOption(
  product: CatalogProductRecord,
  body: Record<string, unknown>,
): {
  sizes: string[];
  deckSpecsBySize: Record<string, CatalogDeckSpec>;
  sizeChartsBySize: Record<string, SizeChartValues>;
  sizeChartKind?: SizeChartKind;
} | null {
  const size = body.size;
  const name = hasOwn(body, "sizeName") ? body.sizeName : size;
  const editsDeck = hasOwn(body, "sizeDeckSpec");
  const field = editsDeck ? "sizeDeckSpec" : "sizeChartValues";
  const spec = readDeckSpec(body.sizeDeckSpec);
  const kind = currentSizeChartKind(product);
  const chartValues = body.sizeChartValues;

  if (
    // Exactly one of the two value fields says which option value is edited.
    editsDeck === hasOwn(body, "sizeChartValues") ||
    Object.keys(body).some(
      (key) => !["version", "size", "sizeName", field].includes(key),
    ) ||
    typeof size !== "string" ||
    !isDeckSpecOption(product.sizes, size) ||
    typeof name !== "string" ||
    // Only a new name is checked, so an existing legacy option keeps its H-035 save and delete.
    (name !== size && (!isSizeOptionName(name) || product.sizes.includes(name))) ||
    (editsDeck
      ? spec === null || (spec === undefined && body.sizeDeckSpec !== null)
      : !kind || (chartValues !== null && !isSizeChartValues(kind, chartValues)))
  ) {
    return null;
  }

  return {
    sizes: product.sizes.map((option) => (option === size ? name : option)),
    deckSpecsBySize: withOptionValue(
      product.deckSpecsBySize,
      size,
      name,
      editsDeck ? (spec ?? undefined) : ownValue(product.deckSpecsBySize, size),
    ),
    sizeChartsBySize: withOptionValue(
      product.sizeChartsBySize,
      size,
      name,
      editsDeck
        ? ownValue(product.sizeChartsBySize, size)
        : kind && isSizeChartValues(kind, chartValues)
          ? copySizeChartValues(kind, chartValues)
          : undefined,
    ),
    // Saving an option value records the drawing it follows, even without a default value.
    ...(!editsDeck && kind ? { sizeChartKind: kind } : {}),
  };
}

function ownValue<T>(map: Readonly<Record<string, T>> | undefined, key: string) {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** 옵션 키 size를 name으로 옮기며 값을 value로 바꿉니다(undefined면 지움). */
function withOptionValue<T>(
  map: Readonly<Record<string, T>> | undefined,
  size: string,
  name: string,
  value: T | undefined,
): Record<string, T> {
  // A stale key already named like the new option must not resurface after the rename.
  return Object.fromEntries([
    ...Object.entries(map ?? {}).filter(([key]) => key !== size && key !== name),
    ...(value === undefined ? [] : [[name, value] as const]),
  ]);
}

/** 상품 저장의 쉼표 목록 규칙(trim·50자·쉼표 없음)과 같고, 상세사이즈 키로 쓸 수 없는 이름은 거부합니다. */
function isSizeOptionName(name: string) {
  return (
    name.length > 0 &&
    name.length <= 50 &&
    name === name.trim() &&
    !/[,\r\n]/.test(name) &&
    !UNSAFE_DECK_SPEC_OPTIONS.includes(name)
  );
}

/**
 * 생략·null은 상세사이즈 없음(undefined), 형식 오류는 null입니다.
 * 형식은 맞지만 카테고리에서 고를 수 없는 kind(카테고리 변경)는 undefined라 저장 행에서 빠집니다.
 */
export function readSizeChart(value: unknown, category: string) {
  if (value === undefined || value === null) return undefined;
  return isCatalogSizeChart(value) ? sizeChartFor(category, value) : null;
}

/**
 * 옵션별 값이 따르는 도면 종류: 기본값의 kind, 따로 고른 kind, 카테고리 기본 kind 순서입니다.
 * 카테고리에서 고를 수 없게 된 kind는 건너뜁니다.
 */
export function currentSizeChartKind(product: CatalogProductRecord) {
  return (
    sizeChartFor(product.category, product.sizeChart)?.kind ??
    allowedSizeChartKind(product.category, product.sizeChartKind) ??
    defaultSizeChartKind(product.category)
  );
}

/** 현재 sizes에 있고 kind의 항목에 맞는 옵션별 값만 남깁니다. 남은 값이 없으면 undefined입니다. */
export function readSizeChartsBySize(
  value: unknown,
  sizes: readonly string[],
  kind: SizeChartKind | undefined,
): CatalogSizeChartsBySize | undefined {
  if (!kind || !isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter(
      ([size, values]) =>
        isDeckSpecOption(sizes, size) && isSizeChartValues(kind, values),
    )
    .map(
      ([size, values]) => [size, copySizeChartValues(kind, values as never)] as const,
    );
  // fromEntries defines own keys, so an option named like an Object method is stored like any other.
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function sizeChartsBySizeFor(
  product: CatalogProductRecord,
  kind: SizeChartKind | undefined,
) {
  return readSizeChartsBySize(product.sizeChartsBySize, product.sizes, kind);
}

/** 형식이 맞고 카테고리에 맞는 상세사이즈만 응답에 담습니다. 잘못된 저장 값은 상품을 숨기지 않고 빠집니다. */
export function sizeChartOutput(product: CatalogProductRecord) {
  const sizeChart = sizeChartFor(product.category, product.sizeChart);
  const kind = currentSizeChartKind(product);
  const sizeChartsBySize = sizeChartsBySizeFor(product, kind);
  const chosen = allowedSizeChartKind(product.category, product.sizeChartKind);
  return {
    ...(sizeChart ? { sizeChart } : {}),
    // The kind is named whenever one was chosen or follows from a value.
    ...(kind && (sizeChart || chosen || sizeChartsBySize)
      ? { sizeChartKind: kind }
      : {}),
    ...(sizeChartsBySize ? { sizeChartsBySize } : {}),
  };
}

/** 저장 행의 옵션별 상세사이즈 중 현재 sizes에 있는 값만 응답에 담습니다. */
export function deckSpecsBySizeOutput(product: CatalogProductRecord) {
  const deckSpecsBySize = Object.fromEntries(
    Object.entries(product.deckSpecsBySize ?? {})
      .filter(([size]) => isDeckSpecOption(product.sizes, size))
      .map(([size, spec]) => [size, { ...spec }]),
  );
  return Object.keys(deckSpecsBySize).length ? { deckSpecsBySize } : {};
}

/**
 * 5칸이 모두 있고, 각 칸은 범위·소수 4자리 안의 인치이거나 비운 칸(null)이며, 숫자가 하나 이상일 때만 참입니다.
 * 모든 칸이 null이면 거부합니다: 다 비운 저장은 상세사이즈 삭제(null)로 보냅니다.
 */
export function isCatalogDeckSpec(value: unknown): value is CatalogDeckSpec {
  const isInches = (inches: unknown) =>
    typeof inches === "number" &&
    Number.isFinite(inches) &&
    inches > 0 &&
    inches <= MAX_DECK_SPEC_INCHES &&
    DECK_SPEC_INCHES_PATTERN.test(String(inches));
  return (
    isRecord(value) &&
    DECK_SPEC_FIELDS.every(
      (field) =>
        hasOwn(value, field) && (value[field] === null || isInches(value[field])),
    ) &&
    DECK_SPEC_FIELDS.some((field) => value[field] !== null)
  );
}
