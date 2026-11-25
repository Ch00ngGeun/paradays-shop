import type {
  AdminCatalogListItem,
  AdminMember,
  AdminOverviewMetrics,
} from "@/lib/admin-ui/types";
import {
  SIZE_CHART_KIND_INFO,
  isSizeChartKind,
  isSizeChartValues,
  type SizeChartKind,
  type SizeChartValues,
} from "@/lib/size-chart";
import type { DeckSpec } from "@/types/store";
import { AdminApiResponseError } from "./admin-api-client-errors";

export function parseMember(value: unknown): AdminMember {
  if (
    !isRecord(value) ||
    !isSafeText(value.username, 128) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.groups) ||
    !value.groups.every((group) => group === "admin" || group === "support") ||
    !isOptionalText(value.userSub, 128) ||
    !isOptionalText(value.email, 320) ||
    !isOptionalText(value.displayName, 160)
  ) {
    throw new AdminApiResponseError();
  }

  return {
    username: value.username,
    ...(typeof value.userSub === "string" ? { userSub: value.userSub } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.displayName === "string"
      ? { displayName: value.displayName }
      : {}),
    enabled: value.enabled,
    groups: value.groups,
  };
}

export function parseCatalogListItem(value: unknown): AdminCatalogListItem {
  if (
    !isRecord(value) ||
    !isSafeText(value.productId, 96) ||
    !isSafeText(value.name, 160) ||
    !isSafeText(value.brandName, 100) ||
    !isSafeText(value.category, 80) ||
    typeof value.price !== "number" ||
    !Number.isSafeInteger(value.price) ||
    value.price < 0 ||
    value.price > 100_000_000 ||
    typeof value.inventoryQuantity !== "number" ||
    !Number.isSafeInteger(value.inventoryQuantity) ||
    value.inventoryQuantity < 0 ||
    value.inventoryQuantity > 1_000_000 ||
    (value.status !== "DRAFT" && value.status !== "PUBLISHED") ||
    typeof value.featured !== "boolean" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Array.isArray(value.description) ||
    !value.description.every(
      (line) => typeof line === "string" && line.length <= 500,
    ) ||
    !Array.isArray(value.sizes) ||
    !value.sizes.every((size) => typeof size === "string" && size.length <= 80) ||
    (value.sku !== undefined && !isSafeText(value.sku, 80)) ||
    (value.image !== undefined && typeof value.image !== "string") ||
    (value.compareAtPrice !== undefined &&
      (typeof value.compareAtPrice !== "number" ||
        !Number.isSafeInteger(value.compareAtPrice)))
  ) {
    throw new AdminApiResponseError();
  }

  const nameI18n =
    isRecord(value.nameI18n) &&
    typeof value.nameI18n.en === "string" &&
    typeof value.nameI18n.ko === "string"
      ? { en: value.nameI18n.en, ko: value.nameI18n.ko }
      : undefined;
  const descriptionI18n =
    isRecord(value.descriptionI18n) &&
    Array.isArray(value.descriptionI18n.en) &&
    Array.isArray(value.descriptionI18n.ko)
      ? {
          en: value.descriptionI18n.en.filter(
            (line): line is string => typeof line === "string",
          ),
          ko: value.descriptionI18n.ko.filter(
            (line): line is string => typeof line === "string",
          ),
        }
      : undefined;

  return {
    id: value.productId,
    name: value.name,
    brand: value.brandName,
    category: value.category,
    price: value.price,
    stock: value.inventoryQuantity,
    isVisible: value.status === "PUBLISHED",
    version: value.version,
    ...(typeof value.sku === "string" ? { sku: value.sku } : {}),
    ...(typeof value.image === "string" ? { imageUrl: value.image } : {}),
    ...(typeof value.compareAtPrice === "number"
      ? { compareAtPrice: value.compareAtPrice }
      : {}),
    sizes: value.sizes.join(", "),
    description: value.description.join("\n"),
    isFeatured: value.featured,
    ...(nameI18n ? { nameI18n } : {}),
    ...(descriptionI18n ? { descriptionI18n } : {}),
    ...(isDeckSpec(value.deckSpec) ? { deckSpec: copyDeckSpec(value.deckSpec) } : {}),
    ...parseDeckSpecsBySize(value.deckSpecsBySize),
    ...parseSizeCharts(value),
  };
}

/** 의류·휠 상세사이즈는 도면 종류의 항목에 맞는 값만 남기고, 없으면 필드를 생략합니다. */
function parseSizeCharts(value: Record<string, unknown>) {
  const chart = value.sizeChart;
  const sizeChart =
    isRecord(chart) &&
    isSizeChartKind(chart.kind) &&
    isSizeChartValues(chart.kind, chart.values)
      ? { kind: chart.kind, values: copySizeChartValues(chart.kind, chart.values) }
      : undefined;
  // Like the server, a default value's drawing comes first.
  const kind =
    sizeChart?.kind ??
    (isSizeChartKind(value.sizeChartKind) ? value.sizeChartKind : undefined);
  const entries =
    kind && isRecord(value.sizeChartsBySize)
      ? Object.entries(value.sizeChartsBySize).flatMap(([size, values]) =>
          isSizeChartValues(kind, values)
            ? [[size, copySizeChartValues(kind, values)] as const]
            : [],
        )
      : [];
  return {
    ...(sizeChart ? { sizeChart } : {}),
    ...(kind ? { sizeChartKind: kind } : {}),
    ...(entries.length ? { sizeChartsBySize: Object.fromEntries(entries) } : {}),
  };
}

export function copySizeChartValues(kind: SizeChartKind, values: SizeChartValues) {
  return Object.fromEntries(
    SIZE_CHART_KIND_INFO[kind].fields.map(({ key }) => [key, values[key]]),
  );
}

/** 키 순서와 상관없이 같은 항목·값인지 봅니다. */
export function sameSizeChartValues(saved: unknown, sent: SizeChartValues) {
  return (
    isRecord(saved) &&
    Object.keys(saved).length === Object.keys(sent).length &&
    Object.entries(sent).every(
      ([key, value]) => Object.hasOwn(saved, key) && saved[key] === value,
    )
  );
}

/** 서버의 새 옵션 이름 규칙과 같습니다. 다른 옵션과의 중복은 서버가 저장된 목록으로 확인합니다. */
export function isNewOptionName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 50 &&
    name === name.trim() &&
    !/[,\r\n]/.test(name) &&
    !["__proto__", "constructor", "prototype"].includes(name)
  );
}

export function copyDeckSpec(spec: DeckSpec): DeckSpec {
  return {
    nose: spec.nose,
    tail: spec.tail,
    width: spec.width,
    length: spec.length,
    wheelbase: spec.wheelbase,
  };
}

/** 옵션별 상세사이즈는 올바른 항목만 남기고, 남은 항목이 없으면 필드를 생략합니다. */
function parseDeckSpecsBySize(value: unknown) {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value).flatMap(([size, spec]) =>
    isDeckSpec(spec) ? [[size, copyDeckSpec(spec)] as const] : [],
  );
  return entries.length ? { deckSpecsBySize: Object.fromEntries(entries) } : {};
}

const DECK_SPEC_FIELDS = ["nose", "tail", "width", "length", "wheelbase"] as const;
// Same as the server: up to 4 decimals (1/16" = 0.0625).
const DECK_SPEC_INCHES_PATTERN = /^\d+(?:\.\d{1,4})?$/;

/**
 * 서버 검증과 같게: 5칸이 모두 있고, 각 칸은 0 초과 100인치 이하·소수 4자리까지이거나 비운 칸(null)이며,
 * 숫자가 하나 이상일 때만 상세사이즈로 인정합니다. 모든 칸 null은 삭제(null)로 보냅니다.
 */
export function isDeckSpec(value: unknown): value is DeckSpec {
  const isInches = (inches: unknown) =>
    typeof inches === "number" &&
    Number.isFinite(inches) &&
    inches > 0 &&
    inches <= 100 &&
    DECK_SPEC_INCHES_PATTERN.test(String(inches));
  return (
    isRecord(value) &&
    DECK_SPEC_FIELDS.every(
      (field) =>
        Object.hasOwn(value, field) &&
        (value[field] === null || isInches(value[field])),
    ) &&
    DECK_SPEC_FIELDS.some((field) => value[field] !== null)
  );
}

export function parseOverviewMetrics(value: unknown): AdminOverviewMetrics {
  if (
    !isRecord(value) ||
    typeof value.asOf !== "string" ||
    typeof value.timezone !== "string" ||
    !isSafeCount(value.todayOrderCount) ||
    !isSafeCount(value.lowStockCount) ||
    !isSafeCount(value.lowStockThreshold) ||
    !isSafeCount(value.activeCouponCount) ||
    !isSafeCount(value.marketingConsentCount)
  ) {
    throw new AdminApiResponseError();
  }

  const todayPaidRevenue = parseOptionalSafeCount(value, "todayPaidRevenue");
  const todaySoldItemCount = parseOptionalSafeCount(value, "todaySoldItemCount");
  const todayNewMemberCount = parseOptionalSafeCount(value, "todayNewMemberCount");

  return {
    asOf: value.asOf,
    timezone: value.timezone,
    todayOrderCount: value.todayOrderCount,
    ...(todayPaidRevenue === undefined ? {} : { todayPaidRevenue }),
    ...(todaySoldItemCount === undefined ? {} : { todaySoldItemCount }),
    ...(todayNewMemberCount === undefined ? {} : { todayNewMemberCount }),
    lowStockCount: value.lowStockCount,
    lowStockThreshold: value.lowStockThreshold,
    activeCouponCount: value.activeCouponCount,
    marketingConsentCount: value.marketingConsentCount,
  };
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 새 집계가 없는 구형 응답은 허용하되, 제공한 숫자는 엄격히 검증함. */
function parseOptionalSafeCount(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    return undefined;
  }

  const candidate = value[field];

  if (!isSafeCount(candidate)) {
    throw new AdminApiResponseError();
  }

  return candidate;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSafeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" && Boolean(value.trim()) && value.length <= maximumLength
  );
}

function isOptionalText(value: unknown, maximumLength: number) {
  return value === undefined || isSafeText(value, maximumLength);
}
