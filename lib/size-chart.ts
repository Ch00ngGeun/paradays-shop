// 역할: 데크 외 상세사이즈(의류·휠)의 도면 종류·측정 항목·단위·입력 범위와 파싱·검증 규칙입니다.
// 서버(infra)는 별도 패키지라 D2에서 같은 규칙을 복제하고, 두 쪽을 같은 표로 테스트합니다.
import type { Locale } from "@/types/store";

export const SIZE_CHART_KINDS = [
  "shortSleeve",
  "raglanLongSleeve",
  "longPants",
  "shorts",
  "wheel",
] as const;

export type SizeChartKind = (typeof SIZE_CHART_KINDS)[number];
export type SizeChartUnit = "cm" | "mm";
/** 항목 key → 값(cm 또는 mm). 도면 종류의 항목 key가 모두 있어야 하고, 비운 칸은 null입니다. */
export type SizeChartValues = Record<string, number | null>;

type Label = Readonly<Record<Locale, string>>;
type SizeChartField = Readonly<{ key: string; label: Label }>;

const pantsFields: readonly SizeChartField[] = [
  { key: "length", label: { ko: "총장", en: "Length" } },
  { key: "waist", label: { ko: "허리단면", en: "Waist width" } },
  { key: "hip", label: { ko: "엉덩이단면", en: "Hip width" } },
  { key: "thigh", label: { ko: "허벅지단면", en: "Thigh width" } },
  { key: "rise", label: { ko: "밑위", en: "Rise" } },
  { key: "hem", label: { ko: "밑단단면", en: "Leg opening" } },
];

/** 도면 종류별 이름·단위·항목. 항목 순서는 도면 이미지의 번호 순서입니다(괄호는 원본 이미지 번호). */
export const SIZE_CHART_KIND_INFO: Readonly<
  Record<
    SizeChartKind,
    Readonly<{ label: Label; unit: SizeChartUnit; fields: readonly SizeChartField[] }>
  >
> = {
  // (57)
  shortSleeve: {
    label: { ko: "반팔", en: "Short sleeve" },
    unit: "cm",
    fields: [
      { key: "length", label: { ko: "총장", en: "Length" } },
      { key: "shoulder", label: { ko: "어깨너비", en: "Shoulder width" } },
      { key: "chest", label: { ko: "가슴단면", en: "Chest width" } },
      { key: "sleeveLength", label: { ko: "소매길이", en: "Sleeve length" } },
      { key: "hem", label: { ko: "밑단단면", en: "Hem width" } },
      { key: "sleeveWidth", label: { ko: "소매통", en: "Sleeve width" } },
      { key: "armhole", label: { ko: "암홀", en: "Armhole" } },
    ],
  },
  // (55)
  raglanLongSleeve: {
    label: { ko: "래글런 긴팔", en: "Raglan long sleeve" },
    unit: "cm",
    fields: [
      { key: "length", label: { ko: "총장", en: "Length" } },
      { key: "chest", label: { ko: "가슴단면", en: "Chest width" } },
      { key: "cuff", label: { ko: "소매부리", en: "Cuff width" } },
      { key: "neckToCuff", label: { ko: "화장", en: "Sleeve length from neck" } },
      { key: "hem", label: { ko: "밑단단면", en: "Hem width" } },
      { key: "armhole", label: { ko: "암홀", en: "Armhole" } },
    ],
  },
  // (56)
  longPants: {
    label: { ko: "긴바지", en: "Long pants" },
    unit: "cm",
    fields: pantsFields,
  },
  // (54)
  shorts: { label: { ko: "반바지", en: "Shorts" }, unit: "cm", fields: pantsFields },
  // (58)
  wheel: {
    label: { ko: "휠", en: "Wheel" },
    unit: "mm",
    fields: [
      { key: "diameter", label: { ko: "지름", en: "Diameter" } },
      { key: "width", label: { ko: "W 전체 폭", en: "W overall width" } },
      { key: "contactWidth", label: { ko: "T 바닥 닿는 폭", en: "T contact width" } },
    ],
  },
};

/** 카테고리별로 고를 수 있는 도면 종류. 첫 번째가 기본값입니다. Deck은 기존 deckSpec을 씁니다. */
const CATEGORY_KINDS: Readonly<Record<string, readonly SizeChartKind[]>> = {
  Top: ["shortSleeve", "raglanLongSleeve"],
  Outerwear: ["raglanLongSleeve", "shortSleeve"],
  Bottom: ["longPants", "shorts"],
  Wheels: ["wheel"],
};

const MAX_VALUE: Readonly<Record<SizeChartUnit, number>> = { cm: 300, mm: 100 };

export function sizeChartKindsFor(category: string): readonly SizeChartKind[] {
  return Object.hasOwn(CATEGORY_KINDS, category) ? CATEGORY_KINDS[category] : [];
}

export function defaultSizeChartKind(category: string): SizeChartKind | null {
  return sizeChartKindsFor(category)[0] ?? null;
}

export function isSizeChartKind(value: unknown): value is SizeChartKind {
  return SIZE_CHART_KINDS.includes(value as SizeChartKind);
}

function inRange(kind: SizeChartKind, value: number) {
  return value > 0 && value <= MAX_VALUE[SIZE_CHART_KIND_INFO[kind].unit];
}

/** 0 초과 최댓값(cm 300·mm 100) 이하, 소수 1자리까지의 입력만 숫자로 바꿉니다. */
export function parseSizeChartValue(kind: SizeChartKind, value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d)?$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return inRange(kind, number) ? number : null;
}

/**
 * 저장할 값을 만듭니다. 빈 칸은 null이고, 잘못된 칸이 하나라도 있거나 숫자가 하나도 없으면 null입니다.
 * 모든 칸이 빈 저장은 값이 아니라 삭제 요청으로 보내므로, 그 판단은 호출하는 쪽이 합니다.
 */
export function parseSizeChartInputs(
  kind: SizeChartKind,
  inputs: Readonly<Record<string, string>>,
): SizeChartValues | null {
  const values: SizeChartValues = {};
  let filled = false;
  for (const { key } of SIZE_CHART_KIND_INFO[kind].fields) {
    const input = Object.hasOwn(inputs, key) ? inputs[key].trim() : "";
    if (!input) {
      values[key] = null;
      continue;
    }
    const value = parseSizeChartValue(kind, input);
    if (value === null) return null;
    values[key] = value;
    filled = true;
  }
  return filled ? values : null;
}

/**
 * 서버 응답 검증용: 그 도면 종류의 항목 key만 빠짐없이 있고, 값은 범위·소수 1자리 안의 숫자 또는
 * null(비운 칸)이며, 숫자가 하나 이상일 때만 참입니다.
 */
export function isSizeChartValues(
  kind: SizeChartKind,
  value: unknown,
): value is SizeChartValues {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = SIZE_CHART_KIND_INFO[kind].fields.map((field) => field.key);
  const record = value as Record<string, unknown>;
  const isValue = (number: unknown) =>
    typeof number === "number" &&
    Number.isFinite(number) &&
    Math.round(number * 10) / 10 === number &&
    inRange(kind, number);
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => record[key] === null || isValue(record[key])) &&
    keys.some((key) => record[key] !== null)
  );
}

/** 의류는 cm 옆에 인치(÷2.54, 소수 1자리)를 괄호로, 휠은 mm만 표시합니다. 비운 칸은 단위 없이 "null"입니다. */
export function formatSizeChartValue(kind: SizeChartKind, value: number | null) {
  if (value === null) return "null";
  if (SIZE_CHART_KIND_INFO[kind].unit === "mm") return `${value}mm`;
  return `${value}cm (${(Math.round((value / 2.54) * 10) / 10).toFixed(1)}")`;
}
